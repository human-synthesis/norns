/**
 * v10 (D77–D85) kernel edges removed: K-55 set-step dynamic values, K-56
 * orphan pruning, K-57 null comparisons, K-58 form coercion, K-59
 * QUERY_UNTESTED, K-60 wrangler-shaped migrations.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compile } from '@danielx/civet';
import * as v from 'valibot';
import { writeSpec } from '@human-synthesis/norns-tron/spec';

import { generateApp, validateSpecs, wranglerConfig } from '../src/kernel/index.js';
import { emitModuleActions } from '../src/kernel/emit-units.js';
import { parseExpr } from '../src/kernel/expr.js';
import { compileWhere } from '../src/kernel/expr-compile.js';
import { page } from '../src/server/page.js';
import { authHandle } from '../src/server/handle/auth.js';
import { createApp } from '../src/server/boot.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

function specsDir(files) {
	const root = mkdtempSync(join(tmpdir(), 'norns-v10-'));
	const dir = join(root, 'specs');
	for (const [name, value] of Object.entries(files)) {
		writeSpec(join(dir, `${name}.tron`), value);
	}
	return { root, dir, done: () => rmSync(root, { recursive: true, force: true }) };
}

function formEvent(params, container) {
	const url = new URL('http://localhost/x');
	const request = new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(params).toString()
	});
	return { request, url, params: {}, route: { id: '/x' }, locals: { container }, platform: undefined };
}

describe('K-57 null comparisons compile to IS [NOT] NULL', () => {
	const ops = {
		isNull: (c) => ['isNull', c],
		isNotNull: (c) => ['isNotNull', c],
		eq: (c, x) => ['eq', c, x],
		ne: (c, x) => ['ne', c, x],
		gt: (c, x) => ['gt', c, x],
		bool: (b) => ['bool', b]
	};
	const table = { due: 'due' };

	test('!= null and == null', () => {
		expect(compileWhere(parseExpr('due != null'), { table, ops })).toEqual(['isNotNull', 'due']);
		expect(compileWhere(parseExpr('due == null'), { table, ops })).toEqual(['isNull', 'due']);
		expect(compileWhere(parseExpr('null != due'), { table, ops })).toEqual(['isNotNull', 'due']);
	});

	test('other operators against null are refused', () => {
		expect(() => compileWhere(parseExpr('due > null'), { table, ops })).toThrow(/null only supports/);
	});
});

describe('K-55 set steps take dynamic values', () => {
	const withAnnotate = structuredClone(ORDERS);
	withAnnotate.actions.annotate = {
		input: { id: 'Order.id', note: 'text' },
		steps: [{ set: { entity: 'Order', note: 'input.note', customer: '$user' } }]
	};
	const specs = { app: APP, modules: { orders: withAnnotate, catalog: CATALOG } };

	test('input refs and $user reach the update', () => {
		const file = emitModuleActions('orders', withAnnotate, specs);
		expect(file.text).toContain('note: input.note');
		expect(file.text).toContain('customer: user?.id');
		compile(file.text, { sync: true, js: true });
	});

	test('an undeclared input ref is a validate error', () => {
		const broken = structuredClone(withAnnotate);
		broken.actions.annotate.steps = [{ set: { entity: 'Order', note: 'input.nope' } }];
		const { dir, done } = specsDir({ app: APP, orders: broken, catalog: CATALOG });
		try {
			const result = validateSpecs(dir);
			expect(result.issues.some((i) => i.level === 'error' && /set\.note: "input\.nope" is not a declared input/.test(i.message))).toBe(true);
		} finally {
			done();
		}
	});
});

describe('K-58 form actions coerce by the declared shape', () => {
	const schema = v.strictObject({
		amount: v.pipe(v.number(), v.integer()),
		done: v.boolean(),
		note: v.optional(v.string()),
		score: v.optional(v.number())
	});

	test('numeric strings and checkbox values arrive typed', async () => {
		let seen;
		const actions = page.actions({ save: { input: schema, run: ({ input }) => (seen = input) } });
		await actions.save(formEvent({ amount: '42', done: 'on', score: '' }, createApp().scope()));
		expect(seen).toEqual({ amount: 42, done: true });
	});

	test('an unchecked checkbox is false, not a validation error', async () => {
		let seen;
		const actions = page.actions({ save: { input: schema, run: ({ input }) => (seen = input) } });
		const result = await actions.save(formEvent({ amount: '7' }, createApp().scope()));
		expect(result).toEqual({ amount: 7, done: false });
		expect(seen.done).toBe(false);
	});

	test('a non-numeric string still fails validation by name', async () => {
		const actions = page.actions({ save: { input: schema, run: () => ({ ok: true }) } });
		const result = await actions.save(formEvent({ amount: 'lots', done: 'on' }, createApp().scope()));
		expect(result).toMatchObject({ status: 400 });
	});
});

describe('K-59 QUERY_UNTESTED', () => {
	test('a filtered query without examples warns with a ready fixture op', () => {
		const orders = structuredClone(ORDERS);
		orders.queries.noted = { from: 'Order', filter: 'note != null', limit: 10 };
		const { dir, done } = specsDir({ app: APP, orders, catalog: CATALOG });
		try {
			const warning = validateSpecs(dir).issues.find((i) => i.message.startsWith('QUERY_UNTESTED'));
			expect(warning).toBeDefined();
			expect(warning.level).toBe('warning');
			expect(warning.address).toBe('orders.Query.noted');
			expect(warning.op.path).toBe('orders.Query.noted.examples');
			expect(warning.op.value[0].given.Order[0]).toEqual({ customer: 'ref-1', total: 100, note: 'sample' });
			expect(warning.op.value[0].expect).toEqual({ count: 1 });
		} finally {
			done();
		}
	});

	test('with an example it stays quiet', () => {
		const orders = structuredClone(ORDERS);
		orders.queries.noted = {
			from: 'Order',
			filter: 'note != null',
			limit: 10,
			examples: [{ given: { Order: [{ note: 'x' }] }, expect: { count: 1 } }]
		};
		const { dir, done } = specsDir({ app: APP, orders, catalog: CATALOG });
		try {
			expect(validateSpecs(dir).issues.some((i) => i.message.startsWith('QUERY_UNTESTED'))).toBe(false);
		} finally {
			done();
		}
	});
});

describe('K-56 generate prunes its own orphans', () => {
	test('a renamed page leaves no stale route; foreign files survive', () => {
		const { root, dir, done } = specsDir({ app: APP, orders: ORDERS, catalog: CATALOG });
		try {
			const out = join(root, '.norns', 'generated');
			generateApp(dir);
			expect(existsSync(join(out, 'routes', 'orders', '+page.n'))).toBe(true);
			writeFileSync(join(out, 'keep.txt'), 'mine');

			const renamed = structuredClone(ORDERS);
			renamed.pages.board.route = '/board';
			writeSpec(join(dir, 'orders.tron'), renamed);
			generateApp(dir);
			expect(existsSync(join(out, 'routes', 'board', '+page.n'))).toBe(true);
			expect(existsSync(join(out, 'routes', 'orders'))).toBe(false);
			expect(readFileSync(join(out, 'keep.txt'), 'utf-8')).toBe('mine');
			expect(existsSync(join(out, 'lib', 'catalog', 'schema.c'))).toBe(true);
		} finally {
			done();
		}
	});

	test('a removed module takes its tree with it', () => {
		const { root, dir, done } = specsDir({ app: APP, orders: ORDERS, catalog: CATALOG });
		try {
			const out = join(root, '.norns', 'generated');
			generateApp(dir);
			expect(existsSync(join(out, 'lib', 'catalog', 'schema.c'))).toBe(true);
			rmSync(join(dir, 'catalog.tron'));
			const orders = structuredClone(ORDERS);
			orders.depends = ['core'];
			delete orders.triggers;
			writeSpec(join(dir, 'orders.tron'), orders);
			writeSpec(join(dir, 'app.tron'), { ...APP, modules: ['orders'] });
			generateApp(dir);
			expect(existsSync(join(out, 'lib', 'catalog'))).toBe(false);
			expect(existsSync(join(out, 'lib', 'orders', 'schema.c'))).toBe(true);
		} finally {
			done();
		}
	});
});

describe('T-02 authHandle accepts a per-request factory (D86)', () => {
	const fake = {
		handler: () => new Response('auth'),
		api: { getSession: async () => ({ user: { id: 'u9', roles: ['admin'] }, session: { id: 's1' } }) }
	};
	const event = (path) => {
		const request = new Request(`http://localhost${path}`);
		return { request, url: new URL(request.url), locals: {} };
	};

	test('the factory builds the instance from the event; nothing means anonymous', async () => {
		const handle = authHandle(async (ev) => (ev.url.pathname.startsWith('/open') ? undefined : fake));
		const resolve = async (ev) => ev.locals.user ?? null;
		expect(await handle({ event: event('/tasks'), resolve })).toEqual({ id: 'u9', roles: ['admin'] });
		expect(await handle({ event: event('/open'), resolve })).toBeNull();
		const res = await handle({ event: event('/api/auth/sign-in'), resolve });
		expect(await res.text()).toBe('auth');
	});
});

describe('D87 blank-state page for a page-less app', () => {
	test('the clean starter answers / until the first spec Page exists', () => {
		const { root, dir, done } = specsDir({ app: { name: 'blank', dialect: 'd1', modules: [] } });
		try {
			const out = join(root, '.norns', 'generated');
			const first = generateApp(dir);
			expect(first.written).toContain('routes/+page.svelte');
			expect(readFileSync(join(out, 'routes', '+page.svelte'), 'utf-8')).toContain('No pages yet');
			expect(generateApp(dir).written).toEqual([]);

			writeSpec(join(dir, 'app.tron'), APP);
			writeSpec(join(dir, 'orders.tron'), ORDERS);
			writeSpec(join(dir, 'catalog.tron'), CATALOG);
			generateApp(dir);
			expect(existsSync(join(out, 'routes', '+page.svelte'))).toBe(false);
			expect(existsSync(join(out, 'routes', 'orders', '+page.n'))).toBe(true);
		} finally {
			done();
		}
	});
});

describe('K-60 wrangler-shaped migrations', () => {
	test('module migrations mirror into a flat numbered dir with stable numbers', () => {
		const { root, dir, done } = specsDir({ app: APP, orders: ORDERS, catalog: CATALOG });
		try {
			mkdirSync(join(root, 'migrations', 'orders'), { recursive: true });
			mkdirSync(join(root, 'migrations', 'catalog'), { recursive: true });
			writeFileSync(join(root, 'migrations', 'orders', '0000_init.sql'), 'CREATE TABLE orders (id text);\n');
			writeFileSync(join(root, 'migrations', 'catalog', '0000_init.sql'), 'CREATE TABLE products (id text);\n');
			const first = generateApp(dir);
			const out = join(root, '.norns', 'generated', 'migrations');
			expect(first.written).toContain('migrations/0000_catalog_init.sql');
			expect(first.written).toContain('migrations/0001_orders_init.sql');
			expect(readFileSync(join(out, '0001_orders_init.sql'), 'utf-8')).toContain('CREATE TABLE orders');

			expect(generateApp(dir).written).toEqual([]);

			writeFileSync(join(root, 'migrations', 'catalog', '0001_more.sql'), 'ALTER TABLE products ADD price integer;\n');
			const third = generateApp(dir);
			expect(third.written).toEqual(['migrations/0002_catalog_more.sql']);
			expect(existsSync(join(out, '0000_catalog_init.sql'))).toBe(true);

			const config = JSON.parse(readFileSync(join(root, '.norns', 'generated', 'wrangler.json'), 'utf-8'));
			expect(config.d1_databases[0].migrations_dir).toBe('migrations');
		} finally {
			done();
		}
	});

	test('wranglerConfig always names the mirrored dir', () => {
		expect(wranglerConfig({ app: APP, modules: {} }).d1_databases[0].migrations_dir).toBe('migrations');
	});
});
