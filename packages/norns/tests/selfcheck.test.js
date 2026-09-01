import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSpec } from '@human-synthesis/norns-tron/spec';

import { EMITTERS, generateApp, selfCheck } from '../src/kernel/index.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

describe('selfCheck', () => {
	test('clean emitted output has no failures', () => {
		expect(selfCheck([{ path: 'lib/m/schema.c', text: `export X := { a: 1 }\n` }])).toEqual([]);
	});

	test('broken .c maps to the unit address', () => {
		const text = `export good := { a: 1 }\n\nexport bad := {\n\t::: nope\n}\n`;
		const [refusal] = selfCheck([{ path: 'lib/orders/actions.c', text }]);
		expect(refusal.code).toBe('SELFCHECK_FAILED');
		expect(refusal.address).toBe('orders.Action.bad');
		expect(refusal.path).toBe('lib/orders/actions.c');
	});

	test('broken .n script block is caught', () => {
		const text = `section\n\tp hi\n\n<script>\n\t::: nope\n</script>\n`;
		const [refusal] = selfCheck([{ path: 'routes/orders/+page.n', text }]);
		expect(refusal.code).toBe('SELFCHECK_FAILED');
	});

	test('non-code files are ignored', () => {
		expect(selfCheck([{ path: 'manifest.json', text: '{' }])).toEqual([]);
	});
});

describe('generateApp self-check integration', () => {
	test('a broken emitter refuses generation and writes nothing', () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-selfcheck-'));
		const dir = join(root, 'specs');
		writeSpec(join(dir, 'app.tron'), APP);
		writeSpec(join(dir, 'orders.tron'), ORDERS);
		writeSpec(join(dir, 'catalog.tron'), CATALOG);
		const broken = { name: 'broken', emit: () => [{ path: 'lib/orders/broken.c', text: '::: nope\n' }] };
		EMITTERS.push(broken);
		try {
			expect(() => generateApp(dir)).toThrow(/SELFCHECK_FAILED/);
			expect(existsSync(join(root, '.norns', 'generated', 'lib', 'orders', 'schema.c'))).toBe(false);
		} finally {
			EMITTERS.pop();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
