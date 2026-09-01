import { describe, expect, test } from 'bun:test';

import {
	KINDS,
	KIND_KEYS,
	KEY_KINDS,
	ensureUids,
	formatAddress,
	indexUnits,
	isAddress,
	listUnits,
	newUid,
	parseAddress,
	resolvePath
} from '../src/kernel/address.js';

const ORDERS = {
	module: 'orders',
	entities: {
		Order: {
			uid: '01J8QF0000AAAAAAAAAAAAAAAA',
			fields: { total: { type: 'money' }, note: { type: 'text', optional: true } }
		}
	},
	actions: {
		submit: { input: { id: 'Order.id' } },
		price: { impl: 'custom' }
	},
	triggers: {
		'catalog.Product.deleted': 'orders.Action.cancelLineItems'
	}
};

describe('kinds', () => {
	test('every kind has a collection key and the maps invert each other', () => {
		expect(KINDS.length).toBe(13);
		for (const kind of KINDS) expect(KEY_KINDS[KIND_KEYS[kind]]).toBe(kind);
	});
});

describe('parseAddress / formatAddress', () => {
	test('round-trips a simple address', () => {
		const addr = parseAddress('orders.Action.submit');
		expect(addr).toEqual({ module: 'orders', kind: 'Action', name: 'submit' });
		expect(formatAddress(addr)).toBe('orders.Action.submit');
	});

	test('dotted names (trigger sources) stay in the name', () => {
		expect(parseAddress('orders.Trigger.catalog.Product.deleted')).toEqual({
			module: 'orders',
			kind: 'Trigger',
			name: 'catalog.Product.deleted'
		});
	});

	test('rejects unknown kinds, bad modules, missing names', () => {
		expect(() => parseAddress('orders.Widget.x')).toThrow(/unknown kind/);
		expect(() => parseAddress('Orders.Action.x')).toThrow(/bad module/);
		expect(() => parseAddress('orders.Action')).toThrow(/expected module.Kind.name/);
		expect(() => parseAddress('orders.Action.')).toThrow(/expected module.Kind.name/);
		expect(isAddress('orders.Action.submit')).toBe(true);
		expect(isAddress('nope')).toBe(false);
	});
});

describe('newUid', () => {
	test('26-char Crockford, time-sortable, unique', () => {
		const a = newUid(1000);
		const b = newUid(2000);
		expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
		const many = new Set(Array.from({ length: 500 }, () => newUid()));
		expect(many.size).toBe(500);
	});
});

describe('listUnits / indexUnits', () => {
	test('lists every unit with kind, address, uid', () => {
		const units = listUnits('orders', ORDERS);
		const addresses = units.map((u) => u.address).sort();
		expect(addresses).toEqual([
			'orders.Action.price',
			'orders.Action.submit',
			'orders.Entity.Order',
			'orders.Trigger.catalog.Product.deleted'
		]);
		const order = units.find((u) => u.name === 'Order');
		expect(order.uid).toBe('01J8QF0000AAAAAAAAAAAAAAAA');
		const trigger = units.find((u) => u.kind === 'Trigger');
		expect(trigger.uid).toBeNull(); // string shorthand carries no uid
	});

	test('duplicate uids across modules are reported', () => {
		const dup = {
			a: { module: 'a', actions: { x: { uid: 'U1' } } },
			b: { module: 'b', actions: { y: { uid: 'U1' } } }
		};
		const { issues, byUid } = indexUnits(dup);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toContain('duplicate uid U1');
		expect(byUid.get('U1').address).toBe('a.Action.x');
	});
});

describe('ensureUids', () => {
	test('fills only missing uids on object units, in place', () => {
		const modules = { orders: structuredClone(ORDERS) };
		const assigned = ensureUids(modules);
		expect(assigned.sort()).toEqual(['orders.Action.price', 'orders.Action.submit']);
		expect(modules.orders.entities.Order.uid).toBe('01J8QF0000AAAAAAAAAAAAAAAA');
		expect(modules.orders.actions.submit.uid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(typeof modules.orders.triggers['catalog.Product.deleted']).toBe('string');
		expect(ensureUids(modules)).toEqual([]); // idempotent
	});
});

describe('resolvePath', () => {
	const index = indexUnits({ orders: ORDERS });

	test('splits unit address from sub-path', () => {
		const hit = resolvePath(index, 'orders.Entity.Order.fields.note');
		expect(hit.unit.address).toBe('orders.Entity.Order');
		expect(hit.subPath).toEqual(['fields', 'note']);
	});

	test('bare unit address has an empty sub-path', () => {
		const hit = resolvePath(index, 'orders.Action.submit');
		expect(hit.subPath).toEqual([]);
	});

	test('longest-name match wins for dotted trigger names', () => {
		const hit = resolvePath(index, 'orders.Trigger.catalog.Product.deleted');
		expect(hit.unit.name).toBe('catalog.Product.deleted');
		expect(hit.subPath).toEqual([]);
	});

	test('unknown units resolve to null', () => {
		expect(resolvePath(index, 'orders.Action.nope')).toBeNull();
		expect(resolvePath(index, 'other.Entity.Order')).toBeNull();
		expect(resolvePath(index, 'orders')).toBeNull();
	});

	test('rename-safety: after a rename the uid still finds the unit', () => {
		const modules = { orders: structuredClone(ORDERS) };
		const uid = modules.orders.entities.Order.uid;
		modules.orders.entities.Invoice = modules.orders.entities.Order;
		delete modules.orders.entities.Order;
		const after = indexUnits(modules);
		expect(after.byAddress.has('orders.Entity.Order')).toBe(false);
		expect(after.byUid.get(uid).address).toBe('orders.Entity.Invoice');
	});
});
