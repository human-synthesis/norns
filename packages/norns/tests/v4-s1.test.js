// V4-S1 (K-32/33/35, R-17): authority warnings + ready-to-apply ops,
// sensitive-field query projection, body hygiene lint, runtime enforcement.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emitModuleQueries } from '../src/kernel/emit-units.js';
import { valibotFor } from '../src/kernel/emit-schema.js';
import { checkBodyHygiene } from '../src/kernel/generate.js';
import { refineSpecs } from '../src/kernel/refine.js';
import { endpoint } from '../src/server/endpoint.js';
import { securityHandle } from '../src/server/handle/security.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

const specsOf = (orders = ORDERS) => ({
	app: APP,
	modules: { orders: structuredClone(orders), catalog: structuredClone(CATALOG) }
});

describe('D30 authority warnings carry ready-to-apply ops (K-32)', () => {
	test('an entity without a Policy warns with a default-deny op', () => {
		const specs = specsOf();
		delete specs.modules.orders.policies;
		const issue = refineSpecs(specs).find((i) => i.message.includes('no Policy'));
		expect(issue.level).toBe('warning');
		expect(issue.op).toEqual({
			op: 'set',
			path: 'orders.Policy.Order',
			value: { read: 'owner or role:admin', write: 'owner' }
		});
	});

	test('a public endpoint without rateLimit warns with a rateLimit op', () => {
		const specs = specsOf();
		specs.modules.orders.endpoints = {
			hook: { route: '/hook', method: 'POST', auth: { mode: 'none' }, output: { ok: 'bool' }, impl: 'custom', examples: [{ input: {}, expect: { ok: true } }] }
		};
		const issue = refineSpecs(specs).find((i) => i.message.includes('rateLimit'));
		expect(issue.level).toBe('warning');
		expect(issue.op.path).toBe('orders.Endpoint.hook.rateLimit');

		specs.modules.orders.endpoints.hook.rateLimit = { per: 'ip', rpm: 60 };
		expect(refineSpecs(specs).find((i) => i.message.includes('rateLimit'))).toBeUndefined();
	});

	test('file fields warn until mime + max are declared', () => {
		const specs = specsOf();
		specs.modules.orders.entities.Order.fields.contract = { type: 'file' };
		const issue = refineSpecs(specs).find((i) => i.message.includes('file field'));
		expect(issue.level).toBe('warning');
		expect(issue.op.value.mime).toBeDefined();
	});
});

describe('D30 input bounds', () => {
	test('text is capped by default, explicit max wins, other types untouched', () => {
		expect(valibotFor('text')).toBe('v.pipe(v.string(), v.maxLength(10000))');
		expect(valibotFor({ type: 'text', max: 200 })).toBe('v.pipe(v.string(), v.maxLength(200))');
		expect(valibotFor('int')).toBe('v.pipe(v.number(), v.integer())');
	});
});

describe('D31 sensitive fields (K-33)', () => {
	test('queries project sensitive fields away unless revealed', () => {
		const specs = specsOf();
		specs.modules.orders.entities.Order.fields.note = { type: 'text', optional: true, sensitive: true };
		specs.modules.orders.queries.open = { from: 'Order', limit: 10 };
		const text = emitModuleQueries('orders', specs.modules.orders, specs).text;
		expect(text).toContain('customer: Order.customer');
		expect(text).not.toContain('note: Order.note');

		specs.modules.orders.queries.open.reveal = ['note'];
		const revealed = emitModuleQueries('orders', specs.modules.orders, specs).text;
		expect(revealed).toMatch(/db.select\(\).from\(Order\)|note: Order.note/);
	});
});

