import { describe, expect, test } from 'bun:test';

import { compile } from '@danielx/civet';

import { UNIT_SCHEMAS, schemaIssues } from '../src/kernel/meta.js';
import { refineSpecs } from '../src/kernel/refine.js';
import { checkGenerate } from '../src/kernel/generate.js';
import { emitModuleEndpoints } from '../src/kernel/emit-units.js';
import { endpoint } from '../src/server/endpoint.js';
import { hmacHex } from '../src/server/service.js';

const compiles = (file) => compile(file.text, { sync: true, js: true });

const WEBHOOK = {
	route: '/api/hooks/stripe',
	method: 'POST',
	auth: { mode: 'hmac', binding: 'STRIPE_SECRET' },
	input: { event: 'text' },
	output: { ok: 'bool' },
	impl: 'custom',
	examples: [{ input: { event: 'checkout.completed' }, expect: { ok: true } }]
};

const CHAT = {
	route: '/api/chat',
	method: 'POST',
	auth: { mode: 'bearer', binding: 'CHAT_TOKEN' },
	input: { prompt: 'text' },
	stream: { frame: { delta: 'text' } }
};

const specsOf = (modules) => ({ app: {}, modules });

describe('Endpoint meta-schema', () => {
	test('a valid endpoint passes', () => {
		expect(schemaIssues(UNIT_SCHEMAS.Endpoint, WEBHOOK, 'deals.Endpoint.webhookStripe')).toEqual([]);
		expect(schemaIssues(UNIT_SCHEMAS.Endpoint, CHAT, 'games.Endpoint.chat')).toEqual([]);
	});

	test('route must start with a slash', () => {
		const ep = structuredClone(WEBHOOK);
		ep.route = 'api/hooks/stripe';
		expect(schemaIssues(UNIT_SCHEMAS.Endpoint, ep, 'a').length).toBeGreaterThan(0);
	});

	test('auth is required — public endpoints declare mode none explicitly', () => {
		const ep = structuredClone(WEBHOOK);
		delete ep.auth;
		expect(schemaIssues(UNIT_SCHEMAS.Endpoint, ep, 'a').length).toBeGreaterThan(0);
		ep.auth = { mode: 'none' };
		expect(schemaIssues(UNIT_SCHEMAS.Endpoint, ep, 'a')).toEqual([]);
	});

	test('output and stream are mutually exclusive', () => {
		const ep = structuredClone(WEBHOOK);
		ep.stream = { frame: { delta: 'text' } };
		const issues = schemaIssues(UNIT_SCHEMAS.Endpoint, ep, 'a');
		expect(issues.some((i) => i.message.includes('not both'))).toBe(true);
	});

	test('stream frames need at least one field', () => {
		const ep = structuredClone(CHAT);
		ep.stream = { frame: {} };
		expect(schemaIssues(UNIT_SCHEMAS.Endpoint, ep, 'a').length).toBeGreaterThan(0);
	});

	test('impl custom requires examples', () => {
		const ep = structuredClone(WEBHOOK);
		delete ep.examples;
		const issues = schemaIssues(UNIT_SCHEMAS.Endpoint, ep, 'a');
		expect(issues.some((i) => i.message.includes('at least one example'))).toBe(true);
	});
});

describe('legacy Route deprecation', () => {
	test('a schema-less Route warns toward Endpoint', () => {
		const issues = refineSpecs(
			specsOf({ ops: { module: 'ops', routes: { legacy: { source: 'src/ops/routes/legacy.c', auth: 'user' } } } })
		);
		const warning = issues.find((i) => i.level === 'warning');
		expect(warning?.address).toBe('ops.Route.legacy');
		expect(warning?.message).toContain('Endpoint');
	});
});

describe('endpoint secrets guard', () => {
	test('a literal secret in an endpoint is a SECRET_IN_SPEC refusal', () => {
		const ep = structuredClone(WEBHOOK);
		// Stripe's public docs example key, split so secret scanners don't flag the fixture.
		ep.examples = [{ input: { key: 'sk_live_' + '4eC39HqLyjWDarjtT1zdp7dc' }, expect: { ok: true } }];
		const refusals = checkGenerate(specsOf({ deals: { module: 'deals', endpoints: { webhookStripe: ep } } }));
		expect(refusals.some((r) => r.code === 'SECRET_IN_SPEC')).toBe(true);
	});

	test('binding names alone are clean', () => {
		const refusals = checkGenerate(
			specsOf({ deals: { module: 'deals', endpoints: { webhookStripe: structuredClone(WEBHOOK) } } })
		);
		expect(refusals).toEqual([]);
	});
});

