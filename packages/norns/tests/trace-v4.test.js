// V4-T2 (K-28/29/30): derived status cases, permission cases, query examples.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSpec } from '@human-synthesis/norns-tron/spec';

import { traceApp } from '../src/kernel/trace.js';
import { validateSpecs } from '../src/kernel/validate.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

const roots = [];

function appDir(orders) {
	const root = mkdtempSync(join(tmpdir(), 'norns-trace-v4-'));
	roots.push(root);
	writeSpec(join(root, 'specs', 'app.tron'), APP);
	writeSpec(join(root, 'specs', 'orders.tron'), orders);
	writeSpec(join(root, 'specs', 'catalog.tron'), CATALOG);
	return root;
}

// The shared fixture minus the custom-body action, so no src/ tree is needed.
function orders(overrides = {}) {
	const { price: _price, ...actions } = ORDERS.actions;
	// price is stripped, so its OrderTimeline event must go too (K-53 wires it
	// in the base fixture to keep every fixture action reachable).
	const components = structuredClone(ORDERS.components);
	delete components.OrderTimeline.events.reprice;
	return { ...ORDERS, actions, components, ...overrides };
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('derived status cases (K-28)', () => {
	test('every state without an edge to the target becomes a passing refusal case', async () => {
		const root = appDir(orders());
		const report = await traceApp(join(root, 'specs'));

		const submit = report.cases.filter((c) => c.address === 'orders.Action.submit');
		const derived = submit.filter((c) => c.src === 'derived');
		// machine: draft -> submitted only; submitted/paid/cancelled must refuse
		expect(derived.filter((c) => c.derived.startsWith('illegal-transition')).map((c) => c.derived).sort()).toEqual([
			'illegal-transition cancelled -> submitted',
			'illegal-transition paid -> submitted',
			'illegal-transition submitted -> submitted'
		]);
		// K-34: the ownership-guarded action also derives its permission matrix
		expect(derived.filter((c) => c.derived.startsWith('permission')).map((c) => c.as).sort()).toEqual([
			'anonymous',
			'other'
		]);
		for (const c of derived) expect(c.pass).toBe(true);
		// the authored example still runs and passes alongside
		expect(submit.find((c) => c.src === undefined)?.pass).toBe(true);
	}, 30000);

	test('an action that skips the guard fails its derived cases', async () => {
		// no `requires` — the runtime 409 machine guard is the only refusal left,
		// so the derived cases prove the generated shell enforces it.
		const spec = orders();
		spec.actions = { ...spec.actions, submit: { ...spec.actions.submit, requires: undefined } };
		delete spec.actions.submit.requires;
		const root = appDir(spec);
		const report = await traceApp(join(root, 'specs'));
		const derived = report.cases.filter(
			(c) => c.address === 'orders.Action.submit' && c.src === 'derived' && c.derived.startsWith('illegal')
		);
		expect(derived.length).toBe(3);
		for (const c of derived) {
			expect(c.pass).toBe(true);
			expect(c.status).toBe(409); // machine guard, not requires
		}
	}, 30000);

	test('opts.derived: false suppresses synthesis', async () => {
		const root = appDir(orders());
		const report = await traceApp(join(root, 'specs'), { derived: false });
		expect(report.cases.some((c) => c.src === 'derived')).toBe(false);
	}, 30000);
});

describe('permission cases (K-29)', () => {
	test('as: non-owner principals are denied by the ownership guard; owner passes', async () => {
		const spec = orders();
		spec.actions = {
			...spec.actions,
			submit: {
				...spec.actions.submit,
				examples: [
					{ input: { id: '$draft' }, expect: { status: 'submitted' } },
					{ as: 'other', input: { id: '$draft' }, expect: 'denied' },
					{ as: 'anonymous', input: { id: '$draft' }, expect: 'denied' },
					{ as: 'role:viewer', input: { id: '$draft' }, expect: 'denied' }
				]
			}
		};
		const root = appDir(spec);
		const report = await traceApp(join(root, 'specs'), { derived: false });
		const runs = report.cases.filter((c) => c.address === 'orders.Action.submit');
		expect(runs.length).toBe(4);
		expect(runs[0].pass).toBe(true);
		for (const denied of runs.slice(1)) {
			expect(denied.pass).toBe(true);
			expect(denied.as).toBeDefined();
		}
	}, 30000);

	test('a denial expectation that is NOT denied fails the case', async () => {
		const spec = orders();
		spec.actions = {
			...spec.actions,
			submit: {
				...spec.actions.submit,
				examples: [{ as: 'owner', input: { id: '$draft' }, expect: 'denied' }]
			}
		};
		const root = appDir(spec);
		const report = await traceApp(join(root, 'specs'), { derived: false });
		const run = report.cases.find((c) => c.address === 'orders.Action.submit');
		expect(run.pass).toBe(false);
		expect(run.error).toContain('expected denial');
	}, 30000);
});

describe('query examples (K-30)', () => {
	test('given rows seed the store; count/first expects check the result', async () => {
		const spec = orders({
			queries: {
				...ORDERS.queries,
				open: {
					from: 'Order',
					limit: 50,
					sort: 'total',
					examples: [
						{
							given: { Order: [{ total: 5, status: 'draft' }, { total: 9, status: 'paid' }] },
							expect: { count: 2, first: { total: 5 } }
						},
						{
							as: 'other',
							given: { Order: [{ total: 5 }] },
							expect: { count: 0 }
						}
					]
				}
			}
		});
		const root = appDir(spec);
		const report = await traceApp(join(root, 'specs'), { derived: false });
		const runs = report.cases.filter((c) => c.address === 'orders.Query.open');
		expect(runs.length).toBe(2);
		expect(runs[0].pass).toBe(true);
		// read policy 'owner or role:admin' filters a non-owner down to nothing
		expect(runs[1].pass).toBe(true);
	}, 30000);

	test('given rows with unknown fields are a validate error, not a trace surprise', () => {
		const spec = orders({
			queries: {
				open: {
					from: 'Order',
					limit: 5,
					examples: [{ given: { Order: [{ nope: 1 }] }, expect: { count: 1 } }]
				}
			}
		});
		const root = appDir(spec);
		const { issues } = validateSpecs(join(root, 'specs'));
		expect(issues.some((i) => i.level === 'error' && i.message.includes('"nope" is not a field of Order'))).toBe(
			true
		);
	});
});
