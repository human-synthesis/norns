import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSpec } from '@human-synthesis/norns-tron/spec';

import { checkGenerate, generateApp, loadSpecs, validateSpecs } from '../src/kernel/index.js';
import { ORDERS } from './kernel-fixtures.js';

function specsDir(files) {
	const root = mkdtempSync(join(tmpdir(), 'norns-kernel-'));
	const dir = join(root, 'specs');
	for (const [name, value] of Object.entries(files)) {
		writeSpec(join(dir, `${name}.tron`), value);
	}
	return { root, dir, done: () => rmSync(root, { recursive: true, force: true }) };
}

const APP = { name: 'demo', settings: { adapter: 'cloudflare' } };

describe('loadSpecs', () => {
	test('loads app + modules with a version hash', () => {
		const { dir, done } = specsDir({ app: APP, blog: { module: 'blog' } });
		try {
			const specs = loadSpecs(dir);
			expect(specs.app).toEqual(APP);
			expect(Object.keys(specs.modules)).toEqual(['blog']);
			expect(specs.version).toMatch(/^[0-9a-f]{64}$/);
		} finally {
			done();
		}
	});

	test('throws for a missing directory', () => {
		expect(() => loadSpecs('/nonexistent/specs')).toThrow(/no specs directory/);
	});
});

describe('validateSpecs', () => {
	test('valid specs pass', () => {
		const { dir, done } = specsDir({ app: APP, blog: { module: 'blog' } });
		try {
			const result = validateSpecs(dir);
			expect(result.ok).toBe(true);
			expect(result.issues).toEqual([]);
			expect(result.modules).toEqual(['blog']);
		} finally {
			done();
		}
	});

	test('missing app.tron is an error', () => {
		const { dir, done } = specsDir({ blog: { module: 'blog' } });
		try {
			const result = validateSpecs(dir);
			expect(result.ok).toBe(false);
			expect(result.issues).toContainEqual({
				level: 'error',
				address: 'app',
				message: expect.stringContaining('missing app.tron')
			});
		} finally {
			done();
		}
	});

	test('module field must match the file name', () => {
		const { dir, done } = specsDir({ app: APP, blog: { module: 'shop' } });
		try {
			const result = validateSpecs(dir);
			expect(result.ok).toBe(false);
			expect(result.issues[0].address).toBe('blog');
			expect(result.issues[0].message).toContain('"shop"');
		} finally {
			done();
		}
	});

	test('non-object module spec is an error', () => {
		const { dir, done } = specsDir({ app: APP, weird: [1, 2, 3] });
		try {
			const result = validateSpecs(dir);
			expect(result.ok).toBe(false);
			expect(result.issues[0].message).toContain('must be an object');
		} finally {
			done();
		}
	});
});

describe('checkGenerate (refusal engine)', () => {
	test('the golden orders module is not refused', () => {
		expect(checkGenerate({ modules: { orders: structuredClone(ORDERS) } })).toEqual([]);
	});

	test('an action writing an unguarded entity is refused with a fix', () => {
		const orders = structuredClone(ORDERS);
		delete orders.policies;
		const refusals = checkGenerate({ modules: { orders } });
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toMatchObject({
			address: 'orders.Action.submit',
			code: 'UNGUARDED_ACTION'
		});
		expect(refusals[0].fix).toContain('policies.Order');
	});

	test('an unbounded query is refused unless live, grouped or limited', () => {
		const orders = structuredClone(ORDERS);
		orders.queries.all = { from: 'Order' };
		const refusals = checkGenerate({ modules: { orders } });
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toMatchObject({ address: 'orders.Query.all', code: 'UNPAGINATED_QUERY' });

		orders.queries.all.limit = 50;
		expect(checkGenerate({ modules: { orders } })).toEqual([]);
	});

	test('a `transport: remote` action is refused until spiked', () => {
		const orders = structuredClone(ORDERS);
		orders.actions.submit.transport = 'remote';
		const refusals = checkGenerate({ modules: { orders } });
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toMatchObject({
			address: 'orders.Action.submit',
			path: 'orders.Action.submit.transport',
			code: 'UNSPIKED_TRANSPORT'
		});

		orders.actions.submit.transport = 'form';
		expect(checkGenerate({ modules: { orders } })).toEqual([]);
	});
});

describe('generateApp', () => {
	test('refuses to generate from an invalid spec', () => {
		const { dir, done } = specsDir({ blog: { module: 'blog' } });
		try {
			expect(() => generateApp(dir)).toThrow(/INVALID_SPEC/);
		} finally {
			done();
		}
	});

	test('valid spec writes a manifest and an incremental cache', () => {
		const { root, dir, done } = specsDir({ app: APP, blog: { module: 'blog' } });
		try {
			const first = generateApp(dir);
			expect(first.version).toMatch(/^[0-9a-f]{64}$/);
			expect(first.skipped).toEqual([]);
			const manifest = JSON.parse(
				readFileSync(join(root, '.norns', 'generated', 'manifest.json'), 'utf-8')
			);
			expect(manifest.version).toBe(first.version);

			const second = generateApp(dir);
			expect(second.skipped).toEqual(['blog']);
			expect(generateApp(dir, { force: true }).skipped).toEqual([]);
		} finally {
			done();
		}
	});
});