describe('D35 body hygiene (K-35)', () => {
	function project(files) {
		const root = mkdtempSync(join(tmpdir(), 'norns-hygiene-'));
		for (const [rel, content] of Object.entries(files)) {
			mkdirSync(join(root, rel, '..'), { recursive: true });
			writeFileSync(join(root, rel), content);
		}
		return root;
	}

	test('token-shaped literals, raw SQL, and unescaped Pug are refused', () => {
		const root = project({
			'src/orders/functions/leak.c': `export default async () => ({ key: 'sk_live_AbCdEf1234567890' })\n`,
			'src/orders/functions/raw.c': "import { sql } from 'drizzle-orm'\nexport default async ({ container }) => container.resolve('db').run(sql.raw('DROP TABLE x'))\n",
			'src/orders/snippets/cell.n': `div\n\t| !{row.html}\n`
		});
		const specs = {
			dir: join(root, 'specs'),
			modules: {
				orders: {
					module: 'orders',
					functions: {
						leak: { examples: [{ input: {}, expect: {} }] },
						raw: { examples: [{ input: {}, expect: {} }] }
					},
					snippets: { cell: { args: ['row'] } }
				}
			}
		};
		const codes = checkBodyHygiene(specs).map((r) => r.code).sort();
		// D83: the token-shaped-literal scan is gone — bodies hold what their author wrote.
		expect(codes).toEqual(['PUG_UNESCAPED', 'RAW_SQL']);
	});

	test("capabilities: ['raw-sql'] lets a declared unit through", () => {
		const root = project({
			'src/orders/functions/raw.c': "import { sql } from 'drizzle-orm'\nexport default async ({ container }) => container.resolve('db').run(sql.raw('PRAGMA x'))\n"
		});
		const specs = {
			dir: join(root, 'specs'),
			modules: {
				orders: {
					module: 'orders',
					functions: { raw: { capabilities: ['raw-sql'], examples: [{ input: {}, expect: {} }] } }
				}
			}
		};
		expect(checkBodyHygiene(specs)).toEqual([]);
	});
});

describe('R-17 runtime enforcement', () => {
	const fakeEvent = (over = {}) => ({
		request: new Request('http://127.0.0.1/api/x', { method: 'POST', body: '{}', ...over.request }),
		url: new URL('http://127.0.0.1/api/x'),
		locals: { container: { has: () => false, resolve: () => undefined }, user: null },
		getClientAddress: () => over.ip ?? '1.2.3.4',
		...over
	});

	test('securityHandle sets the header floor without clobbering app headers', async () => {
		const handle = securityHandle();
		const response = await handle({
			event: { url: new URL('https://127.0.0.1/') },
			resolve: async () => new Response('ok', { headers: { 'x-frame-options': 'SAMEORIGIN' } })
		});
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN'); // app tightened/changed — kept
		expect(response.headers.get('strict-transport-security')).toContain('max-age');
	});

	test('a declared rateLimit answers 429 past the window', async () => {
		const handler = endpoint({
			name: 'orders.Endpoint.ping',
			auth: { mode: 'none' },
			rateLimit: { per: 'ip', rpm: 2 },
			body: async () => ({ ok: true })
		});
		await handler(fakeEvent({ ip: '9.9.9.9' }));
		await handler(fakeEvent({ ip: '9.9.9.9' }));
		await expect(handler(fakeEvent({ ip: '9.9.9.9' }))).rejects.toMatchObject({ status: 429 });
		// another caller is unaffected
		await handler(fakeEvent({ ip: '8.8.8.8' }));
	});

	test('cors: same-origin refuses cross-origin; any echoes the origin', async () => {
		const make = (cors) =>
			endpoint({ name: 'orders.Endpoint.c', auth: { mode: 'none' }, cors, body: async () => ({ ok: true }) });
		const withOrigin = (origin) =>
			fakeEvent({
				request: new Request('http://127.0.0.1/api/x', { method: 'POST', body: '{}', headers: { origin } })
			});
		await expect(make('same-origin')(withOrigin('https://evil.example'))).rejects.toMatchObject({ status: 403 });
		const res = await make('any')(withOrigin('https://elsewhere.example'));
		expect(res.headers.get('access-control-allow-origin')).toBe('https://elsewhere.example');
	});
});
