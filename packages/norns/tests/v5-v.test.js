// V5-V (K-39/K-40): create/delete steps + settings vocabulary.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSpec } from '@human-synthesis/norns-tron/spec';

import { layoutFile } from '../src/kernel/generate.js';
import { refineSpecs } from '../src/kernel/refine.js';
import { traceApp } from '../src/kernel/trace.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

const roots = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function appDir(orders, app = APP) {
	const root = mkdtempSync(join(tmpdir(), 'norns-v5v-'));
	roots.push(root);
	writeSpec(join(root, 'specs', 'app.tron'), app);
	writeSpec(join(root, 'specs', 'orders.tron'), orders);
	writeSpec(join(root, 'specs', 'catalog.tron'), CATALOG);
	return root;
}

function orders(actions) {
	const { price: _price, ...base } = ORDERS.actions;
	return { ...structuredClone(ORDERS), actions: { ...structuredClone(base), ...actions } };
}

describe('create step (K-39/D44)', () => {
	test('inserts with $user/$initial, returns the id, and the trace reads the row back', async () => {
		const spec = orders({
			add: {
				input: { total: 'Order.total' },
				steps: [
					{ create: { entity: 'Order', values: { total: 'input.total', customer: '$user', status: '$initial' } } },
					{ emit: 'order.created' }
				],
				examples: [{ input: { total: 7 }, expect: { total: 7, status: 'draft' } }]
			}
		});
		const root = appDir(spec);
		const report = await traceApp(join(root, 'specs'));
		const runs = report.cases.filter((c) => c.address === 'orders.Action.add');
		const authored = runs.find((c) => c.src === undefined);
		expect(authored.pass).toBe(true);
		expect(typeof authored.result.id).toBe('string');
		expect(authored.row.status).toBe('draft');
		expect(authored.events.map((e) => e.name)).toEqual(['order.created']);
		// derived denied-create: anonymous must be refused by the write policy
		const denied = runs.find((c) => c.derived?.includes('anonymous create'));
		expect(denied.pass).toBe(true);
	}, 30000);
});

describe('delete step (K-39/D44)', () => {
	test('deletes the targeted row behind the ownership guard, IDOR case derived', async () => {
		const spec = orders({
			purge: {
				input: { id: 'Order.id' },
				steps: [{ delete: { entity: 'Order', id: 'input.id' } }],
				examples: [{ input: { id: '$draft' }, expect: { ok: true } }]
			}
		});
		const root = appDir(spec);
		const report = await traceApp(join(root, 'specs'));
		const runs = report.cases.filter((c) => c.address === 'orders.Action.purge');
		expect(runs.find((c) => c.src === undefined).pass).toBe(true);
		const idor = runs.filter((c) => c.derived?.startsWith('permission'));
		expect(idor.length).toBe(2); // non-owner + anonymous, both refused
		for (const c of idor) expect(c.pass).toBe(true);
	}, 30000);

	test('a delete step on an unguarded entity is a validate error; clever values refused', () => {
		const spec = orders({
			purge: { input: { id: 'Order.id' }, steps: [{ delete: { entity: 'Order', id: 'input.id' } }] },
			add: {
				input: { total: 'Order.total' },
				steps: [{ create: { entity: 'Order', values: { total: { nested: true }, ghost: 'input.nope' } } }]
			}
		});
		delete spec.policies;
		const issues = refineSpecs({ app: APP, modules: { orders: spec, catalog: structuredClone(CATALOG) } });
		const messages = issues.map((i) => i.message);
		expect(messages.some((m) => m.includes('declare write authority'))).toBe(true);
		expect(messages.some((m) => m.includes('STEP_TOO_CLEVER'))).toBe(true);
		expect(messages.some((m) => m.includes('"input.nope" is not a declared input'))).toBe(true);
	});
});

describe('settings vocabulary (K-40/D45/D46)', () => {
	const withSettings = (settings) => ({ app: { ...APP, settings }, modules: { orders: structuredClone(ORDERS), catalog: structuredClone(CATALOG) } });

	test('serializer, shell nav, and seed rows are validated', () => {
		const issues = refineSpecs(
			withSettings({
				serializer: 'xml',
				shell: { nav: [{ group: 'Sales', pages: ['orders.Page.ghost'] }] },
				seed: { Order: [{ nope: 1 }], Ghost: [{}] }
			})
		);
		const messages = issues.map((i) => i.message);
		expect(messages.some((m) => m.includes('serializer must be'))).toBe(true);
		expect(messages.some((m) => m.includes('"orders.Page.ghost" is not a declared Page'))).toBe(true);
		expect(messages.some((m) => m.includes('"nope" is not a field of Order'))).toBe(true);
		expect(messages.some((m) => m.includes('unknown entity "Ghost"'))).toBe(true);

		expect(
			refineSpecs(
				withSettings({ serializer: 'tron', shell: { brand: 'Shop', nav: [{ pages: ['orders.Page.board'] }] }, seed: { Order: [{ total: 1 }] } })
			)
		).toEqual([]);
	});

	test('shell settings drive brand, order, and group headers in the layout', () => {
		const specs = withSettings({
			shell: { brand: 'Acme Ops', nav: [{ group: 'Sales', pages: ['orders.Page.board'] }] }
		});
		const layout = layoutFile(specs, false, false);
		expect(layout.text).toContain('Acme Ops');
		expect(layout.text).toContain('norns-nav-group');
		expect(layout.text).toContain('"head":"Sales"');
	});
});
