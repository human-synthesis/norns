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
