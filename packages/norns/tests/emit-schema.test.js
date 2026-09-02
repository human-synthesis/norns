import { describe, expect, test } from 'bun:test';

import { compile } from '@danielx/civet';

import { emitModuleSchema, initialState } from '../src/kernel/emit-schema.js';
import { ORDERS } from './kernel-fixtures.js';

describe('emitModuleSchema', () => {
	const file = emitModuleSchema('orders', ORDERS);

	test('emits to lib/<module>/schema.c', () => {
		expect(file.path).toBe('lib/orders/schema.c');
		expect(file.text).toContain('GENERATED');
	});

	// v6 K-42 — declared or provable, never alphabetical (the report's finding 02:
	// a cyclic open↔done→archived→open machine defaulted new rows to "archived").
	test('initialState honours `initial` and refuses ambiguous machines', () => {
		expect(initialState({ draft: ['sent'], sent: [] })).toBe('draft');
		const cyclic = { open: ['done', 'archived'], done: ['open', 'archived'], archived: ['open'] };
		expect(initialState(cyclic, 'open')).toBe('open');
		expect(() => initialState(cyclic)).toThrow(/INITIAL_AMBIGUOUS/);
		expect(() => initialState(cyclic, 'ghost')).toThrow(/not a declared status state/);

		const mod = {
			entities: {
				Task: { fields: { title: 'text' }, status: cyclic, initial: 'open' }
			}
		};
		expect(emitModuleSchema('tasks', mod).text).toContain(
			'status: text(\'status\').notNull().default("open")'
		);
	});

	test('drizzle table: pk, notNull, nullable optional, status default', () => {
		expect(file.text).toContain("export Order := sqliteTable('orders_order', {");
		expect(file.text).toContain("id: text('id').primaryKey()");
		expect(file.text).toContain("customer: text('customer').notNull()");
		expect(file.text).toContain("total: integer('total').notNull()"); // money = cents
		expect(file.text).toMatch(/note: text\('note'\)(,|\n)/); // optional → nullable
		expect(file.text).toContain('status: text(\'status\').notNull().default("draft")');
	});

	test('valibot schema, status picklist, Input without id', () => {
		expect(file.text).toContain('export OrderSchema := v.strictObject({');
		expect(file.text).toContain('note: v.optional(v.pipe(v.string(), v.maxLength(10000)))');
		expect(file.text).toContain('status: v.picklist(["cancelled","draft","paid","submitted"])');
		expect(file.text).toContain("export OrderInput := v.omit(OrderSchema, ['id'])");
		expect(file.text).toContain('export OrderStatus := ');
	});

	test('emitted Civet compiles', () => {
		const js = compile(file.text, { sync: true, js: true });
		expect(js).toContain('export const Order');
		expect(js).toContain('export const OrderSchema');
	});

	test('modules without entities emit nothing', () => {
		expect(emitModuleSchema('empty', { module: 'empty' })).toBeNull();
	});

	test('field name camelCase maps to snake_case columns', () => {
		const out = emitModuleSchema('m', {
			entities: { Thing: { fields: { orderId: { type: 'ref', ref: 'm.Entity.Other' } } } }
		});
		expect(out.text).toContain("orderId: text('order_id').notNull()");
	});

	test('postgres dialect emits pgTable with pg-core column builders', () => {
		const out = emitModuleSchema('orders', ORDERS, 'postgres');
		expect(out.text).toContain("import { pgTable");
		expect(out.text).toContain("from 'drizzle-orm/pg-core'");
		expect(out.text).toContain("export Order := pgTable('orders_order', {");
		expect(out.text).toContain("id: text('id').primaryKey()");
		expect(out.text).toContain("total: integer('total').notNull()");
		expect(out.text).toContain('status: text(\'status\').notNull().default("draft")');
		const js = compile(out.text, { sync: true, js: true });
		expect(js).toContain('export const Order');
	});

	test('postgres maps bool/date/number/json to native pg types', () => {
		const out = emitModuleSchema(
			'm',
			{
				entities: {
					Thing: {
						fields: {
							active: { type: 'bool' },
							due: { type: 'datetime', optional: true },
							score: { type: 'number' },
							meta: { type: 'json', optional: true }
						}
					}
				}
			},
			'postgres'
		);
		expect(out.text).toContain("active: boolean('active').notNull()");
		expect(out.text).toContain("due: timestamp('due', { mode: 'date' })");
		expect(out.text).toContain("score: doublePrecision('score').notNull()");
		expect(out.text).toContain("meta: jsonb('meta')");
		expect(out.text).toContain('import { pgTable, boolean, doublePrecision, jsonb, text, timestamp }');
	});

	test('sqlite and d1 dialects emit identical schemas', () => {
		expect(emitModuleSchema('orders', ORDERS, 'sqlite').text).toBe(
			emitModuleSchema('orders', ORDERS, 'd1').text
		);
	});

	test('unique and default modifiers', () => {
		const out = emitModuleSchema('m', {
			entities: {
				User: { fields: { email: { type: 'email', unique: true }, plan: { type: 'text', default: 'free' } } }
			}
		});
		expect(out.text).toContain("email: text('email').notNull().unique()");
		expect(out.text).toContain(".default(\"free\")");
		expect(out.text).toContain('email: v.pipe(v.string(), v.email())');
	});
});
