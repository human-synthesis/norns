import { describe, expect, test } from 'bun:test';

import { compile } from '@danielx/civet';

import { UNIT_SCHEMAS, schemaIssues } from '../src/kernel/meta.js';
import { refineSpecs } from '../src/kernel/refine.js';
import { emitModuleActions, emitModuleJobs } from '../src/kernel/emit-units.js';
import { wranglerConfig } from '../src/kernel/emit-wrangler.js';
import { createContainer } from '../src/server/container.js';
import { createEvents } from '../src/server/events.js';
import { backoffMs, createJobs, registerJobs, runJob } from '../src/server/job.js';
import { boot } from '../src/server/boot.js';

const compiles = (file) => compile(file.text, { sync: true, js: true });

const SYNC_DEAL = {
	input: { id: 'text' },
	retry: { attempts: 3, backoff: 'exponential', baseMs: 1 },
	dlq: 'deadletters',
	steps: [{ call: 'crm.Service.mailer.send', with: { to: 'input.id' } }],
	emits: ['crm.synced']
};

const CRM = {
	module: 'crm',
	services: {
		mailer: {
			base: 'https://api.mailer.example',
			auth: { mode: 'bearer', binding: 'MAILER_TOKEN' },
			operations: { send: { input: { to: 'text' } } }
		}
	},
	jobs: { syncDeal: structuredClone(SYNC_DEAL) },
	actions: {
		won: { steps: [{ enqueue: 'syncDeal', with: { id: 'input.id' } }] }
	}
};

const specsOf = (modules) => ({ app: {}, modules });

describe('Job meta-schema', () => {
	test('a valid job passes', () => {
		expect(schemaIssues(UNIT_SCHEMAS.Job, SYNC_DEAL, 'crm.Job.syncDeal')).toEqual([]);
	});

	test('retry policy is required', () => {
		const { retry, ...bare } = structuredClone(SYNC_DEAL);
		expect(schemaIssues(UNIT_SCHEMAS.Job, bare, 'a').length).toBeGreaterThan(0);
	});

	test('generated jobs need steps; custom jobs need examples', () => {
		const empty = { retry: { attempts: 1, backoff: 'none' } };
		const issues = schemaIssues(UNIT_SCHEMAS.Job, empty, 'a');
		expect(issues.some((i) => i.message.includes('at least one step'))).toBe(true);
		const custom = { retry: { attempts: 1, backoff: 'none' }, impl: 'custom' };
		expect(
			schemaIssues(UNIT_SCHEMAS.Job, custom, 'a').some((i) => i.message.includes('example'))
		).toBe(true);
		custom.examples = [{ input: {} }];
		expect(schemaIssues(UNIT_SCHEMAS.Job, custom, 'a')).toEqual([]);
	});

	test('dlq must be a queue name; attempts are bounded', () => {
		const bad = structuredClone(SYNC_DEAL);
		bad.dlq = 'Dead_Letters';
		expect(schemaIssues(UNIT_SCHEMAS.Job, bad, 'a').length).toBeGreaterThan(0);
		const many = structuredClone(SYNC_DEAL);
		many.retry.attempts = 50;
		expect(schemaIssues(UNIT_SCHEMAS.Job, many, 'a').length).toBeGreaterThan(0);
	});
});

describe('refine: enqueue and job steps', () => {
	test('bare and full enqueue targets resolve', () => {
		const crm = structuredClone(CRM);
		expect(refineSpecs(specsOf({ crm }))).toEqual([]);
		crm.actions.won.steps[0].enqueue = 'crm.Job.syncDeal';
		expect(refineSpecs(specsOf({ crm }))).toEqual([]);
	});

	test('an unknown enqueue target errors', () => {
		const crm = structuredClone(CRM);
		crm.actions.won.steps[0].enqueue = 'ghost';
		const issues = refineSpecs(specsOf({ crm }));
		expect(issues.some((i) => i.message.includes('enqueue') && i.message.includes('ghost'))).toBe(
			true
		);
	});

	test('service calls inside job steps are checked too', () => {
		const crm = structuredClone(CRM);
		crm.jobs.syncDeal.steps[0].call = 'crm.Service.mailer.nope';
		const issues = refineSpecs(specsOf({ crm }));
		expect(issues.some((i) => i.address === 'crm.Job.syncDeal')).toBe(true);
	});
});

