import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSpec } from '@human-synthesis/norns-tron/spec';

import { traceApp } from '../src/kernel/trace.js';

const APP = { name: 'l3app', dialect: 'd1', modules: ['crm'] };

const CRM = {
	module: 'crm',
	services: {
		mailer: {
			base: 'https://api.mailer.example',
			auth: { mode: 'bearer', binding: 'MAILER_TOKEN' },
			operations: { send: { input: { to: 'email' }, output: { id: 'text' } } }
		}
	},
	actions: {
		notify: {
			input: { to: 'email' },
			steps: [{ call: 'crm.Service.mailer.send', with: { to: 'input.to' } }],
			examples: [
				{
					input: { to: 'a@b.c' },
					expect: { calls: [{ name: 'crm.Service.mailer.send', with: { to: 'a@b.c' } }] }
				}
			]
		}
	},
	jobs: {
		syncDeal: {
			retry: { attempts: 3, backoff: 'none' },
			steps: [{ call: 'crm.Service.mailer.send', with: { to: 'ops@example.com' } }, { emit: 'deal.synced' }],
			examples: [{ input: {}, expect: { calls: ['crm.Service.mailer.send'] } }]
		}
	},
	functions: {
		slugify: {
			input: { title: 'text' },
			examples: [{ input: { title: 'Hello World' }, expect: { slug: 'hello-world' } }]
		}
	},
	endpoints: {
		webhook: {
			route: '/api/hooks/pay',
			method: 'POST',
			auth: { mode: 'none' },
			input: { event: 'text' },
			output: { ok: 'bool' },
			impl: 'custom',
			examples: [{ input: { event: 'paid' }, expect: { ok: true } }]
		},
		chat: {
			route: '/api/chat',
			auth: { mode: 'none' },
			input: { prompt: 'text' },
			stream: { frame: { delta: 'text' } },
			impl: 'custom',
			examples: [{ input: { prompt: 'hi' }, expect: { frames: [{ delta: 'h' }, { delta: 'i' }] } }]
		}
	},
	workers: {
		matchRoom: {
			room: true,
			source: 'src/crm/workers/matchRoom.c',
			auth: 'internal',
			state: { phase: 'text' },
			messages: { join: {}, state: { out: { phase: 'text' } } },
			examples: [
				{
					script: [{ send: 'join', with: { name: 'a' } }],
					expect: { state: { phase: 'playing' }, broadcasts: ['state'] }
				}
			]
		}
	}
};

const BODIES = {
	'src/crm/functions/slugify.c': `export default async ({ input }) => ({ slug: input.title.toLowerCase().replaceAll(' ', '-') })
`,
	'src/crm/endpoints/webhook.c': `export default async ({ input }) => ({ ok: input.event === 'paid' })
`,
	'src/crm/endpoints/chat.c': `export default async function* ({ input }) {
	for (const ch of input.prompt) {
		yield { delta: ch }
	}
}
`,
	'src/crm/workers/matchRoom.c': `import { Room } from '@human-synthesis/norns/server'

export default class MatchRoom extends Room {
	phase = 'lobby'

	async onMessage(data) {
		const msg = JSON.parse(data)
		if (msg.type === 'join') {
			this.phase = 'playing'
			this.broadcast({ type: 'state', phase: this.phase })
		}
	}
}
`
};

function appDir({ crm = CRM, bodies = BODIES } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'norns-trace-l3-'));
	writeSpec(join(root, 'specs', 'app.tron'), APP);
	writeSpec(join(root, 'specs', 'crm.tron'), crm);
	for (const [rel, text] of Object.entries(bodies)) {
		mkdirSync(join(root, ...rel.split('/').slice(0, -1)), { recursive: true });
		writeFileSync(join(root, ...rel.split('/')), text);
	}
	return root;
}

