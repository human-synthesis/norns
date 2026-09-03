import { describe, expect, test } from 'bun:test';

import { compile } from '@danielx/civet';

import { UNIT_SCHEMAS, schemaIssues } from '../src/kernel/meta.js';
import { refineSpecs } from '../src/kernel/refine.js';
import { checkGenerate } from '../src/kernel/generate.js';
import { emitModuleActions, emitModuleServices } from '../src/kernel/emit-units.js';
import { serviceClient, ServiceError } from '../src/server/service.js';
import { boot } from '../src/server/boot.js';

const compiles = (file) => compile(file.text, { sync: true, js: true });

const MAILER = {
	base: 'https://api.mailer.example',
	auth: { mode: 'bearer', binding: 'MAILER_TOKEN' },
	operations: {
		send: { input: { to: 'email', subject: 'text' }, output: { id: 'text' } },
		status: { method: 'GET', path: '/status/{id}', input: { id: 'text' } }
	}
};

const CRM = {
	module: 'crm',
	services: { mailer: structuredClone(MAILER) },
	actions: {
		notify: {
			steps: [{ call: 'crm.Service.mailer.send', with: { to: 'input.to', subject: 'Hi' } }]
		}
	}
};

const specsOf = (modules) => ({ app: {}, modules });

describe('Service meta-schema', () => {
	test('a valid service passes', () => {
		expect(schemaIssues(UNIT_SCHEMAS.Service, MAILER, 'crm.Service.mailer')).toEqual([]);
	});

	test('binding must be an UPPER_SNAKE name, not a value', () => {
		const svc = structuredClone(MAILER);
		svc.auth.binding = 'sk_live_abc123';
		const issues = schemaIssues(UNIT_SCHEMAS.Service, svc, 'crm.Service.mailer');
		expect(issues.some((i) => i.message.includes('UPPER_SNAKE'))).toBe(true);
	});

	test("mode 'none' must not carry a binding; other modes require one", () => {
		const none = structuredClone(MAILER);
		none.auth = { mode: 'none', binding: 'X_TOKEN' };
		expect(schemaIssues(UNIT_SCHEMAS.Service, none, 'a').length).toBeGreaterThan(0);
		const bare = structuredClone(MAILER);
		bare.auth = { mode: 'bearer' };
		expect(schemaIssues(UNIT_SCHEMAS.Service, bare, 'a').length).toBeGreaterThan(0);
	});

	test("mode 'header' requires a header name", () => {
		const svc = structuredClone(MAILER);
		svc.auth = { mode: 'header', binding: 'API_KEY' };
		expect(schemaIssues(UNIT_SCHEMAS.Service, svc, 'a').length).toBeGreaterThan(0);
		svc.auth.header = 'X-Api-Key';
		expect(schemaIssues(UNIT_SCHEMAS.Service, svc, 'a')).toEqual([]);
	});

	test('services require at least one operation', () => {
		const svc = structuredClone(MAILER);
		svc.operations = {};
		const issues = schemaIssues(UNIT_SCHEMAS.Service, svc, 'a');
		expect(issues.some((i) => i.message.includes('at least one operation'))).toBe(true);
	});

	test('base must be an absolute URL', () => {
		const svc = structuredClone(MAILER);
		svc.base = 'api.mailer.example';
		expect(schemaIssues(UNIT_SCHEMAS.Service, svc, 'a').length).toBeGreaterThan(0);
	});
});

