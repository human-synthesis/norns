import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeSpec } from '@human-synthesis/norns-tron/spec';

import { absorbApp, absorbUnit, customBodyPath, customRatio, customUnits } from '../src/kernel/absorb.js';
import { traceApp } from '../src/kernel/trace.js';
import { validateSpecs } from '../src/kernel/validate.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

const ABSORBABLE_BODY = `// Custom body — expressible in the step vocabulary.
import { eq } from 'drizzle-orm'

import { Order } from '$lib/orders/schema.c'

export default async ({ input, container }) => {
	const db = container.resolve('db')
	await db.update(Order).set({ total: 100 }).where(eq(Order.id, input.id))
	await container.resolve('events').emit('order.priced', { row, input, user })
	return { total: 100 }
}
`;

const COMPUTED_BODY = `import { eq } from 'drizzle-orm'

import { Order } from '$lib/orders/schema.c'

export default async ({ input, container }) => {
	const db = container.resolve('db')
	const total = Math.round(input.total * 0.9)
	await db.update(Order).set({ total }).where(eq(Order.id, input.id))
	return { total }
}
`;

function specsOf(orders = ORDERS) {
	return { app: APP, modules: { orders, catalog: CATALOG } };
}

const cleanup = [];
afterAll(() => cleanup.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('absorbUnit', () => {
	test('literal set + emit + redundant return → proposed ops replacing the custom body', () => {
		const result = absorbUnit(specsOf(), 'orders.Action.price', ABSORBABLE_BODY);

		expect(result.absorbable).toBe(true);
		expect(result.steps).toEqual([
			{ set: { entity: 'Order', total: 100 } },
			{ emit: 'order.priced' }
		]);
		expect(result.ops).toEqual([
			{ op: 'set', path: 'orders.Action.price.steps', value: result.steps },
			{ op: 'remove', path: 'orders.Action.price.impl' }
		]);
		expect(result.notes.join(' ')).toContain('src/orders/actions/price.c');
		expect(result.notes.join(' ')).toContain('{ ok: true }');
	});

	test('applying the proposed ops yields a valid spec whose examples still pass in trace', async () => {
		const orders = structuredClone(ORDERS);
		const result = absorbUnit(specsOf(orders), 'orders.Action.price', ABSORBABLE_BODY);
		expect(result.absorbable).toBe(true);

		for (const op of result.ops) {
			const [, , , sub] = op.path.split('.');
			if (op.op === 'set') orders.actions.price[sub] = op.value;
			else delete orders.actions.price[sub];
		}
		expect(orders.actions.price.impl).toBeUndefined();

		const root = mkdtempSync(join(tmpdir(), 'norns-absorb-'));
		cleanup.push(root);
		writeSpec(join(root, 'specs', 'app.tron'), APP);
		writeSpec(join(root, 'specs', 'orders.tron'), orders);
		writeSpec(join(root, 'specs', 'catalog.tron'), CATALOG);

		const { issues } = await validateSpecs(join(root, 'specs'));
		expect(issues).toEqual([]);

		const report = await traceApp(join(root, 'specs'));
		const price = report.cases.find((c) => c.address === 'orders.Action.price');
		expect(price.pass).toBe(true);
		expect(price.row.total).toBe(100);
		expect(price.events.map((e) => e.name)).toContain('order.priced');
	}, 30000);

	test('computed values are out of vocabulary — conservative refusal with the statement', () => {
		const result = absorbUnit(specsOf(), 'orders.Action.price', COMPUTED_BODY);
		expect(result.absorbable).toBe(false);
		expect(result.reason).toContain('Math.round');
	});

	test('foreign imports are out of vocabulary', () => {
		const body = ABSORBABLE_BODY.replace(
			"import { eq } from 'drizzle-orm'",
			"import { eq } from 'drizzle-orm'\nimport slug from 'slugify'"
		);
		const result = absorbUnit(specsOf(), 'orders.Action.price', body);
		expect(result.absorbable).toBe(false);
		expect(result.reason).toContain('slugify');
	});

	test('a return that is not derivable from the steps blocks absorption', () => {
		const body = ABSORBABLE_BODY.replace('return { total: 100 }', 'return { total: 90 }');
		const result = absorbUnit(specsOf(), 'orders.Action.price', body);
		expect(result.absorbable).toBe(false);
		expect(result.reason).toContain('{ ok: true }');
	});

	test('non-custom units and missing bodies are refused, not guessed', () => {
		expect(absorbUnit(specsOf(), 'orders.Action.submit', ABSORBABLE_BODY).reason).toContain('already generated');
		expect(absorbUnit(specsOf(), 'orders.Action.price', null).reason).toContain('src/orders/actions/price.c');
		expect(absorbUnit(specsOf(), 'orders.Action.nope', ABSORBABLE_BODY).reason).toContain('no Action unit');
	});

	test('custom pages are surfaced but never analysed', () => {
		const orders = structuredClone(ORDERS);
		orders.pages.board.impl = 'custom';
		const result = absorbUnit(specsOf(orders), 'orders.Page.board', '<h1>hi</h1>');
		expect(result.absorbable).toBe(false);
		expect(result.reason).toContain('page bodies');
	});
});

describe('custom-ratio health metric', () => {
	test('counts custom units per module and surfaces past the threshold', () => {
		const ratio = customRatio(specsOf());
		expect(ratio.modules.orders.custom).toBe(1);
		expect(ratio.modules.orders.total).toBeGreaterThan(4);
		expect(ratio.modules.orders.surfaced).toBe(false);
		expect(ratio.modules.catalog.custom).toBe(0);
		expect(ratio.app.custom).toBe(1);

		const noisy = structuredClone(ORDERS);
		noisy.actions.open.impl = 'custom';
		noisy.actions.cancelLineItems.impl = 'custom';
		noisy.pages.board.impl = 'custom';
		const surfaced = customRatio(specsOf(noisy));
		expect(surfaced.modules.orders.custom).toBe(4);
		expect(surfaced.modules.orders.surfaced).toBe(true);
	});
});

describe('absorbApp', () => {
	test('scans every custom unit through readSource and pairs verdicts with the ratio', () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-absorb-app-'));
		cleanup.push(root);
		mkdirSync(join(root, 'src', 'orders', 'actions'), { recursive: true });
		writeFileSync(join(root, 'src', 'orders', 'actions', 'price.c'), ABSORBABLE_BODY);

		const specs = specsOf();
		expect(customUnits(specs).map((u) => u.address)).toEqual(['orders.Action.price']);
		expect(customBodyPath('orders.Action.price')).toBe('src/orders/actions/price.c');

		const { candidates, ratio } = absorbApp(specs, (rel) => {
			try {
				return require('node:fs').readFileSync(join(root, rel), 'utf8');
			} catch {
				return null;
			}
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0].address).toBe('orders.Action.price');
		expect(candidates[0].absorbable).toBe(true);
		expect(ratio.app.custom).toBe(1);
	});
});
