import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSpec } from '@human-synthesis/norns-tron/spec';

import { traceApp } from '../src/kernel/trace.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

const PRICE_BODY = `import { Order } from '$lib/orders/schema.c'
import { eq } from 'drizzle-orm'

export default async ({ row, input, container }) => {
	db := container.resolve('db')
	await db.update(Order).set({ total: 100 }).where(eq(Order.id, input.id))
	return { total: 100 }
}
`;

function appDir({ orders = ORDERS, priceBody = PRICE_BODY } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'norns-trace-'));
	writeSpec(join(root, 'specs', 'app.tron'), APP);
	writeSpec(join(root, 'specs', 'orders.tron'), orders);
	writeSpec(join(root, 'specs', 'catalog.tron'), CATALOG);
	if (priceBody) {
		mkdirSync(join(root, 'src', 'orders', 'actions'), { recursive: true });
		writeFileSync(join(root, 'src', 'orders', 'actions', 'price.c'), priceBody);
	}
	return root;
}

const cleanup = [];
afterAll(() => cleanup.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('traceApp', () => {
	test('runs every example: generated + custom actions pass end-to-end', async () => {
		const root = appDir();
		cleanup.push(root);
		const report = await traceApp(join(root, 'specs'));

		expect(report.fail).toBe(0);
		expect(report.pass).toBe(2);
		const byAddress = Object.fromEntries(report.cases.map((c) => [c.address, c]));

		const submit = byAddress['orders.Action.submit'];
		expect(submit.pass).toBe(true);
		expect(submit.row.status).toBe('submitted');
		expect(submit.events.map((e) => e.name)).toEqual(['order.submitted']);

		const price = byAddress['orders.Action.price'];
		expect(price.pass).toBe(true);
		expect(price.result).toEqual({ total: 100 });
		expect(price.row.total).toBe(100);
	}, 30000);

	test('a wrong expectation is reported as a failing case with step values', async () => {
		const orders = structuredClone(ORDERS);
		orders.actions.submit.examples = [{ input: { id: '$draft' }, expect: { status: 'paid' } }];
		const root = appDir({ orders });
		cleanup.push(root);
		const report = await traceApp(join(root, 'specs'));

		const submit = report.cases.find((c) => c.address === 'orders.Action.submit');
		expect(submit.pass).toBe(false);
		expect(submit.row.status).toBe('submitted');
		expect(report.fail).toBe(1);
	}, 30000);

	test('an illegal transition example fails with the machine 409', async () => {
		const orders = structuredClone(ORDERS);
		// paid is a terminal state — submit's draft→submitted edge cannot fire
		orders.actions.submit.examples = [{ input: { id: '$paid' }, expect: { status: 'submitted' } }];
		const root = appDir({ orders });
		cleanup.push(root);
		const report = await traceApp(join(root, 'specs'));

		const submit = report.cases.find((c) => c.address === 'orders.Action.submit');
		expect(submit.pass).toBe(false);
		expect(submit.status).toBe(409);
	}, 30000);

	test('a missing custom body fails its case, not the run', async () => {
		const root = appDir({ priceBody: null });
		cleanup.push(root);
		const report = await traceApp(join(root, 'specs'));

		const price = report.cases.find((c) => c.address === 'orders.Action.price');
		expect(price.pass).toBe(false);
		expect(price.error).toContain('missing custom body');
		// other cases still ran
		expect(report.cases.find((c) => c.address === 'orders.Action.submit').pass).toBe(true);
	}, 30000);
});
