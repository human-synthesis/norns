import { describe, expect, test } from 'bun:test';

import { compile } from '@danielx/civet';

import { emitModuleMachines } from '../src/kernel/emit-machines.js';
import { emitModuleActions } from '../src/kernel/emit-units.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

const specs = { app: APP, modules: { orders: ORDERS, catalog: CATALOG } };

const compiles = (file) => compile(file.text, { sync: true, js: true });

describe('emitModuleMachines', () => {
	const file = emitModuleMachines('orders', ORDERS);

	test('modules without status entities emit nothing', () => {
		expect(emitModuleMachines('catalog', CATALOG)).toBeNull();
	});

	test('emits a runtime machine over the schema transition map', () => {
		expect(file.path).toBe('lib/orders/machines.c');
		expect(file.text).toContain(`import { machine } from '@human-synthesis/norns/server'`);
		expect(file.text).toContain(`import { Order, OrderStatus } from './schema.c'`);
		expect(file.text).toContain('export OrderMachine := machine(OrderStatus)');
	});

	test('emits a policy-wrapped transition action with a sorted state picklist', () => {
		expect(file.text).toContain('export transitionOrder := {');
		expect(file.text).toContain('address: "orders.Action.transitionOrder"');
		expect(file.text).toContain(
			'v.strictObject({ id: v.string(), to: v.picklist(["cancelled","draft","paid","submitted"]) })'
		);
		const run = file.text.slice(file.text.indexOf('export transitionOrder'));
		const order = [
			'error(404',
			'OrderPolicy.write.check',
			'OrderMachine.assert(row.status, input.to)',
			'db.update(Order).set({ status: input.to })',
			'emit("orders.Order.transitioned"'
		].map((s) => run.indexOf(s));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	test('entities without a write policy skip the policy import and check', () => {
		const mod = {
			module: 'jobs',
			entities: { Job: { fields: { title: 'text' }, status: { queued: ['done'], done: [] } } }
		};
		const out = emitModuleMachines('jobs', mod);
		expect(out.text).not.toContain('Policy');
		expect(out.text).toContain('JobMachine.assert(row.status, input.to)');
	});

	test('emitted machines compile through civet', () => {
		expect(compiles(file)).toContain('export const OrderMachine');
	});
});

describe('generated set-status steps carry the machine guard', () => {
	const file = emitModuleActions('orders', ORDERS, specs);

	test('the transition edge is asserted before the update', () => {
		expect(file.text).toContain(`import { Order, OrderStatus } from './schema.c'`);
		const run = file.text.slice(file.text.indexOf('export submit'));
		const guard = run.indexOf('if (!(OrderStatus[row.status] ?? []).includes("submitted"))');
		const update = run.indexOf('db.update(Order)');
		expect(guard).toBeGreaterThan(-1);
		expect(update).toBeGreaterThan(guard);
		expect(run.slice(guard, update)).toContain("'invalid transition '");
	});

	test('non-status set steps stay unguarded', () => {
		const mod = {
			module: 'notes',
			entities: { Note: { fields: { text: 'text' } } },
			actions: {
				rename: {
					input: { id: 'Note.id' },
					steps: [{ set: { entity: 'Note', text: 'renamed' } }]
				}
			}
		};
		const out = emitModuleActions('notes', mod, { app: APP, modules: { notes: mod } });
		expect(out.text).not.toContain('invalid transition');
		expect(out.text).not.toContain('NoteStatus');
	});
});
