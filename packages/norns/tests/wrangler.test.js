import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSpec } from '@human-synthesis/norns-tron/spec';

import { generateApp, layoutFile, wranglerConfig } from '../src/kernel/index.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

const specsOf = (app, modules) => ({ app, modules });

describe('wranglerConfig', () => {
	test('d1 app gets name, worker entry, assets and a DB binding', () => {
		const config = wranglerConfig(specsOf(APP, { catalog: CATALOG }));
		expect(config.name).toBe('shop');
		expect(config.main).toBe('.svelte-kit/cloudflare/_worker.js');
		expect(config.compatibility_flags).toEqual(['nodejs_compat']);
		expect(config.assets).toEqual({ binding: 'ASSETS', directory: '.svelte-kit/cloudflare' });
		expect(config.d1_databases).toEqual([
			{
				binding: 'DB',
				database_name: 'shop-db',
				database_id: '<set app.settings.cloudflare.d1_id>'
			}
		]);
		expect(config.r2_buckets).toBeUndefined();
		expect(config.queues).toBeUndefined();
		expect(config.triggers).toBeUndefined();
	});

	test('settings.cloudflare fills in account-specific values', () => {
		const app = {
			...APP,
			settings: { cloudflare: { d1_id: 'abc-123', compatibility_date: '2026-01-01' } }
		};
		const config = wranglerConfig(specsOf(app, {}));
		expect(config.d1_databases[0].database_id).toBe('abc-123');
		expect(config.compatibility_date).toBe('2026-01-01');
	});

	test('non-d1 dialect emits no D1 binding', () => {
		const config = wranglerConfig(specsOf({ ...APP, dialect: 'postgres' }, {}));
		expect(config.d1_databases).toBeUndefined();
	});

	test('live queries and room workers add the ROOM Durable Object binding', () => {
		expect(wranglerConfig(specsOf(APP, { catalog: CATALOG })).durable_objects).toBeUndefined();

		const live = wranglerConfig(specsOf(APP, { orders: ORDERS }));
		expect(live.durable_objects).toEqual({
			bindings: [{ name: 'ROOM', class_name: 'NornsRoom' }]
		});
		expect(live.migrations).toEqual([{ tag: 'norns-room-v1', new_classes: ['NornsRoom'] }]);

		const match = {
			module: 'game',
			workers: { match: { source: 'src/game/match.worker.c', auth: 'authenticated', room: true } }
		};
		const withWorker = wranglerConfig(
			specsOf({ ...APP, settings: { cloudflare: { room_class: 'MatchRoom' } } }, { game: match })
		);
		expect(withWorker.durable_objects.bindings[0].class_name).toBe('MatchRoom');
	});

	test('worker name is lowercased and dashed', () => {
		const config = wranglerConfig(specsOf({ name: 'My_App' }, {}));
		expect(config.name).toBe('my-app');
		expect(config.d1_databases[0].database_name).toBe('my-app-db');
	});

	test('a file field anywhere adds the STORAGE R2 bucket', () => {
		const mod = {
			module: 'docs',
			entities: { Doc: { fields: { attachment: { type: 'file' }, title: 'text' } } }
		};
		const config = wranglerConfig(specsOf(APP, { docs: mod }));
		expect(config.r2_buckets).toEqual([{ binding: 'STORAGE', bucket_name: 'shop-storage' }]);
	});

	test('settings.cloudflare.r2 forces the bucket without file fields', () => {
		const app = { ...APP, settings: { cloudflare: { r2: true } } };
		expect(wranglerConfig(specsOf(app, {})).r2_buckets).toEqual([
			{ binding: 'STORAGE', bucket_name: 'shop-storage' }
		]);
	});

	test('settings.cloudflare.queue adds producer + consumer', () => {
		const app = { ...APP, settings: { cloudflare: { queue: true } } };
		expect(wranglerConfig(specsOf(app, {})).queues).toEqual({
			producers: [{ binding: 'EVENTS', queue: 'shop-events' }],
			consumers: [{ queue: 'shop-events' }]
		});
	});

	test('schedule triggers become deduped sorted crons', () => {
		const a = {
			module: 'a',
			triggers: {
				nightly: { action: 'a.Action.x', schedule: '0 3 * * *' },
				hourly: { action: 'a.Action.x', schedule: '0 * * * *' }
			}
		};
		const b = {
			module: 'b',
			triggers: {
				alsoNightly: { action: 'b.Action.y', schedule: '0 3 * * *' },
				onEvent: 'b.Action.y'
			}
		};
		const config = wranglerConfig(specsOf(APP, { a, b }));
		expect(config.triggers).toEqual({ crons: ['0 * * * *', '0 3 * * *'] });
	});
});

