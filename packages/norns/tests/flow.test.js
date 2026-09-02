import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSpec } from '@human-synthesis/norns-tron/spec';

import { emitFlow, flowApp, flowDelta, indexBody } from '../src/kernel/flow.js';
import { loadSpecs } from '../src/kernel/validate.js';

const APP = { name: 'flowapp', dialect: 'd1', modules: ['crm'] };

const CRM = {
	module: 'crm',
	entities: {
		Deal: {
			owner: 'owner',
			fields: { owner: { type: 'ref', ref: 'core.Entity.User' }, title: { type: 'text' } },
			status: { open: ['won'], won: [] }
		}
	},
	policies: { Deal: { read: 'owner', write: 'owner' } },
	queries: { board: { from: 'Deal', limit: 50 } },
	actions: {
		win: {
			input: { id: 'Deal.id' },
			requires: 'status == open',
			steps: [{ set: { status: 'won', entity: 'Deal' } }, { emit: 'deal.won' }],
			refresh: ['board'],
			examples: [{ input: { id: '$open' }, expect: { status: 'won' } }]
		}
	},
	services: {
		mailer: {
			base: 'https://api.mailer.example',
			auth: { mode: 'bearer', binding: 'MAILER_TOKEN' },
			operations: { send: { input: { to: 'email' }, output: { id: 'text' } } }
		}
	},
	jobs: {
		syncDeal: {
			retry: { attempts: 3, backoff: 'none' },
			steps: [{ call: 'crm.Service.mailer.send', with: { to: 'ops@example.com' } }, { emit: 'deal.synced' }]
		}
	},
	endpoints: {
		webhook: {
			route: '/api/hooks/pay',
			method: 'POST',
			auth: { mode: 'hmac', binding: 'PAY_SECRET' },
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
			examples: [{ input: { prompt: 'hi' }, expect: { frames: [{ delta: 'h' }] } }]
		}
	},
	workers: {
		matchRoom: {
			room: true,
			source: 'src/crm/workers/matchRoom.c',
			auth: 'internal',
			state: { phase: 'text' },
			messages: { join: {}, state: { out: { phase: 'text' } } }
		}
	}
};

const WEBHOOK_BODY = `export default async ({ input, container }) => {
	const mailer = container.resolve('crm.Service.mailer')
	await mailer.send({ to: 'ops@example.com' })
	return { ok: input.event === 'paid' }
}
`;

function appDir() {
	const root = mkdtempSync(join(tmpdir(), 'norns-flow-'));
	writeSpec(join(root, 'specs', 'app.tron'), APP);
	writeSpec(join(root, 'specs', 'crm.tron'), CRM);
	mkdirSync(join(root, 'src', 'crm', 'endpoints'), { recursive: true });
	writeFileSync(join(root, 'src', 'crm', 'endpoints', 'webhook.c'), WEBHOOK_BODY);
	return root;
}

const cleanup = [];
afterAll(() => cleanup.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('indexBody', () => {
	test('address literals become static edges with symbol anchors and lines', () => {
		const calls = indexBody(WEBHOOK_BODY);
		expect(calls).toEqual([
			{ to: 'crm.Service.mailer', at: '#default', line: 2, confidence: 'static' }
		]);
	});

	test('non-literal resolve() is a heuristic edge — the graph never pretends', () => {
		const calls = indexBody(`export handle := async (ctx) => {
	const name = pick()
	return ctx.container.resolve(name)
}
`);
		expect(calls).toEqual([{ to: '(dynamic)', at: '#handle', line: 3, confidence: 'heuristic' }]);
	});

	test('class methods anchor calls to their own symbol', () => {
		const calls = indexBody(`export default class R {
	async onMessage(data) {
		await this.env.container.resolve('crm.Action.win')
	}
}
`);
		expect(calls[0].at).toBe('#onMessage');
		expect(calls[0].to).toBe('crm.Action.win');
	});
});

describe('flowApp (K-24)', () => {
	test('derives pipeline trees for every runnable unit', () => {
		const root = appDir();
		cleanup.push(root);
		const flow = flowApp(join(root, 'specs'));

		const webhook = flow.units['crm.Endpoint.webhook'];
		expect(webhook.stages.map((s) => s.kind)).toEqual([
			'transport',
			'auth',
			'validate',
			'body',
			'respond'
		]);
		expect(webhook.stages[1].mode).toBe('hmac');
		expect(webhook.stages[3].calls).toEqual([
			{ to: 'crm.Service.mailer', at: '#default', line: 2, confidence: 'static' }
		]);
		expect(webhook.stages[4].schema).toBe('output');

		const chat = flow.units['crm.Endpoint.chat'];
		expect(chat.stages.at(-1)).toEqual({ kind: 'stream', frame: ['delta'], src: 'generated' });

		const win = flow.units['crm.Action.win'];
		expect(win.stages.map((s) => s.kind)).toEqual([
			'transport',
			'policy',
			'validate',
			'machine',
			'steps',
			'emit',
			'refresh',
			'respond'
		]);
		expect(win.stages[1].guards).toEqual(['crm.Policy.Deal']);
		expect(win.stages[4].entries).toEqual(['set Deal.status', 'emit deal.won']);
		expect(win.stages[5].events).toEqual(['deal.won']);

		const job = flow.units['crm.Job.syncDeal'];
		expect(job.stages[0]).toMatchObject({ kind: 'consume', retry: { attempts: 3, backoff: 'none' } });
		expect(job.stages.at(-1).kind).toBe('ack');

		const room = flow.units['crm.Worker.matchRoom'];
		expect(room.stages.map((s) => s.kind)).toEqual([
			'transport',
			'auth',
			'messages',
			'body',
			'broadcast'
		]);
		expect(room.stages[4].out).toEqual(['state']);

		expect(flow.units['crm.Query.board'].stages[0]).toMatchObject({ kind: 'read', from: 'Deal', limit: 50 });
		expect(flow.units['crm.Entity.Deal']).toBeUndefined();
	});

	// v6 M-37 — the report's finding 11: a custom action guarded only by its
	// dotted `Entity.id` input (no steps, no Policy.run entry) showed no policy
	// stage, so a guarded action read as unguarded.
	test('the implicit dotted-id ownership guard appears as a policy stage', () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-flow-implicit-'));
		cleanup.push(root);
		const crm = structuredClone(CRM);
		crm.actions.markReminded = {
			input: { id: 'Deal.id' },
			impl: 'custom',
			examples: [{ input: { id: '$open' } }]
		};
		writeSpec(join(root, 'specs', 'app.tron'), APP);
		writeSpec(join(root, 'specs', 'crm.tron'), crm);
		const flow = flowApp(join(root, 'specs'));

		const stages = flow.units['crm.Action.markReminded'].stages;
		const policy = stages.find((s) => s.kind === 'policy');
		expect(policy).toBeDefined();
		expect(policy.guards).toEqual(['crm.Policy.Deal']);
	});
});

