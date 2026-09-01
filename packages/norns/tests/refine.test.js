import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSpec } from '@human-synthesis/norns-tron/spec';

import { refineSpecs } from '../src/kernel/refine.js';
import { validateSpecs } from '../src/kernel/index.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

const clone = () => structuredClone({ app: APP, modules: { orders: ORDERS, catalog: CATALOG } });
const messages = (issues) => issues.map((i) => `${i.address}: ${i.message}`).join('\n');

describe('refineSpecs', () => {
	test('golden fixture has no refinement issues', () => {
		expect(refineSpecs(clone())).toEqual([]);
	});

	test('depends must name loaded modules (core is external-by-convention)', () => {
		const specs = clone();
		specs.modules.orders.depends = ['core', 'nope'];
		expect(messages(refineSpecs(specs))).toContain('unknown module "nope"');
	});

	test('depends cycles are reported', () => {
		const specs = clone();
		specs.modules.catalog.depends = ['orders'];
		expect(messages(refineSpecs(specs))).toContain('cycle');
	});

	test('entity owner must be a field', () => {
		const specs = clone();
		specs.modules.orders.entities.Order.owner = 'ghost';
		expect(messages(refineSpecs(specs))).toContain('owner "ghost"');
	});

	test('ref fields must resolve; external declared modules are skipped', () => {
		const specs = clone();
		specs.modules.orders.entities.Order.fields.customer.ref = 'catalog.Entity.Vendor';
		expect(messages(refineSpecs(specs))).toContain('does not resolve');

		const external = clone();
		external.modules.orders.entities.Order.fields.customer.ref = 'core.Entity.Session';
		expect(refineSpecs(external)).toEqual([]); // core is declared in depends

		const undeclared = clone();
		undeclared.modules.orders.entities.Order.fields.customer.ref = 'billing.Entity.Invoice';
		expect(messages(refineSpecs(undeclared))).toContain('unknown module "billing"');
	});

	test('ref must point at the right kind', () => {
		const specs = clone();
		specs.modules.orders.queries.board.from = 'orders.Action.submit';
		expect(messages(refineSpecs(specs))).toContain('must reference a Entity');
	});

	test('status transitions must target declared states', () => {
		const specs = clone();
		specs.modules.orders.entities.Order.status.draft.push('refunded');
		expect(messages(refineSpecs(specs))).toContain('draft -> refunded');
	});

	test('refresh must resolve to queries', () => {
		const specs = clone();
		specs.modules.orders.actions.submit.refresh = ['orders.Query.ghost'];
		expect(messages(refineSpecs(specs))).toContain('orders.Query.ghost');
	});

	test('transport: remote is refused until the spike flag is set', () => {
		const specs = clone();
		specs.modules.orders.actions.submit.transport = 'remote';
		expect(messages(refineSpecs(specs))).toContain('transport: remote is not enabled');
		specs.app = { ...APP, settings: { remoteTransport: true } };
		expect(refineSpecs(specs)).toEqual([]);
	});

	test('policies must match an entity; run keys must be actions', () => {
		const specs = clone();
		specs.modules.orders.policies.Ghost = { read: 'owner' };
		expect(messages(refineSpecs(specs))).toContain('policy "Ghost"');

		const run = clone();
		run.modules.orders.policies.Order.run = { ghost: 'role:admin' };
		expect(messages(refineSpecs(run))).toContain('run "ghost"');
	});

	test('page component bindings that look like addresses must resolve', () => {
		const specs = clone();
		specs.modules.orders.pages.board.components[0].kanban = 'orders.Query.ghost';
		expect(messages(refineSpecs(specs))).toContain('components.kanban');
	});

	test('triggers and component events must point at real actions', () => {
		const specs = clone();
		specs.modules.orders.triggers['catalog.Product.deleted'] = 'orders.Action.ghost';
		expect(messages(refineSpecs(specs))).toContain('orders.Action.ghost');

		const ev = clone();
		ev.modules.orders.components.OrderTimeline.events.select = 'orders.Action.ghost';
		expect(messages(refineSpecs(ev))).toContain('events.select');
	});
});

// K-06 gate: `validate` must reject every fixture in this corpus.
const INVALID_CORPUS = [
	['module field mismatch', (m) => (m.orders.module = 'oops')],
	['unknown collection key', (m) => (m.orders.action = {})],
	['bad field type', (m) => (m.orders.entities.Order.fields.total = 'moneyz')],
	['ref without ref target', (m) => (m.orders.entities.Order.fields.customer = { type: 'ref' })],
	['owner not a field', (m) => (m.orders.entities.Order.owner = 'nobody')],
	['open status machine', (m) => (m.orders.entities.Order.status.paid = ['refunded'])],
	['query from missing', (m) => delete m.orders.queries.board.from],
	['query from unresolved', (m) => (m.orders.queries.board.from = 'Ghost')],
	['bad filter expression', (m) => (m.orders.queries.board.filter = 'status = draft')],
	['bad requires expression', (m) => (m.orders.actions.submit.requires = 'status == ')],
	['refresh not an address', (m) => (m.orders.actions.submit.refresh = ['board'])],
	['refresh unresolved', (m) => (m.orders.actions.submit.refresh = ['orders.Query.ghost'])],
	['impl custom without examples', (m) => delete m.orders.actions.price.examples],
	['remote transport while gated', (m) => (m.orders.actions.submit.transport = 'remote')],
	['policy without entity', (m) => (m.orders.policies.Ghost = { read: 'owner' })],
	['policy bad expression', (m) => (m.orders.policies.Order.read = 'owner or or')],
	['page route without slash', (m) => (m.orders.pages.board.route = 'orders')],
	['page binding unresolved', (m) => (m.orders.pages.board.components[0].onMove = 'orders.Action.ghost')],
	['trigger to missing action', (m) => (m.orders.triggers['catalog.Product.deleted'] = 'orders.Action.ghost')],
	['trigger not an address', (m) => (m.orders.triggers['catalog.Product.deleted'] = 'cancel')],
	['component event unresolved', (m) => (m.orders.components.OrderTimeline.events.select = 'orders.Action.ghost')],
	['depends unknown module', (m) => (m.orders.depends = ['ghosts'])],
	['depends cycle', (m) => (m.catalog.depends = ['orders'])],
	['duplicate uid', (m) => (m.catalog.entities.Product.uid = m.orders.entities.Order.uid)],
	['bad uid', (m) => (m.orders.entities.Order.uid = 'nope')]
];

describe('invalid-fixture corpus (phase-0 gate)', () => {
	for (const [label, mutate] of INVALID_CORPUS) {
		test(`rejects: ${label}`, () => {
			const modules = structuredClone({ orders: ORDERS, catalog: CATALOG });
			mutate(modules);
			const dir = mkdtempSync(join(tmpdir(), 'norns-corpus-'));
			try {
				writeSpec(join(dir, 'app.tron'), APP);
				for (const [name, spec] of Object.entries(modules)) {
					writeSpec(join(dir, `${name}.tron`), spec);
				}
				const result = validateSpecs(dir);
				expect(result.ok).toBe(false);
				expect(result.issues.some((i) => i.level === 'error')).toBe(true);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});