describe('generateApp wrangler output', () => {
	function specsDir(files) {
		const root = mkdtempSync(join(tmpdir(), 'norns-wrangler-'));
		const dir = join(root, 'specs');
		for (const [name, value] of Object.entries(files)) {
			writeSpec(join(dir, `${name}.tron`), value);
		}
		return { root, dir, done: () => rmSync(root, { recursive: true, force: true }) };
	}

	test('wrangler.json is written alongside the generated tree and refreshed on change', () => {
		const { root, dir, done } = specsDir({ app: APP, orders: ORDERS, catalog: CATALOG });
		try {
			const first = generateApp(dir);
			expect(first.written).toContain('wrangler.json');
			const file = join(root, '.norns', 'generated', 'wrangler.json');
			expect(existsSync(file)).toBe(true);
			const config = JSON.parse(readFileSync(file, 'utf-8'));
			expect(config.name).toBe('shop');
			expect(config.d1_databases[0].binding).toBe('DB');

			// unchanged specs → all modules skipped, no rewrite
			const second = generateApp(dir);
			expect(second.written).toEqual([]);

			// touching the app spec regenerates the wrangler config
			writeSpec(join(dir, 'app.tron'), {
				...APP,
				settings: { cloudflare: { d1_id: 'real-id' } }
			});
			// app spec changes bump every module hash (version), so re-emit happens
			const third = generateApp(dir, { force: true });
			expect(third.written).toContain('wrangler.json');
			const updated = JSON.parse(readFileSync(file, 'utf-8'));
			expect(updated.d1_databases[0].database_id).toBe('real-id');
		} finally {
			done();
		}
	});
});

describe('generateApp layout output', () => {
	function specsDir(files) {
		const root = mkdtempSync(join(tmpdir(), 'norns-layout-'));
		const dir = join(root, 'specs');
		for (const [name, value] of Object.entries(files)) {
			writeSpec(join(dir, `${name}.tron`), value);
		}
		return { root, dir, done: () => rmSync(root, { recursive: true, force: true }) };
	}

	test('layoutFile renders with and without app.css import', () => {
		const plain = layoutFile({ modules: {} }, false);
		expect(plain.path).toBe('routes/+layout.svelte');
		expect(plain.text).toContain('{@render children()}');
		expect(plain.text).not.toContain('app.css');
		expect(layoutFile({ modules: {} }, true).text).toContain("import '$custom/app.css';");
	});

	test('layoutFile with static pages is an admin shell with sidebar nav', () => {
		const specs = {
			app: { name: 'crm_app' },
			modules: {
				deals: {
					pages: {
						dealBoard: { route: '/deals' },
						detail: { route: '/deals/[id]' },
						leads: { route: '/leads' }
					}
				}
			}
		};
		const { text } = layoutFile(specs, false);
		expect(text).toContain('class="norns-shell"');
		expect(text).toContain('<div class="norns-brand">Crm app</div>');
		expect(text).toContain('"href":"/deals","label":"Deal Board"');
		expect(text).toContain('"href":"/leads","label":"Leads"');
		expect(text).not.toContain('[id]');
		expect(text).toContain("aria-current={page.url.pathname === item.href ? 'page' : undefined}");
		expect(text).toContain('<main class="norns-main">{@render children()}</main>');
	});

	test('settings.shell: false suppresses the admin shell even with static pages', () => {
		const specs = {
			app: { name: 'todo', settings: { shell: false } },
			modules: { tasks: { pages: { index: { route: '/' } } } }
		};
		const { text } = layoutFile(specs, false);
		expect(text).not.toContain('norns-shell');
		expect(text).not.toContain('norns-sidebar');
		expect(text).toContain('{@render children()}');
	});

	test('routes/+layout.svelte is written and picks up src/app.css when present', () => {
		const { root, dir, done } = specsDir({ app: APP, orders: ORDERS, catalog: CATALOG });
		try {
			const first = generateApp(dir);
			expect(first.written).toContain('routes/+layout.svelte');
			const file = join(root, '.norns', 'generated', 'routes', '+layout.svelte');
			expect(existsSync(file)).toBe(true);
			expect(readFileSync(file, 'utf-8')).not.toContain('app.css');

			// existing layout + unchanged specs → nothing rewritten
			expect(generateApp(dir).written).toEqual([]);

			// once src/app.css exists, a forced regeneration imports it
			mkdirSync(join(root, 'src'), { recursive: true });
			writeFileSync(join(root, 'src', 'app.css'), '/* theme */\n');
			const forced = generateApp(dir, { force: true });
			expect(forced.written).toContain('routes/+layout.svelte');
			expect(readFileSync(file, 'utf-8')).toContain("import '$custom/app.css';");
		} finally {
			done();
		}
	});
});