describe('emitModuleJobs', () => {
	const file = emitModuleJobs('crm', CRM);

	test('emits job units with their retry/dlq contract and the address map', () => {
		expect(file.path).toBe('lib/crm/jobs.c');
		expect(file.text).toContain(`import { job } from '@human-synthesis/norns/server'`);
		expect(file.text).toContain('export syncDeal := job({');
		expect(file.text).toContain('retry: {"attempts":3,"backoff":"exponential","baseMs":1}');
		expect(file.text).toContain('dlq: "deadletters"');
		expect(file.text).toContain('"crm.Job.syncDeal": syncDeal');
		expect(compiles(file)).toContain('export const syncDeal');
	});

	test('steps compile like action flow steps (service calls, emits)', () => {
		expect(file.text).toContain(`import { mailer } from './services.c'`);
		expect(file.text).toContain('await mailer.send({ to: input.id }, container)');
		expect(file.text).toContain(`emit("crm.synced", { input, user })`);
	});

	test('custom jobs import their body', () => {
		const mod = {
			module: 'crm',
			jobs: {
				crunch: {
					retry: { attempts: 1, backoff: 'none' },
					impl: 'custom',
					examples: [{ input: {} }]
				}
			}
		};
		const out = emitModuleJobs('crm', mod);
		expect(out.text).toContain(`import crunchBody from '$custom/crm/jobs/crunch.c'`);
		expect(out.text).toContain('return crunchBody({ input, container, user })');
		compiles(out);
	});

	test('modules without jobs emit nothing', () => {
		expect(emitModuleJobs('crm', { module: 'crm' })).toBeNull();
	});
});

describe('emitModuleActions: enqueue steps', () => {
	test('bare names resolve to the module job address', () => {
		const file = emitModuleActions('crm', CRM, specsOf({ crm: CRM }));
		expect(file.text).toContain(
			`await container.resolve('jobs').enqueue("crm.Job.syncDeal", { id: input.id }, user)`
		);
		compiles(file);
	});
});

describe('wrangler: job queue settings', () => {
	test('jobs force the queues config with the strictest consumer settings', () => {
		const modules = {
			crm: structuredClone(CRM),
			ops: {
				module: 'ops',
				jobs: {
					sweep: {
						retry: { attempts: 5, backoff: 'fixed' },
						concurrency: 2,
						steps: [{ emit: 'ops.swept' }]
					}
				}
			}
		};
		const config = wranglerConfig({ app: { name: 'demo' }, modules });
		expect(config.queues.producers).toEqual([{ binding: 'EVENTS', queue: 'demo-events' }]);
		expect(config.queues.consumers).toEqual([
			{
				queue: 'demo-events',
				max_retries: 5,
				dead_letter_queue: 'deadletters',
				max_concurrency: 2
			}
		]);
	});

	test('no jobs and no cf.queue flag → no queues config', () => {
		const config = wranglerConfig({ app: { name: 'demo' }, modules: { m: { module: 'm' } } });
		expect(config.queues).toBeUndefined();
	});
});

describe('job runtime', () => {
	test('backoffMs: none / fixed / exponential', () => {
		expect(backoffMs({ backoff: 'none', attempts: 3 }, 2)).toBe(0);
		expect(backoffMs({ backoff: 'fixed', baseMs: 50 }, 3)).toBe(50);
		expect(backoffMs({ backoff: 'exponential', baseMs: 100 }, 3)).toBe(400);
	});

	const jobbedContainer = () => {
		const container = createContainer();
		container.single('events', () => createEvents());
		container.single('jobs', () => createJobs(container));
		return container;
	};

	test('enqueue runs the registered job inline in dev, with retries', async () => {
		const container = jobbedContainer();
		let calls = 0;
		registerJobs(container, {
			'crm.Job.syncDeal': {
				address: 'crm.Job.syncDeal',
				retry: { attempts: 3, backoff: 'fixed', baseMs: 1 },
				run: async ({ input }) => {
					calls++;
					if (calls < 3) throw new Error('flaky');
					return input.id;
				}
			}
		});
		await container.resolve('jobs').enqueue('crm.Job.syncDeal', { id: 'd1' });
		expect(calls).toBe(3);
	});

	test('exhaustion with a dlq emits the dead letter and resolves', async () => {
		const container = jobbedContainer();
		const dead = [];
		container.resolve('events').on('dlq:deadletters', (p) => dead.push(p));
		const jobDef = {
			address: 'crm.Job.syncDeal',
			retry: { attempts: 2, backoff: 'none' },
			dlq: 'deadletters',
			run: async () => {
				throw new Error('down');
			}
		};
		await runJob(jobDef, { input: { id: 'd2' }, container });
		expect(dead).toEqual([
			{ job: 'crm.Job.syncDeal', input: { id: 'd2' }, error: 'down', attempts: 2 }
		]);
	});

	test('exhaustion without a dlq rethrows for queue-level retry', async () => {
		const container = jobbedContainer();
		const jobDef = {
			address: 'crm.Job.x',
			retry: { attempts: 2, backoff: 'none' },
			run: async () => {
				throw new Error('down');
			}
		};
		await expect(runJob(jobDef, { input: {}, container })).rejects.toThrow('down');
	});

	test('boot wires job tables and binds the jobs facade', async () => {
		let ran = null;
		const table = {
			'crm.Job.syncDeal': {
				address: 'crm.Job.syncDeal',
				retry: { attempts: 1, backoff: 'none' },
				run: async ({ input }) => {
					ran = input;
				}
			}
		};
		const app = await boot({ jobs: [table] });
		await app.container.resolve('jobs').enqueue('crm.Job.syncDeal', { id: 'd3' });
		expect(ran).toEqual({ id: 'd3' });
	});
});