const cleanup = [];
afterAll(() => cleanup.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('traceApp L3 (K-25)', () => {
	test('Action, Job, Function, Endpoint (incl. stream) and Room examples all trace green', async () => {
		const root = appDir();
		cleanup.push(root);
		const report = await traceApp(join(root, 'specs'));

		expect(report.fail).toBe(0);
		expect(report.pass).toBe(6);
		const byAddress = Object.fromEntries(report.cases.map((c) => [c.address, c]));

		// Service calls are auto-fixtured from the op's output schema — no network
		const notify = byAddress['crm.Action.notify'];
		expect(notify.calls).toEqual([{ name: 'crm.Service.mailer.send', args: [{ to: 'a@b.c' }] }]);

		const job = byAddress['crm.Job.syncDeal'];
		expect(job.pass).toBe(true);
		expect(job.events.map((e) => e.name)).toEqual(['deal.synced']);

		expect(byAddress['crm.Function.slugify'].result).toEqual({ slug: 'hello-world' });
		expect(byAddress['crm.Endpoint.webhook'].result).toEqual({ ok: true });
		expect(byAddress['crm.Endpoint.chat'].frames).toEqual([{ delta: 'h' }, { delta: 'i' }]);

		const room = byAddress['crm.Worker.matchRoom'];
		expect(room.pass).toBe(true);
		expect(room.state).toEqual({ phase: 'playing' });
		expect(room.broadcasts).toEqual([{ type: 'state', phase: 'playing' }]);
	}, 30000);

	// v6 K-46 — the report's findings 05 + 07: a body's relative sibling import
	// (`./util.c`, the documented shim pattern) was rewritten to a scratch path
	// that was never materialised, and a specifier merely mentioned inside a
	// comment recursed ensureCustom into a stack overflow.
	test('a relative sibling import is materialised; specifiers in comments are inert', async () => {
		const crm = structuredClone(CRM);
		const bodies = {
			...BODIES,
			'src/crm/functions/slugify.c':
				"// note: import { x } from '$custom/crm/functions/slugify.c' must stay inert here\n" +
				"import { dashify } from './util.c'\n" +
				'export default async ({ input }) => ({ slug: dashify(input.title) })\n',
			'src/crm/functions/util.c': "export dashify := (s) => s.toLowerCase().replaceAll(' ', '-')\n"
		};
		const root = appDir({ crm, bodies });
		cleanup.push(root);
		const report = await traceApp(join(root, 'specs'));

		const slugify = report.cases.find((c) => c.address === 'crm.Function.slugify');
		expect(slugify.pass).toBe(true);
		expect(slugify.result).toEqual({ slug: 'hello-world' });
	}, 30000);

	test('an endpoint body violating its output contract fails its case', async () => {
		const crm = structuredClone(CRM);
		const bodies = { ...BODIES, 'src/crm/endpoints/webhook.c': `export default async () => ({ nope: 1 })\n` };
		const root = appDir({ crm, bodies });
		cleanup.push(root);
		const report = await traceApp(join(root, 'specs'));

		const webhook = report.cases.find((c) => c.address === 'crm.Endpoint.webhook');
		expect(webhook.pass).toBe(false);
		expect(webhook.error).toContain('output contract');
	}, 30000);

	test('a wrong room expectation is a failing case', async () => {
		const crm = structuredClone(CRM);
		crm.workers.matchRoom.examples = [
			{ script: [{ send: 'join' }], expect: { state: { phase: 'lobby' } } }
		];
		const root = appDir({ crm });
		cleanup.push(root);
		const report = await traceApp(join(root, 'specs'));

		const room = report.cases.find((c) => c.address === 'crm.Worker.matchRoom');
		expect(room.pass).toBe(false);
		expect(room.state).toEqual({ phase: 'playing' });
	}, 30000);

	test('undeclared script messages are refused at refine time', async () => {
		const crm = structuredClone(CRM);
		crm.workers.matchRoom.examples = [{ script: [{ send: 'teleport' }] }];
		const root = appDir({ crm });
		cleanup.push(root);
		await expect(traceApp(join(root, 'specs'))).rejects.toThrow('undeclared message "teleport"');
	}, 30000);
});
