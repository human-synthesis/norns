import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkGenerate, checkNetworkInBodies } from '../src/kernel/generate.js';

const cleanup = [];
afterAll(() => cleanup.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function appDir(bodies) {
	const root = mkdtempSync(join(tmpdir(), 'norns-guardrails-'));
	cleanup.push(root);
	mkdirSync(join(root, 'specs'), { recursive: true });
	for (const [rel, text] of Object.entries(bodies)) {
		mkdirSync(join(root, ...rel.split('/').slice(0, -1)), { recursive: true });
		writeFileSync(join(root, ...rel.split('/')), text);
	}
	return root;
}

const CRM = {
	endpoints: {
		webhook: {
			route: '/api/hooks/pay',
			auth: { mode: 'none' },
			output: { ok: 'bool' },
			impl: 'custom',
			examples: [{ input: {}, expect: { ok: true } }]
		}
	},
	functions: {
		slugify: { input: { title: 'text' } }
	},
	workers: {
		matchRoom: { room: true, source: 'src/crm/workers/matchRoom.c', auth: 'internal' }
	}
};

const specsFor = (root) => ({ dir: join(root, 'specs'), modules: { crm: CRM } });

describe('network-in-body lint (X-07)', () => {
	test('a custom body calling global fetch() is refused with UNDECLARED_NETWORK', () => {
		const root = appDir({
			'src/crm/endpoints/webhook.c': `export default async ({ input }) => {
	const res = await fetch('https://api.stripe.com/v1/charges')
	return { ok: res.ok }
}
`
		});
		const refusals = checkNetworkInBodies(specsFor(root));
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toMatchObject({
			address: 'crm.Endpoint.webhook',
			code: 'UNDECLARED_NETWORK',
			path: 'src/crm/endpoints/webhook.c:2'
		});
		expect(refusals[0].fix).toContain('Service');
	});

	test('method fetch (DO stubs) and service-client bodies pass', () => {
		const root = appDir({
			'src/crm/endpoints/webhook.c': `export default async ({ container }) => {
	const stub = container.resolve('crm.Worker.matchRoom')
	await stub.fetch(new Request('https://do/ws'))
	const mailer = container.resolve('crm.Service.mailer')
	await mailer.send({ to: 'a@b.c' })
	return { ok: true }
}
`,
			'src/crm/workers/matchRoom.c': `export default class MatchRoom {
	prefetch() {}
	refetch(x) { return this.prefetch(x) }
}
`
		});
		expect(checkNetworkInBodies(specsFor(root))).toEqual([]);
	});

	test('worker sources are scanned too', () => {
		const root = appDir({
			'src/crm/workers/matchRoom.c': `export default class MatchRoom {
	async poll() {
		return fetch('https://example.com/state')
	}
}
`
		});
		const refusals = checkNetworkInBodies(specsFor(root));
		expect(refusals).toHaveLength(1);
		expect(refusals[0].address).toBe('crm.Worker.matchRoom');
	});

	test('functions and custom actions/jobs are scanned; missing bodies are skipped', () => {
		const root = appDir({
			'src/crm/functions/slugify.c': `export default async () => fetch('https://x.example')
`
		});
		const refusals = checkNetworkInBodies(specsFor(root));
		expect(refusals.map((r) => r.address)).toEqual(['crm.Function.slugify']);
	});

	test('in-memory specs (no dir) are a no-op', () => {
		expect(checkNetworkInBodies({ modules: { crm: CRM } })).toEqual([]);
	});

	test('checkGenerate surfaces the lint', () => {
		const root = appDir({
			'src/crm/endpoints/webhook.c': `export default async () => ({ ok: (await fetch('https://x')).ok })
`
		});
		const refusals = checkGenerate(specsFor(root));
		expect(refusals.some((r) => r.code === 'UNDECLARED_NETWORK')).toBe(true);
	});
});
