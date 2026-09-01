import { describe, test, expect } from 'bun:test';
import { withTransaction } from '../src/server/db.js';

describe('withTransaction', () => {
	test('delegates to db.transaction with the callback', async () => {
		const calls = [];
		const fakeDb = {
			transaction: (fn) => {
				calls.push('opened');
				const tx = { kind: 'tx', insert: () => calls.push('insert') };
				return Promise.resolve(fn(tx)).then((value) => {
					calls.push('committed');
					return value;
				});
			}
		};

		const result = await withTransaction(fakeDb, async (tx) => {
			tx.insert();
			return 'done';
		});

		expect(result).toBe('done');
		expect(calls).toEqual(['opened', 'insert', 'committed']);
	});

	test('propagates rejection from db.transaction', async () => {
		const fakeDb = {
			transaction: (fn) => Promise.resolve().then(() => fn({})).then(() => {
				throw new Error('rolled back');
			})
		};
		await expect(withTransaction(fakeDb, async () => 'x')).rejects.toThrow('rolled back');
	});
});

describe('applyMigrations', () => {
	const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
	const { join } = require('node:path');
	const { tmpdir } = require('node:os');

	test('applies module sql files once, in order, split on statement-breakpoint', async () => {
		const { betterSqlite, applyMigrations } = await import('../src/server/db.js');
		const root = mkdtempSync(join(tmpdir(), 'norns-mig-'));
		try {
			mkdirSync(join(root, 'tasks', 'meta'), { recursive: true });
			writeFileSync(
				join(root, 'tasks', '0000_init.sql'),
				'CREATE TABLE "t" ("id" text PRIMARY KEY);\n--> statement-breakpoint\nCREATE INDEX "t_id" ON "t" ("id");\n'
			);
			writeFileSync(join(root, 'tasks', '0001_more.sql'), 'ALTER TABLE "t" ADD "note" text;\n');
			writeFileSync(join(root, 'tasks', 'meta', '_journal.json'), '{}');

			const db = await betterSqlite(':memory:');
			const first = await applyMigrations(db, root);
			expect(first).toEqual(['tasks/0000_init.sql', 'tasks/0001_more.sql']);

			const again = await applyMigrations(db, root);
			expect(again).toEqual([]);

			const { sql } = await import('drizzle-orm');
			await db.run(sql.raw(`INSERT INTO "t" ("id", "note") VALUES ('a', 'hi')`));
			const rows = await db.all(sql.raw('SELECT * FROM "t"'));
			expect(rows).toEqual([{ id: 'a', note: 'hi' }]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