describe('flowDelta (K-26)', () => {
	test('identical flows produce no deltas', () => {
		const root = appDir();
		cleanup.push(root);
		const units = flowApp(join(root, 'specs')).units;
		expect(flowDelta(units, structuredClone(units))).toEqual([]);
	});

	test('spec and body changes become compact semantic strings', () => {
		const root = appDir();
		cleanup.push(root);
		const dir = join(root, 'specs');
		const before = flowApp(dir).units;

		const crm = structuredClone(CRM);
		crm.endpoints.webhook.auth = { mode: 'bearer', binding: 'PAY_TOKEN' };
		crm.actions.win.steps.push({ emit: 'deal.celebrated' });
		delete crm.endpoints.chat;
		crm.functions = { slugify: { input: { title: 'text' } } };
		writeSpec(join(dir, 'crm.tron'), crm);
		writeFileSync(
			join(root, 'src', 'crm', 'endpoints', 'webhook.c'),
			`export default async ({ input }) => ({ ok: input.event === 'paid' })\n`
		);

		const deltas = flowDelta(before, flowApp(dir).units);
		expect(deltas).toContain('crm.Endpoint.webhook: auth hmac → bearer');
		expect(deltas).toContain('crm.Endpoint.webhook: body no longer calls crm.Service.mailer');
		expect(deltas).toContain('crm.Action.win: steps +emit deal.celebrated');
		expect(deltas).toContain('crm.Action.win: now emits deal.celebrated');
		expect(deltas).toContain('crm.Endpoint.chat: flow removed');
		expect(deltas).toContain('crm.Function.slugify: new flow (validate → body → respond)');
	});

	test('a stage insertion names its position', () => {
		const before = {
			'm.Endpoint.x': {
				unit: 'm.Endpoint.x',
				stages: [
					{ kind: 'transport', route: '/x', method: 'POST', src: 'spec' },
					{ kind: 'body', src: 'src/m/endpoints/x.c' },
					{ kind: 'respond', schema: null, src: 'generated' }
				]
			}
		};
		const after = structuredClone(before);
		after['m.Endpoint.x'].stages.splice(1, 0, { kind: 'auth', mode: 'bearer', src: 'generated' });
		expect(flowDelta(before, after)).toEqual(['m.Endpoint.x: +auth stage before body']);
	});
});

describe('emitFlow cache', () => {
	test('writes per-module files, skips unchanged, rebuilds on body change', () => {
		const root = appDir();
		cleanup.push(root);
		const specs = loadSpecs(join(root, 'specs'));

		const first = emitFlow(specs);
		expect(first.written).toEqual(['crm']);
		const file = join(root, '.norns', 'cache', 'flow', 'crm.json');
		expect(existsSync(file)).toBe(true);
		const entry = JSON.parse(readFileSync(file, 'utf-8'));
		expect(entry.units['crm.Endpoint.webhook']).toBeDefined();
		expect(Object.keys(entry.bodies)).toContain('src/crm/endpoints/webhook.c');

		const second = emitFlow(specs);
		expect(second.written).toEqual([]);
		expect(second.skipped).toEqual(['crm']);

		writeFileSync(
			join(root, 'src', 'crm', 'endpoints', 'webhook.c'),
			`export default async () => ({ ok: true })\n`
		);
		const third = emitFlow(specs);
		expect(third.written).toEqual(['crm']);
		const rebuilt = JSON.parse(readFileSync(file, 'utf-8'));
		expect(rebuilt.units['crm.Endpoint.webhook'].stages[3].calls).toBeUndefined();
	});
});
