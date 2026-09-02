// V5-C1 (K-36/37, D40): app-local Component kind — page bindings, imports,
// and contract refusals.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { emitModulePages } from '../src/kernel/emit-units.js';
import { checkAppComponents } from '../src/kernel/generate.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

function specsWith(overrides = {}) {
	const orders = structuredClone(ORDERS);
	orders.components = {
		...orders.components,
		dealCard: { props: { items: 'orders.Query.board', compact: 'boolean?' }, events: { open: 'orders.Action.open' } }
	};
	Object.assign(orders, overrides);
	return { app: APP, modules: { orders, catalog: structuredClone(CATALOG) } };
}

describe('page bindings (K-37)', () => {
	test('primary {component, with} binds the unit by name with prop rules intact', () => {
		const specs = specsWith();
		specs.modules.orders.pages.board.components = [
			{ component: 'orders.Component.dealCard', with: { items: 'orders.Query.board', compact: true } }
		];
		const page = emitModulePages('orders', specs.modules.orders, specs).find((f) => f.path.endsWith('+page.n'));
		expect(page.text).toContain('DealCard(items!="{data.board}" compact!="{true}")');
		expect(page.text).toContain(`import DealCard from '$custom/orders/components/dealCard.n'`);
		// the bound query still loads server-side
		const server = emitModulePages('orders', specs.modules.orders, specs).find((f) =>
			f.path.endsWith('+page.server.c')
		);
		expect(server.text).toContain('board: await board(ctx)');
	});

	test('a Component address in a slot position passes the component as a renderer', () => {
		const specs = specsWith();
		specs.modules.orders.pages.board.components = [
			{ feed: 'orders.Query.board', item: 'orders.Component.dealCard' }
		];
		const page = emitModulePages('orders', specs.modules.orders, specs).find((f) => f.path.endsWith('+page.n'));
		expect(page.text).toContain('item!="{DealCard}"');
		expect(page.text).toContain(`import DealCard from '$custom/orders/components/dealCard.n'`);
	});
});

describe('contract refusals (K-36)', () => {
	test('unknown unit and undeclared with-prop are INVALID_BINDING', () => {
		const specs = specsWith();
		specs.modules.orders.pages.board.components = [
			{ component: 'orders.Component.nope', with: {} },
			{ component: 'orders.Component.dealCard', with: { wrong: 'x' } },
			{ feed: 'orders.Query.board', item: 'orders.Component.alsoNope' }
		];
		const refusals = checkAppComponents(specs);
		const codes = refusals.map((r) => r.code);
		expect(codes.filter((c) => c === 'INVALID_BINDING').length).toBe(3);
		expect(refusals[1].message).toContain('"wrong" is not a declared prop');
	});

	test('a declared Component without its .n body is COMPONENT_BODY_MISSING; with it, clean', () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-v5c1-'));
		try {
			const specs = specsWith();
			specs.dir = join(root, 'specs');
			specs.modules.orders.pages.board.components = [
				{ component: 'orders.Component.dealCard', with: { items: 'orders.Query.board' } }
			];
			expect(checkAppComponents(specs).map((r) => r.code)).toEqual(['COMPONENT_BODY_MISSING']);

			mkdirSync(join(root, 'src', 'orders', 'components'), { recursive: true });
			writeFileSync(join(root, 'src', 'orders', 'components', 'dealCard.n'), '.deal-card= "hi"\n');
			expect(checkAppComponents(specs)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
