import { describe, expect, test } from 'bun:test';

import { compile } from '@danielx/civet';

import {
	emitModuleActions,
	emitModulePages,
	emitModuleRemotes,
	emitModulePolicies,
	emitModuleQueries,
	emitModuleTriggers
} from '../src/kernel/emit-units.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

const specs = { app: APP, modules: { orders: ORDERS, catalog: CATALOG } };

const compiles = (file) => compile(file.text, { sync: true, js: true });

describe('emitModulePolicies', () => {
	const file = emitModulePolicies('orders', ORDERS, specs);

	test('emits guard checks and where fragments per rule', () => {
		expect(file.path).toBe('lib/orders/policies.c');
		expect(file.text).toContain('export OrderPolicy := {');
		expect(file.text).toContain(`ownerField: "customer"`);
		expect(file.text).toContain('check: (row, user) =>');
		expect(file.text).toContain('compileWhere({"op":"or","args":[{"owner":true},{"role":"admin"}]}');
		expect(file.text).toContain('write: {');
		expect(compiles(file)).toContain('export const OrderPolicy');
	});

	test('run rules become per-action guards', () => {
		const withRun = structuredClone(ORDERS);
		withRun.policies.Order.run = { submit: 'role:admin' };
		const out = emitModulePolicies('orders', withRun, specs);
		expect(out.text).toContain('submit: (row, user) => !!user?.roles?.includes("admin")');
		compiles(out);
	});

	test('modules without policies emit nothing', () => {
		expect(emitModulePolicies('bare', { module: 'bare' }, specs)).toBeNull();
	});
});

describe('emitModuleQueries', () => {
	const file = emitModuleQueries('orders', ORDERS, specs);

	test('read policy row rule is ANDed into every select', () => {
		expect(file.path).toBe('lib/orders/queries.c');
		expect(file.text).toContain('OrderPolicy.read.where(ops, ctx.user)');
		expect(compiles(file)).toContain('export const board');
	});

	test('groupBy queries group rows', () => {
		expect(file.text).toContain('return groupRows(rows, "status")');
		expect(file.text).toContain('groupRows := (rows, key)');
	});

	test('filter, sort and limit map to the drizzle chain', () => {
		const spec = structuredClone(ORDERS);
		spec.queries.recent = { from: 'Order', filter: 'status == paid', sort: '-total', limit: 20 };
		const out = emitModuleQueries('orders', spec, specs);
		expect(out.text).toContain('.orderBy(dz.desc(Order.total))');
		expect(out.text).toContain('.limit(20)');
		expect(out.text).toContain('{"op":"==","args":[{"path":["status"]},{"lit":"paid"}]}');
		compiles(out);
	});

	test('filter where-fragments read the user off ctx, never a bare identifier', () => {
		const spec = structuredClone(ORDERS);
		spec.queries.mine = { from: 'Order', filter: 'owner', limit: 20 };
		const out = emitModuleQueries('orders', spec, specs);
		expect(out.text).toContain('user: ctx.user');
		expect(out.text).not.toMatch(/[{,] ?user[,}]/);
		compiles(out);
	});

	test('cross-module from imports the other module schema', () => {
		const spec = { module: 'shop', depends: ['catalog'], queries: { products: { from: 'catalog.Entity.Product', limit: 10 } } };
		const out = emitModuleQueries('shop', spec, specs);
		expect(out.text).toContain(`import { Product } from '../catalog/schema.c'`);
		compiles(out);
	});
});

describe('emitModuleActions', () => {
	const file = emitModuleActions('orders', ORDERS, specs);

	test('guard-first: 404 → policy write → requires → steps', () => {
		const run = file.text.slice(file.text.indexOf('export submit'));
		const order = ['error(404', 'OrderPolicy.write.check', 'requires failed', 'db.update(Order)', `emit("order.submitted"`]
			.map((s) => run.indexOf(s));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(compiles(file)).toContain('export const submit');
	});

	test('status state names compile as literals, not row paths', () => {
		expect(file.text).toContain('(row.status) === ("draft")');
		expect(file.text).not.toContain('row.draft');
	});

	test('input refs map to field-typed valibot schemas', () => {
		expect(file.text).toContain('input: v.strictObject({ id: v.pipe(v.string(), v.maxLength(128)) })');
	});

	test('impl: custom actions emit guard-first shells delegating to $custom', () => {
		expect(file.text).toContain(`import priceBody from '$custom/orders/actions/price.c'`);
		const shell = file.text.slice(file.text.indexOf('export price'), file.text.indexOf('export submit'));
		expect(shell).toContain('OrderPolicy.write.check(row, user)');
		expect(shell).toContain('return priceBody({ row, input, container, user })');
		expect(shell).not.toContain('db.update');
	});

	test('refresh metadata is preserved for the client', () => {
		expect(file.text).toContain('refresh: ["orders.Query.board"]');
	});
});

