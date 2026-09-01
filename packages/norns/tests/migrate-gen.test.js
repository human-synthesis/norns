import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { writeSpec } from '@human-synthesis/norns-tron/spec';

import { migrateApp } from '../src/kernel/index.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

function nearestNodeModules() {
	let dir = import.meta.dir;
	while (!existsSync(join(dir, 'node_modules', 'drizzle-orm'))) {
		const parent = dirname(dir);
		if (parent === dir) throw new Error('no node_modules with drizzle-orm above tests/');
		dir = parent;
	}
	return join(dir, 'node_modules');
}

// drizzle-kit resolves the compiled schema's imports from the app root,
// so the throwaway app needs a node_modules link.
function appDir(files) {
	const root = mkdtempSync(join(tmpdir(), 'norns-migrate-'));
	symlinkSync(nearestNodeModules(), join(root, 'node_modules'));
	const dir = join(root, 'specs');
	for (const [name, value] of Object.entries(files)) {
		writeSpec(join(dir, `${name}.tron`), value);
	}
	return { root, dir };
}

function sqlIn(root, module) {
	const dir = join(root, 'migrations', module);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

describe('migrateApp', () => {
	const { root, dir } = appDir({ app: APP, orders: ORDERS, catalog: CATALOG });
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	test('first run creates CREATE TABLE migrations per module', () => {
		const result = migrateApp(dir);
		expect(Object.keys(result.created).sort()).toEqual(['catalog', 'orders']);
		const files = sqlIn(root, 'orders');
		expect(files.length).toBe(1);
		expect(files[0]).toMatch(/^0000_.+\.sql$/);
		const sql = readFileSync(join(root, 'migrations', 'orders', files[0]), 'utf-8');
		expect(sql).toContain('CREATE TABLE `orders_order`');
		expect(sql).toContain("`status` text DEFAULT 'draft' NOT NULL");
		expect(existsSync(join(root, 'migrations', 'orders', 'meta', '_journal.json'))).toBe(true);
	});

	test('second run with unchanged specs creates nothing', () => {
		const result = migrateApp(dir);
		expect(result.created).toEqual({});
		expect(result.unchanged.sort()).toEqual(['catalog', 'orders']);
		expect(sqlIn(root, 'orders').length).toBe(1);
	});

	test('adding a field yields an additive ALTER migration', () => {
		const withNotes = structuredClone(ORDERS);
		withNotes.entities.Order.fields.trackingCode = { type: 'text', optional: true };
		writeSpec(join(dir, 'orders.tron'), withNotes);

		const result = migrateApp(dir);
		expect(Object.keys(result.created)).toEqual(['orders']);
		const files = sqlIn(root, 'orders');
		expect(files.length).toBe(2);
		const sql = readFileSync(join(root, 'migrations', 'orders', files[1]), 'utf-8');
		expect(sql).toContain('ALTER TABLE `orders_order` ADD `tracking_code` text');
	});

	test('removing a field is refused as destructive, leaving migrations untouched', () => {
		writeSpec(join(dir, 'orders.tron'), ORDERS);
		expect(() => migrateApp(dir)).toThrow(/DESTRUCTIVE_MIGRATION/);
		expect(sqlIn(root, 'orders').length).toBe(2);
	});

	test('force applies the destructive migration', () => {
		const result = migrateApp(dir, { force: true });
		expect(Object.keys(result.created)).toEqual(['orders']);
		const files = sqlIn(root, 'orders');
		expect(files.length).toBe(3);
		const sql = readFileSync(join(root, 'migrations', 'orders', files[2]), 'utf-8');
		expect(sql).toMatch(/DROP COLUMN|__new_/);
	});

	test('postgres dialect produces pg SQL through the same pipeline', () => {
		const pg = appDir({ app: { ...APP, dialect: 'postgres' }, orders: ORDERS, catalog: CATALOG });
		try {
			const result = migrateApp(pg.dir);
			expect(result.created.orders?.length).toBe(1);
			const sql = readFileSync(
				join(pg.root, 'migrations', 'orders', result.created.orders[0]),
				'utf-8'
			);
			expect(sql).toContain('CREATE TABLE "orders_order"');
			expect(sql).toContain('"total" integer NOT NULL');
			expect(sql).toContain(`"status" text DEFAULT 'draft' NOT NULL`);
			expect(sql).not.toContain('`orders_order`'); // no sqlite quoting
		} finally {
			rmSync(pg.root, { recursive: true, force: true });
		}
	}, 30_000);

	test('migration names carry the module spec hash prefix', () => {
		const files = sqlIn(root, 'orders');
		expect(files[0]).toMatch(/^0000_[0-9a-f]{8}\.sql$/);
	});
});
