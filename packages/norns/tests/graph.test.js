import { describe, expect, test } from 'bun:test';

import { specHash } from '@human-synthesis/norns-tron/spec';

import {
	buildGraph,
	createGraphCache,
	impact,
	moduleEdges,
	neighborhood,
	updateGraph
} from '../src/kernel/graph.js';
import { CATALOG, ORDERS } from './kernel-fixtures.js';

const MODULES = { orders: ORDERS, catalog: CATALOG };
const has = (edges, from, to, type) =>
	edges.some((e) => e.from === from && e.to === to && e.type === type);

describe('moduleEdges', () => {
	const edges = moduleEdges('orders', ORDERS);

	test('derives the PLAN §4.3 edge kinds', () => {
		expect(has(edges, 'orders.Query.board', 'orders.Entity.Order', 'reads')).toBe(true);
		expect(has(edges, 'orders.Action.submit', 'orders.Entity.Order', 'writes')).toBe(true);
		expect(has(edges, 'orders.Action.submit', 'event:order.submitted', 'emits')).toBe(true);
		expect(has(edges, 'orders.Action.submit', 'orders.Query.board', 'refreshes')).toBe(true);
		expect(has(edges, 'orders.Page.board', 'orders.Query.board', 'binds')).toBe(true);
		expect(has(edges, 'orders.Page.board', 'orders.Action.submit', 'binds')).toBe(true);
		expect(has(edges, 'orders.Policy.Order', 'orders.Entity.Order', 'guards')).toBe(true);
		expect(
			has(edges, 'event:catalog.Product.deleted', 'orders.Trigger.catalog.Product.deleted', 'on')
		).toBe(true);
		expect(
			has(
				edges,
				'orders.Trigger.catalog.Product.deleted',
				'orders.Action.cancelLineItems',
				'calls'
			)
		).toBe(true);
		expect(has(edges, 'orders.Component.OrderTimeline', 'orders.Action.open', 'calls')).toBe(true);
	});

	test('modules without cross-refs produce no edges', () => {
		expect(moduleEdges('catalog', CATALOG)).toEqual([]);
	});
});

describe('buildGraph / neighborhood / impact', () => {
	const graph = buildGraph(MODULES);

	test('outbound and inbound maps agree with the edge list', () => {
		const out = graph.outbound.get('orders.Action.submit') ?? [];
		expect(out.map((e) => e.type).sort()).toEqual(['emits', 'refreshes', 'writes']);
		const into = graph.inbound.get('orders.Query.board') ?? [];
		expect(into.map((e) => e.from).sort()).toEqual(['orders.Action.submit', 'orders.Page.board']);
	});

	test('neighborhood at depth 1 is the direct context', () => {
		const n = neighborhood(graph, 'orders.Query.board', 1);
		expect(n).toEqual(
			new Set([
				'orders.Query.board',
				'orders.Entity.Order',
				'orders.Action.submit',
				'orders.Page.board'
			])
		);
	});

	test('neighborhood grows with depth', () => {
		const n2 = neighborhood(graph, 'orders.Entity.Order', 2);
		expect(n2.has('orders.Page.board')).toBe(true); // Entity <- Query <- Page
		expect(n2.has('event:order.submitted')).toBe(true); // Entity <- Action -> event
	});

	test('impact follows inbound edges transitively', () => {
		const hit = impact(graph, 'orders.Entity.Order');
		expect(hit.has('orders.Query.board')).toBe(true);
		expect(hit.has('orders.Page.board')).toBe(true); // via the query
		expect(hit.has('orders.Policy.Order')).toBe(true);
		expect(hit.has('orders.Entity.Order')).toBe(false);
	});
});

describe('updateGraph (incremental)', () => {
	test('only re-derives modules whose hash changed', () => {
		const cache = createGraphCache();
		const hashes = { orders: specHash(ORDERS), catalog: specHash(CATALOG) };
		const first = updateGraph(cache, MODULES, hashes);
		expect(first.changed.sort()).toEqual(['catalog', 'orders']);
		expect(first.graph.edges).toEqual(buildGraph(MODULES).edges);

		const again = updateGraph(cache, MODULES, hashes);
		expect(again.changed).toEqual([]);
		expect(again.graph.edges).toEqual(first.graph.edges);

		const mutated = structuredClone(MODULES);
		mutated.catalog.queries = { list: { from: 'Product' } };
		const after = updateGraph(cache, mutated, {
			orders: hashes.orders,
			catalog: specHash(mutated.catalog)
		});
		expect(after.changed).toEqual(['catalog']);
		expect(has(after.graph.edges, 'catalog.Query.list', 'catalog.Entity.Product', 'reads')).toBe(
			true
		);
	});

	test('removed modules drop their edges', () => {
		const cache = createGraphCache();
		const hashes = { orders: specHash(ORDERS), catalog: specHash(CATALOG) };
		updateGraph(cache, MODULES, hashes);
		const after = updateGraph(cache, { catalog: CATALOG }, { catalog: hashes.catalog });
		expect(after.changed).toEqual(['orders']);
		expect(after.graph.edges.every((e) => !e.from.startsWith('orders.'))).toBe(true);
	});
});