describe('refine: service call steps', () => {
	test('a resolvable operation produces no issues', () => {
		expect(refineSpecs(specsOf({ crm: structuredClone(CRM) }))).toEqual([]);
	});

	test('unknown operation is an error', () => {
		const crm = structuredClone(CRM);
		crm.actions.notify.steps[0].call = 'crm.Service.mailer.nope';
		const issues = refineSpecs(specsOf({ crm }));
		expect(issues.some((i) => i.message.includes('no operation "nope"'))).toBe(true);
	});

	test('unknown service is an error', () => {
		const crm = structuredClone(CRM);
		crm.actions.notify.steps[0].call = 'crm.Service.ghost.send';
		const issues = refineSpecs(specsOf({ crm }));
		expect(issues.some((i) => i.message.includes('no crm.Service.ghost'))).toBe(true);
	});

	test('calls into unloaded modules error unless declared in depends', () => {
		const crm = structuredClone(CRM);
		crm.actions.notify.steps[0].call = 'core.Service.x.y';
		expect(refineSpecs(specsOf({ crm })).some((i) => i.message.includes('unknown module'))).toBe(
			true
		);
		crm.depends = ['core'];
		expect(refineSpecs(specsOf({ crm }))).toEqual([]);
	});

	test('non-service container-token calls are left alone', () => {
		const crm = structuredClone(CRM);
		crm.actions.notify.steps[0] = { call: 'billing.charge' };
		expect(refineSpecs(specsOf({ crm }))).toEqual([]);
	});
});

describe('service literals (D83)', () => {
	// The secret scan is gone: what a service unit holds is the author's call.
	test('a token-shaped literal in a service is not refused', () => {
		const svc = structuredClone(MAILER);
		svc.operations.send.path = '/send?token=sk_live_ABCdefGH12345678';
		const crm = { module: 'crm', services: { mailer: svc } };
		expect(checkGenerate(specsOf({ crm })).filter((r) => r.code === 'SECRET_IN_SPEC')).toEqual([]);
	});
});

describe('emitModuleServices', () => {
	const file = emitModuleServices('crm', CRM);

	test('emits a typed client per service plus the address map', () => {
		expect(file.path).toBe('lib/crm/services.c');
		expect(file.text).toContain(`import { serviceClient } from '@human-synthesis/norns/server'`);
		expect(file.text).toContain('export mailer := serviceClient(');
		expect(file.text).toContain('"crm.Service.mailer": mailer');
		expect(compiles(file)).toContain('export const mailer');
	});

	test('operations get method/path defaults', () => {
		expect(file.text).toContain('"method": "POST"');
		expect(file.text).toContain('"path": "/send"');
		expect(file.text).toContain('"path": "/status/{id}"');
	});

	test('modules without services emit nothing', () => {
		expect(emitModuleServices('crm', { module: 'crm' })).toBeNull();
	});
});

describe('emitModuleActions: service call steps', () => {
	test('service calls import the client and map `with` (paths raw, literals quoted)', () => {
		const file = emitModuleActions('crm', CRM, specsOf({ crm: CRM }));
		expect(file.text).toContain(`import { mailer } from './services.c'`);
		expect(file.text).toContain('await mailer.send({ subject: "Hi", to: input.to }, container)');
		compiles(file);
	});

	test('cross-module service calls import from the owning module', () => {
		const sales = {
			module: 'sales',
			depends: ['crm'],
			actions: { ping: { steps: [{ call: 'crm.Service.mailer.send' }] } }
		};
		const file = emitModuleActions('sales', sales, specsOf({ crm: CRM, sales }));
		expect(file.text).toContain(`import { mailer } from '../crm/services.c'`);
		expect(file.text).toContain('await mailer.send(input, container)');
		compiles(file);
	});

	test('target-less actions still run emit/call steps', () => {
		const mod = {
			module: 'ops',
			actions: {
				poke: { steps: [{ emit: 'ops.poked' }, { call: 'billing.charge' }], emits: ['ops.done'] }
			}
		};
		const file = emitModuleActions('ops', mod, specsOf({ ops: mod }));
		expect(file.text).toContain(`emit("ops.poked", { input, user })`);
		expect(file.text).toContain(`await container.resolve("billing.charge")({ input, user })`);
		expect(file.text).toContain(`emit("ops.done", { input, user })`);
		compiles(file);
	});
});

