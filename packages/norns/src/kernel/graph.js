/**
 * Spec edge graph (K-07) — derived, never stored (PLAN §4.3).
 *
 * Nodes are unit addresses plus `event:<name>` nodes for the emit/on
 * namespace. Edges are derived per module, so incremental invalidation is
 * a per-module cache keyed by the module's spec hash. Code edges (custom
 * body imports via civet-bridge) are appended by the MCP indexer later —
 * this module covers the spec-derived edges.
 *
 * Edge types: reads · writes · binds · guards · emits · on · calls · refreshes
 */

import { formatAddress, isAddress, listUnits } from './address.js';

/** @typedef {{ from: string, to: string, type: string }} Edge */

const eventNode = (name) => `event:${name}`;

/** Resolve a written ref to a full address: bare names bind in-module. */
function refAddress(moduleName, kind, ref) {
	if (typeof ref !== 'string' || ref === '') return null;
	if (isAddress(ref)) return ref;
	return formatAddress({ module: moduleName, kind, name: ref.split('.')[0] });
}

/**
 * Derive all edges that originate from one module's units.
 *
 * @param {string} moduleName
 * @param {*} moduleSpec
 * @returns {Edge[]}
 */
export function moduleEdges(moduleName, moduleSpec) {
	/** @type {Edge[]} */
	const edges = [];
	const add = (from, to, type) => {
		if (to) edges.push({ from, to, type });
	};

	for (const unit of listUnits(moduleName, moduleSpec)) {
		const { address: at, value, kind, name } = unit;
		switch (kind) {
			case 'Query':
				add(at, refAddress(moduleName, 'Entity', value?.from), 'reads');
				break;
			case 'Action': {
				for (const step of Array.isArray(value?.steps) ? value.steps : []) {
					if (step === null || typeof step !== 'object') continue;
					for (const [stepKind, stepValue] of Object.entries(step)) {
						if (stepKind === 'emit' && typeof stepValue === 'string') {
							add(at, eventNode(stepValue), 'emits');
						} else if (typeof stepValue?.entity === 'string') {
							add(at, refAddress(moduleName, 'Entity', stepValue.entity), 'writes');
						} else if (stepKind === 'call' && typeof stepValue === 'string') {
							add(at, refAddress(moduleName, 'Function', stepValue), 'calls');
						}
					}
				}
				for (const ev of Array.isArray(value?.emits) ? value.emits : []) {
					if (typeof ev === 'string') add(at, eventNode(ev), 'emits');
				}
				for (const q of Array.isArray(value?.refresh) ? value.refresh : []) {
					add(at, refAddress(moduleName, 'Query', q), 'refreshes');
				}
				break;
			}
			case 'Page': {
				for (const comp of Array.isArray(value?.components) ? value.components : []) {
					if (comp === null || typeof comp !== 'object') continue;
					for (const bound of Object.values(comp)) {
						if (typeof bound === 'string' && isAddress(bound)) add(at, bound, 'binds');
					}
				}
				break;
			}
			case 'Policy': {
				add(at, formatAddress({ module: moduleName, kind: 'Entity', name }), 'guards');
				for (const actionName of Object.keys(value?.run ?? {})) {
					add(at, refAddress(moduleName, 'Action', actionName), 'guards');
				}
				break;
			}
			case 'Trigger': {
				add(eventNode(name), at, 'on');
				const action = typeof value === 'string' ? value : value?.action;
				add(at, refAddress(moduleName, 'Action', action), 'calls');
				break;
			}
			case 'Component': {
				for (const target of Object.values(value?.events ?? {})) {
					add(at, refAddress(moduleName, 'Action', target), 'calls');
				}
				break;
			}
		}
	}
	return edges;
}

/**
 * @typedef {{
 *   edges: Edge[],
 *   outbound: Map<string, Edge[]>,
 *   inbound: Map<string, Edge[]>
 * }} Graph
 */

/** @param {Edge[]} edges @returns {Graph} */
function assemble(edges) {
	const outbound = new Map();
	const inbound = new Map();
	for (const edge of edges) {
		if (!outbound.has(edge.from)) outbound.set(edge.from, []);
		outbound.get(edge.from).push(edge);
		if (!inbound.has(edge.to)) inbound.set(edge.to, []);
		inbound.get(edge.to).push(edge);
	}
	return { edges, outbound, inbound };
}

/**
 * Build the full graph from scratch.
 *
 * @param {Record<string, *>} modules
 * @returns {Graph}
 */
export function buildGraph(modules) {
	const edges = [];
	for (const [name, spec] of Object.entries(modules)) edges.push(...moduleEdges(name, spec));
	return assemble(edges);
}

/** @returns {{ hashes: Record<string, string>, edges: Record<string, Edge[]> }} */
export function createGraphCache() {
	return { hashes: {}, edges: {} };
}

/**
 * Incrementally update the graph: only modules whose hash changed are
 * re-derived; removed modules drop out. Mutates and returns the cache.
 *
 * @param {{ hashes: Record<string, string>, edges: Record<string, Edge[]> }} cache
 * @param {Record<string, *>} modules
 * @param {Record<string, string>} hashes per-module spec hashes (e.g. from readSpecs)
 * @returns {{ graph: Graph, changed: string[] }}
 */
export function updateGraph(cache, modules, hashes) {
	const changed = [];
	for (const name of Object.keys(cache.edges)) {
		if (!(name in modules)) {
			delete cache.edges[name];
			delete cache.hashes[name];
			changed.push(name);
		}
	}
	for (const [name, spec] of Object.entries(modules)) {
		if (cache.hashes[name] !== hashes[name]) {
			cache.edges[name] = moduleEdges(name, spec);
			cache.hashes[name] = hashes[name];
			changed.push(name);
		}
	}
	return { graph: assemble(Object.values(cache.edges).flat()), changed };
}

/**
 * Addresses reachable within `depth` hops of `address`, in either
 * direction — the unit's working context.
 *
 * @param {Graph} graph
 * @param {string} address
 * @param {number} [depth]
 * @returns {Set<string>}
 */
export function neighborhood(graph, address, depth = 1) {
	const seen = new Set([address]);
	let frontier = [address];
	for (let d = 0; d < depth && frontier.length > 0; d++) {
		const next = [];
		for (const node of frontier) {
			for (const edge of graph.outbound.get(node) ?? []) {
				if (!seen.has(edge.to)) {
					seen.add(edge.to);
					next.push(edge.to);
				}
			}
			for (const edge of graph.inbound.get(node) ?? []) {
				if (!seen.has(edge.from)) {
					seen.add(edge.from);
					next.push(edge.from);
				}
			}
		}
		frontier = next;
	}
	return seen;
}

/**
 * Everything that (transitively) depends on `address` — the units to
 * re-check or regenerate when it changes. Follows inbound edges only;
 * excludes the address itself.
 *
 * @param {Graph} graph
 * @param {string} address
 * @returns {Set<string>}
 */
export function impact(graph, address) {
	const seen = new Set();
	const stack = [address];
	while (stack.length > 0) {
		const node = stack.pop();
		for (const edge of graph.inbound.get(node) ?? []) {
			if (!seen.has(edge.from)) {
				seen.add(edge.from);
				stack.push(edge.from);
			}
		}
	}
	seen.delete(address);
	return seen;
}