describe('emitModuleEndpoints', () => {
	test('an endpoint becomes a +server.c shell at its declared route', () => {
		const files = emitModuleEndpoints('deals', { endpoints: { webhookStripe: structuredClone(WEBHOOK) } });
		expect(files.length).toBe(1);
		const file = files[0];
		expect(file.path).toBe('routes/api/hooks/stripe/+server.c');
		expect(file.text).toContain(`import { endpoint } from '@human-synthesis/norns/server'`);
		expect(file.text).toContain(`import webhookStripeBody from '$custom/deals/endpoints/webhookStripe.c'`);
		expect(file.text).toContain('export POST := endpoint(');
		expect(file.text).toContain('"name": "deals.Endpoint.webhookStripe"');
		expect(file.text).toContain('body: webhookStripeBody');
		compiles(file);
	});

	test('stream endpoints carry the frame contract; method defaults to POST', () => {
		const chat = structuredClone(CHAT);
		delete chat.method;
		const [file] = emitModuleEndpoints('games', { endpoints: { chat } });
		expect(file.path).toBe('routes/api/chat/+server.c');
		expect(file.text).toContain('export POST := endpoint(');
		expect(file.text).toContain('"stream"');
		expect(file.text).toContain('"delta": "text"');
		compiles(file);
	});

	test('no endpoints emits nothing', () => {
		expect(emitModuleEndpoints('deals', {})).toBeNull();
	});
});

describe('endpoint runtime', () => {
	const env = { HOOK_TOKEN: 'tok-9', STRIPE_SECRET: 'whsec-1' };
	const container = { has: (t) => t === 'env', resolve: () => env };

	const makeEvent = (method, path, body, headers = {}) => {
		const url = new URL(`http://localhost${path}`);
		const init = { method, headers };
		if (body !== undefined) init.body = JSON.stringify(body);
		return {
			request: new Request(url, init),
			url,
			locals: { container, user: { id: 'u1' } }
		};
	};

	const def = {
		name: 'deals.Endpoint.webhookStripe',
		auth: { mode: 'bearer', binding: 'HOOK_TOKEN' },
		input: { event: 'text' },
		output: { ok: 'bool' },
		body: async ({ input }) => ({ ok: input.event === 'checkout.completed' })
	};

	test('auth verifies before anything else — bad bearer is 401', async () => {
		const handler = endpoint(def);
		await expect(
			handler(makeEvent('POST', '/api/hooks/stripe', { event: 'x' }, { authorization: 'Bearer wrong' }))
		).rejects.toMatchObject({ status: 401 });
	});

	test('input validates after auth — 400 with issues', async () => {
		const handler = endpoint(def);
		await expect(
			handler(makeEvent('POST', '/api/hooks/stripe', {}, { authorization: 'Bearer tok-9' }))
		).rejects.toMatchObject({ status: 400 });
	});

	test('the golden path returns validated JSON', async () => {
		const handler = endpoint(def);
		const res = await handler(
			makeEvent('POST', '/api/hooks/stripe', { event: 'checkout.completed' }, { authorization: 'Bearer tok-9' })
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	test('an output contract violation is a 500', async () => {
		const handler = endpoint({ ...def, body: async () => ({ nope: 1 }) });
		await expect(
			handler(makeEvent('POST', '/api/hooks/stripe', { event: 'x' }, { authorization: 'Bearer tok-9' }))
		).rejects.toMatchObject({ status: 500 });
	});

	test('hmac mode verifies the body signature', async () => {
		const hmacDef = { ...def, auth: { mode: 'hmac', binding: 'STRIPE_SECRET' } };
		const handler = endpoint(hmacDef);
		const payload = { event: 'checkout.completed' };
		const sig = await hmacHex('whsec-1', JSON.stringify(payload));
		const res = await handler(makeEvent('POST', '/api/hooks/stripe', payload, { 'x-signature': sig }));
		expect(res.status).toBe(200);
		await expect(
			handler(makeEvent('POST', '/api/hooks/stripe', payload, { 'x-signature': 'bad' }))
		).rejects.toMatchObject({ status: 401 });
	});

	test('GET input comes from the query string with type coercion', async () => {
		let seen;
		const getDef = {
			name: 'ops.Endpoint.ping',
			auth: { mode: 'none' },
			input: { n: 'int', deep: 'bool' },
			body: async ({ input }) => {
				seen = input;
				return null;
			}
		};
		const res = await endpoint(getDef)(makeEvent('GET', '/api/ping?n=3&deep=true'));
		expect(res.status).toBe(200);
		expect(seen).toEqual({ n: 3, deep: true });
	});

	test('stream mode serves yielded frames as SSE and closes with done', async () => {
		const streamDef = {
			name: 'games.Endpoint.chat',
			auth: { mode: 'none' },
			input: { prompt: 'text' },
			stream: { frame: { delta: 'text' } },
			body: async function* ({ input }) {
				yield { delta: input.prompt[0] };
				yield { delta: input.prompt[1] };
			}
		};
		const res = await endpoint(streamDef)(makeEvent('POST', '/api/chat', { prompt: 'hi' }));
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		const text = await res.text();
		expect(text).toContain('data: {"delta":"h"}');
		expect(text).toContain('data: {"delta":"i"}');
		expect(text).toContain('event: done');
	});

	test('a frame violating the declared shape turns into an SSE error event', async () => {
		const streamDef = {
			name: 'games.Endpoint.chat',
			auth: { mode: 'none' },
			stream: { frame: { delta: 'text' } },
			body: async function* () {
				yield { delta: 'ok' };
				yield { wrong: 1 };
			}
		};
		const res = await endpoint(streamDef)(makeEvent('POST', '/api/chat', {}));
		const text = await res.text();
		expect(text).toContain('data: {"delta":"ok"}');
		expect(text).toContain('event: error');
		expect(text).toContain('missing frame');
	});
});