describe('emitModuleTriggers', () => {
	test('event triggers bind actions', () => {
		const file = emitModuleTriggers('orders', ORDERS);
		expect(file.path).toBe('lib/orders/triggers.c');
		expect(file.text).toContain(`import { cancelLineItems } from './actions.c'`);
		expect(file.text).toContain(`{ on: "catalog.Product.deleted", action: cancelLineItems }`);
		compiles(file);
	});

	test('schedule and source forms carry through', () => {
		const spec = {
			module: 'orders',
			triggers: {
				nightly: { action: 'orders.Action.open', schedule: '0 3 * * *' },
				stripe: { action: 'orders.Action.submit', source: 'stripe' }
			}
		};
		const file = emitModuleTriggers('orders', spec);
		expect(file.text).toContain(`schedule: "0 3 * * *"`);
		expect(file.text).toContain(`source: "stripe"`);
		compiles(file);
	});
});

describe('emitModulePages', () => {
	const files = emitModulePages('orders', ORDERS);
	const server = files.find((f) => f.path.endsWith('+page.server.c'));
	const pug = files.find((f) => f.path.endsWith('+page.n'));

	test('route maps to the routes tree', () => {
		expect(server.path).toBe('routes/orders/+page.server.c');
		expect(pug.path).toBe('routes/orders/+page.n');
	});

	test('load fetches bound queries; actions expose bound actions', () => {
		expect(server.text).toContain(`import { board } from '../../lib/orders/queries.c'`);
		expect(server.text).toContain('board: await board(ctx)');
		expect(server.text).toContain('export actions := page.actions({');
		expect(server.text).toContain('submit: submit');
		expect(compiles(server)).toContain('export const load');
	});

	test('pug template renders components with data/action props', () => {
		expect(pug.text).toContain('Kanban(data!="{data.board}" onMove="?/submit")');
		expect(pug.text).toContain('{ data, form } := $props()');
		expect(pug.text).toContain('selected := $state(null)');
	});

	test('param routes become bracket segments at the right depth', () => {
		const spec = {
			module: 'orders',
			pages: { detail: { route: '/orders/:id', components: [{ timeline: 'orders.Query.board' }] } }
		};
		const [srv] = emitModulePages('orders', spec);
		expect(srv.path).toBe('routes/orders/[id]/+page.server.c');
		expect(srv.text).toContain(`from '../../../lib/orders/queries.c'`);
	});

	test('impl: custom pages keep the generated server file and delegate the template', () => {
		const spec = {
			module: 'orders',
			pages: {
				board: {
					route: '/x',
					impl: 'custom',
					components: [{ kanban: 'orders.Query.board' }],
					examples: [{ input: {}, expect: {} }]
				}
			}
		};
		const out = emitModulePages('orders', spec);
		const srv = out.find((f) => f.path.endsWith('+page.server.c'));
		const tpl = out.find((f) => f.path.endsWith('+page.n'));
		expect(srv.text).toContain('board: await board(ctx)');
		expect(tpl.text).toContain(`import Body from '$custom/orders/pages/board.n'`);
		expect(tpl.text).toContain('Body(data!="{data}" form!="{form}")');
	});

	test('live queries add depends() + a liveQueries effect when specs are provided', () => {
		const specs = { modules: { orders: ORDERS } };
		const out = emitModulePages('orders', ORDERS, specs);
		const srv = out.find((f) => f.path.endsWith('+page.server.c'));
		const tpl = out.find((f) => f.path.endsWith('+page.n'));
		expect(srv.text).toContain(`ctx.event.depends("norns:orders.Query.board")`);
		expect(tpl.text).toContain(`import { invalidate } from '$app/navigation'`);
		expect(tpl.text).toContain(`import { liveQueries } from '@human-synthesis/norns/live-client'`);
		expect(tpl.text).toContain(`$effect(() => liveQueries(["orders.Query.board"], invalidate))`);
		expect(compiles(srv)).toContain('depends');
	});

	test('non-live queries emit no live wiring even with specs', () => {
		const spec = {
			module: 'orders',
			queries: { list: { from: 'Order', limit: 20 } },
			pages: { list: { route: '/list', components: [{ table: 'orders.Query.list' }] } }
		};
		const out = emitModulePages('orders', spec, { modules: { orders: spec } });
		const srv = out.find((f) => f.path.endsWith('+page.server.c'));
		const tpl = out.find((f) => f.path.endsWith('+page.n'));
		expect(srv.text).not.toContain('depends');
		expect(tpl.text).not.toContain('liveQueries');
	});
});

describe('emitModuleRemotes', () => {
	test('actions with transport: remote get a POST endpoint', () => {
		const spec = {
			module: 'orders',
			actions: {
				submit: { ...ORDERS.actions.submit, transport: 'remote' },
				price: ORDERS.actions.price
			}
		};
		const files = emitModuleRemotes('orders', spec);
		expect(files).toHaveLength(1);
		expect(files[0].path).toBe('routes/api/orders/submit/+server.c');
		expect(files[0].text).toContain(`import { remoteAction } from '@human-synthesis/norns/server'`);
		expect(files[0].text).toContain(`import { submit } from '../../../../lib/orders/actions.c'`);
		expect(files[0].text).toContain('export POST := remoteAction(submit)');
		expect(compiles(files[0])).toContain('export const POST');
	});

	test('modules without remote actions emit nothing', () => {
		expect(emitModuleRemotes('orders', ORDERS)).toBe(null);
	});
});