describe('serviceClient runtime', () => {
	const def = {
		name: 'crm.Service.mailer',
		base: 'https://api.mailer.example',
		auth: { mode: 'bearer', binding: 'MAILER_TOKEN' },
		operations: {
			send: { method: 'POST', path: '/send', input: { to: 'email' } },
			status: { method: 'GET', path: '/status/{id}', input: { id: 'text' } }
		}
	};
	const env = { MAILER_TOKEN: 'tok-123' };
	const container = { has: (t) => t === 'env', resolve: () => env };
	const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

	const capture = () => {
		const calls = [];
		const fetchImpl = async (url, init) => {
			calls.push({ url, init });
			return ok({ id: 'm1' });
		};
		return { calls, fetchImpl };
	};

	test('POST sends JSON body with a bearer credential from the container env', async () => {
		const { calls, fetchImpl } = capture();
		const client = serviceClient(def, fetchImpl);
		const out = await client.send({ to: 'a@b.c' }, container);
		expect(out).toEqual({ id: 'm1' });
		expect(calls[0].url).toBe('https://api.mailer.example/send');
		expect(calls[0].init.headers.authorization).toBe('Bearer tok-123');
		expect(JSON.parse(calls[0].init.body)).toEqual({ to: 'a@b.c' });
	});

	test('GET substitutes path params and moves the rest to the query string', async () => {
		const { calls, fetchImpl } = capture();
		const client = serviceClient(def, fetchImpl);
		await client.status({ id: '42', verbose: true }, container);
		expect(calls[0].url).toBe('https://api.mailer.example/status/42?verbose=true');
		expect(calls[0].init.body).toBeUndefined();
	});

	test('hmac mode signs the body', async () => {
		const { calls, fetchImpl } = capture();
		const hmacDef = { ...def, auth: { mode: 'hmac', binding: 'MAILER_TOKEN' } };
		await serviceClient(hmacDef, fetchImpl).send({ to: 'a@b.c' }, container);
		expect(calls[0].init.headers['x-signature']).toMatch(/^[0-9a-f]{64}$/);
	});

	test('a missing env binding throws by name', async () => {
		const empty = { has: (t) => t === 'env', resolve: () => ({}) };
		const client = serviceClient(def, capture().fetchImpl);
		await expect(client.send({ to: 'a@b.c' }, empty)).rejects.toThrow('MAILER_TOKEN');
	});

	test('missing required input throws before any request', async () => {
		const { calls, fetchImpl } = capture();
		const client = serviceClient(def, fetchImpl);
		await expect(client.send({}, container)).rejects.toThrow('missing input "to"');
		expect(calls.length).toBe(0);
	});

	test('a wrongly typed input throws before any request', async () => {
		const { calls, fetchImpl } = capture();
		const typedDef = {
			...def,
			operations: { send: { method: 'POST', path: '/send', input: { to: 'email', count: 'int' } } }
		};
		const client = serviceClient(typedDef, fetchImpl);
		await expect(client.send({ to: 'a@b.c', count: 'three' }, container)).rejects.toThrow(
			'input "count": expected int'
		);
		expect(calls.length).toBe(0);
	});

	test('a response violating the declared output contract becomes a ServiceError', async () => {
		const outDef = {
			...def,
			operations: { send: { method: 'POST', path: '/send', input: { to: 'email' }, output: { id: 'text' } } }
		};
		const fetchImpl = async () => ok({ ok: true });
		const client = serviceClient(outDef, fetchImpl);
		const err = await client.send({ to: 'a@b.c' }, container).catch((e) => e);
		expect(err).toBeInstanceOf(ServiceError);
		expect(err.body.contract).toEqual(['missing output "id"']);
		expect(err.body.data).toEqual({ ok: true });
	});

	test('boot registers service tables under their unit addresses', async () => {
		const client = serviceClient(def, capture().fetchImpl);
		const app = await boot({ services: [{ 'crm.Service.mailer': client }] });
		expect(app.container.resolve('crm.Service.mailer')).toBe(client);
	});

	test('non-2xx responses become a structured ServiceError', async () => {
		const fetchImpl = async () => new Response(JSON.stringify({ error: 'nope' }), { status: 422 });
		const client = serviceClient(def, fetchImpl);
		const err = await client.send({ to: 'a@b.c' }, container).catch((e) => e);
		expect(err).toBeInstanceOf(ServiceError);
		expect(err.status).toBe(422);
		expect(err.body).toEqual({ error: 'nope' });
		expect(err.service).toBe('crm.Service.mailer');
		expect(err.operation).toBe('send');
	});
});
