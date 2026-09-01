import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirStorage, r2Storage } from '../src/server/storage.js';

/** Minimal in-memory R2Bucket fake (put/get/delete/list with pagination). */
function fakeBucket(pageSize = 2) {
	const objects = new Map();
	return {
		async put(key, data, opts) {
			objects.set(key, {
				data: typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data),
				contentType: opts?.httpMetadata?.contentType
			});
		},
		async get(key) {
			const o = objects.get(key);
			if (!o) return null;
			return {
				arrayBuffer: async () => o.data.buffer,
				httpMetadata: o.contentType ? { contentType: o.contentType } : undefined
			};
		},
		async delete(key) {
			objects.delete(key);
		},
		async list({ prefix = '', cursor }) {
			const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
			const start = cursor ? Number(cursor) : 0;
			const page = all.slice(start, start + pageSize);
			const truncated = start + pageSize < all.length;
			return {
				objects: page.map((key) => ({ key })),
				truncated,
				cursor: truncated ? String(start + pageSize) : undefined
			};
		}
	};
}

function contract(name, make) {
	describe(name, () => {
		const storage = make();

		test('put/get round-trips bytes and content type', async () => {
			await storage.put('orders/o1/invoice.pdf', new TextEncoder().encode('pdf-bytes'), {
				contentType: 'application/pdf'
			});
			const got = await storage.get('orders/o1/invoice.pdf');
			expect(new TextDecoder().decode(got.body)).toBe('pdf-bytes');
			expect(got.contentType).toBe('application/pdf');
		});

		test('get on a missing key returns null', async () => {
			expect(await storage.get('nope/missing')).toBeNull();
		});

		test('list filters by prefix and sorts', async () => {
			await storage.put('orders/o1/a.txt', 'a');
			await storage.put('orders/o2/b.txt', 'b');
			await storage.put('contacts/c1/c.txt', 'c');
			expect(await storage.list('orders/')).toEqual([
				'orders/o1/a.txt',
				'orders/o1/invoice.pdf',
				'orders/o2/b.txt'
			]);
		});

		test('delete removes the object', async () => {
			await storage.delete('orders/o1/invoice.pdf');
			expect(await storage.get('orders/o1/invoice.pdf')).toBeNull();
			expect(await storage.list('orders/')).toEqual(['orders/o1/a.txt', 'orders/o2/b.txt']);
		});
	});
}

const root = mkdtempSync(join(tmpdir(), 'norns-storage-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

contract('dirStorage', () => dirStorage(root));
contract('r2Storage (fake bucket, paginated list)', () => r2Storage(fakeBucket()));

describe('dirStorage key safety', () => {
	test('path traversal keys are rejected', async () => {
		const storage = dirStorage(root);
		await expect(storage.put('../evil.txt', 'x')).rejects.toThrow(/invalid key/);
		await expect(storage.get('../../etc/passwd')).rejects.toThrow(/invalid key/);
	});
});
