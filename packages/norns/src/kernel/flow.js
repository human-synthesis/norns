/**
 * Flow-graph emitter (K-24, D17) — generated metadata, not analysis on
 * demand. Each runnable unit gets a pipeline tree from input to output:
 * stages derived from spec are exact (`src: 'spec' | 'generated'`); call
 * edges inside custom bodies come from a line-level indexer and carry a
 * `confidence` tag (`static` for address literals, `heuristic` for dynamic
 * dispatch) — the graph never pretends.
 *
 * Persisted per module under `.norns/cache/flow/<module>.json`, keyed by
 * spec hash + body-file hashes so unchanged modules are not re-derived.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { listUnits } from './address.js';
import { buildGraph } from './graph.js';
import { loadSpecs } from './validate.js';

const ADDRESS_LITERAL_RE =
	/(['"`])([a-z][A-Za-z0-9_]*\.(?:Entity|Query|Action|Policy|Page|Trigger|Component|Machine|Remote|Service|Job|Endpoint|Function|Worker|Route)\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?)\1/g;

const SYMBOL_RES = [
	/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
	/^(?:export\s+)?([A-Za-z_$][\w$]*)\s*:?=\s*(?:async\b|\(|function\b)/,
	/^\s*(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:{|=>|$)/
];

/** Nearest enclosing symbol name for a 0-based line, scanning upward. */
function symbolAt(lines, index) {
	for (let i = index; i >= 0; i--) {
		if (/^\s*export\s+default\b/.test(lines[i]) && !/class/.test(lines[i])) return 'default';
		for (const re of SYMBOL_RES) {
			const name = lines[i].match(re)?.[1];
			if (name && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) {
				return name;
			}
		}
	}
	return 'default';
}

/**
 * Line-level call indexer for a custom body. Address literals are static
 * edges; `resolve(` with a non-literal argument is a heuristic edge —
 * dynamic dispatch the indexer cannot pin down.
 *
 * @param {string} text
 * @returns {{ to: string, at: string, line: number, confidence: 'static' | 'heuristic' }[]}
 */
export function indexBody(text) {
	const calls = [];
	const lines = text.split('\n');
	lines.forEach((line, i) => {
		for (const match of line.matchAll(ADDRESS_LITERAL_RE)) {
			calls.push({
				to: match[2],
				at: `#${symbolAt(lines, i)}`,
				line: i + 1,
				confidence: 'static'
			});
		}
		if (/\bresolve\s*\((?!\s*['"`])/.test(line)) {
			calls.push({
				to: '(dynamic)',
				at: `#${symbolAt(lines, i)}`,
				line: i + 1,
				confidence: 'heuristic'
			});
		}
	});
	return calls;
}

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

function bodyStage(rel, appRoot, bodies) {
	const stage = { kind: 'body', src: rel };
	const file = appRoot ? join(appRoot, rel) : null;
	if (file && existsSync(file)) {
		const text = readFileSync(file, 'utf-8');
		if (bodies) bodies[rel] = sha(text);
		const calls = indexBody(text);
		if (calls.length > 0) stage.calls = calls;
		stage.confidence = calls.some((c) => c.confidence === 'heuristic') ? 'heuristic' : 'static';
	} else {
		stage.confidence = 'static';
		if (bodies && rel) bodies[rel] = null;
	}
	return stage;
}

function describeStep(step) {
	if (step === null || typeof step !== 'object') return String(step);
	if (typeof step.call === 'string') return `call ${step.call}`;
	if (typeof step.enqueue === 'string') return `enqueue ${step.enqueue}`;
	if (typeof step.emit === 'string') return `emit ${step.emit}`;
	if (step.set && typeof step.set === 'object') {
		const { entity, ...fields } = step.set;
		return `set ${entity ?? ''}.${Object.keys(fields).join(',')}`;
	}
	if (step.create && typeof step.create === 'object') return `create ${step.create.entity ?? ''}`;
	return Object.keys(step).join('+');
}

function stepStages(steps) {
	const entries = (Array.isArray(steps) ? steps : []).map(describeStep);
	if (entries.length === 0) return [];
	const stages = [{ kind: 'steps', entries, src: 'spec' }];
	const events = entries.filter((e) => e.startsWith('emit ')).map((e) => e.slice(5));
	if (events.length > 0) stages.push({ kind: 'emit', events, src: 'spec' });
	return stages;
}

function guardsOf(graph, address) {
	const direct = (graph.inbound.get(address) ?? [])
		.filter((e) => e.type === 'guards')
		.map((e) => e.from);
	const writes = (graph.outbound.get(address) ?? []).filter((e) => e.type === 'writes');
	const viaEntities = writes.flatMap((edge) =>
		(graph.inbound.get(edge.to) ?? []).filter((e) => e.type === 'guards').map((e) => e.from)
	);
	return [...new Set([...direct, ...viaEntities])];
}

/**
 * The implicit ownership guard on a custom action with a dotted
 * `Entity.id`-style input: the generated shell resolves the row, 404s on
 * a miss and runs the entity policy's write check before the body runs.
 * That guard has no graph edge (it comes from the input spelling, not a
 * Policy.run entry), so the flow derives it here — a guarded action must
 * never read as unguarded (v6 M-37).
 */
function implicitGuards(graph, moduleName, input) {
	for (const key of Object.keys(input ?? {}).sort()) {
		const ref = input[key];
		if (typeof ref !== 'string') continue;
		const entity = ref.replace(/\?$/, '').split('.')[0];
		const guards = (graph.inbound.get(`${moduleName}.Entity.${entity}`) ?? [])
			.filter((e) => e.type === 'guards')
			.map((e) => e.from);
		if (guards.length > 0) return [...new Set(guards)];
	}
	return [];
}

/**
 * Pipeline tree for one unit, or null for kinds without runtime flow.
 *
 * @returns {{ unit: string, stages: * } | null}
 */
export function unitFlow(unit, { moduleName, graph, appRoot, bodies } = {}) {
	const { address, kind, name, value } = unit;
	const v = value && typeof value === 'object' ? value : {};
	const stages = [];
	switch (kind) {
		case 'Endpoint': {
			stages.push({ kind: 'transport', route: v.route, method: v.method ?? 'POST', src: 'spec' });
			stages.push({ kind: 'auth', mode: v.auth?.mode ?? v.auth, src: 'generated' });
			if (v.input) stages.push({ kind: 'validate', schema: 'input', src: 'generated' });
			stages.push(bodyStage(`src/${moduleName}/endpoints/${name}.c`, appRoot, bodies));
			if (v.stream) {
				stages.push({ kind: 'stream', frame: Object.keys(v.stream.frame ?? {}), src: 'generated' });
			} else {
				stages.push({ kind: 'respond', schema: v.output ? 'output' : null, src: 'generated' });
			}
			break;
		}
		case 'Action': {
			stages.push({ kind: 'transport', mode: v.transport ?? 'form', src: 'spec' });
			const guards = guardsOf(graph, address);
			if (guards.length === 0) guards.push(...implicitGuards(graph, moduleName, v.input));
			if (guards.length > 0) stages.push({ kind: 'policy', guards, src: 'generated' });
			if (v.input) stages.push({ kind: 'validate', schema: 'input', src: 'generated' });
			if (v.requires) stages.push({ kind: 'machine', requires: v.requires, src: 'spec' });
			if (v.impl === 'custom') {
				stages.push(bodyStage(`src/${moduleName}/actions/${name}.c`, appRoot, bodies));
			}
			stages.push(...stepStages(v.steps));
			if (Array.isArray(v.emits) && v.emits.length > 0) {
				stages.push({ kind: 'emit', events: v.emits, src: 'spec' });
			}
			if (Array.isArray(v.refresh) && v.refresh.length > 0) {
				stages.push({ kind: 'refresh', queries: v.refresh, src: 'spec' });
			}
			stages.push({ kind: 'respond', src: 'generated' });
			break;
		}
		case 'Job': {
			const consume = { kind: 'consume', src: 'spec' };
			if (v.retry) consume.retry = v.retry;
			if (v.dlq) consume.dlq = v.dlq;
			if (v.concurrency !== undefined) consume.concurrency = v.concurrency;
			stages.push(consume);
			if (v.input) stages.push({ kind: 'validate', schema: 'input', src: 'generated' });
			if (v.impl === 'custom') {
				stages.push(bodyStage(`src/${moduleName}/jobs/${name}.c`, appRoot, bodies));
			}
			stages.push(...stepStages(v.steps));
			stages.push({ kind: 'ack', src: 'generated' });
			break;
		}
		case 'Function': {
			if (v.input) stages.push({ kind: 'validate', schema: 'input', src: 'generated' });
			stages.push(bodyStage(`src/${moduleName}/functions/${name}.c`, appRoot, bodies));
			stages.push({ kind: 'respond', src: 'generated' });
			break;
		}
		case 'Worker': {
			if (v.room !== true) return null;
			stages.push({ kind: 'transport', proto: 'ws', src: 'generated' });
			stages.push({ kind: 'auth', mode: v.auth?.mode ?? v.auth, src: 'spec' });
			const messages = v.messages ?? {};
			const inbound = Object.keys(messages);
			const outbound = Object.entries(messages)
				.filter(([, m]) => m && typeof m === 'object' && m.out)
				.map(([n]) => n);
			if (inbound.length > 0) stages.push({ kind: 'messages', in: inbound, src: 'spec' });
			if (typeof v.source === 'string') {
				stages.push(bodyStage(v.source.replace(/^\.\//, ''), appRoot, bodies));
			}
			if (outbound.length > 0) stages.push({ kind: 'broadcast', out: outbound, src: 'spec' });
			break;
		}
		case 'Query': {
			const read = { kind: 'read', from: v.from, src: 'spec' };
			if (v.where) read.where = v.where;
			if (v.limit !== undefined) read.limit = v.limit;
			if (v.groupBy) read.groupBy = v.groupBy;
			stages.push(read);
			stages.push({ kind: 'respond', live: v.live === true, src: 'generated' });
			break;
		}
		case 'Trigger': {
			stages.push({ kind: 'on', event: name, src: 'spec' });
			const action = typeof value === 'string' ? value : v.action;
			if (action) stages.push({ kind: 'call', to: action, src: 'spec' });
			break;
		}
		default:
			return null;
	}
	return { unit: address, stages };
}

/**
 * Flow nodes for every runnable unit in one module.
 *
 * @returns {{ units: Record<string, *>, bodies: Record<string, string | null> }}
 */
export function buildModuleFlow(moduleName, moduleSpec, { graph, appRoot } = {}) {
	const units = {};
	const bodies = {};
	for (const unit of listUnits(moduleName, moduleSpec)) {
		const node = unitFlow(unit, { moduleName, graph, appRoot, bodies });
		if (node) units[node.unit] = node;
	}
	return { units, bodies };
}

const flowFile = (appRoot, moduleName) =>
	join(appRoot, '.norns', 'cache', 'flow', `${moduleName}.json`);

function readFlowFile(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf-8'));
	} catch {
		return null;
	}
}

/** A cached module entry is fresh when spec hash and every body hash still match. */
function isFresh(entry, specHash, appRoot) {
	if (!entry || entry.specHash !== specHash) return false;
	for (const [rel, recorded] of Object.entries(entry.bodies ?? {})) {
		const file = join(appRoot, rel);
		const current = existsSync(file) ? sha(readFileSync(file, 'utf-8')) : null;
		if (current !== recorded) return false;
	}
	return true;
}

/**
 * Emit `.norns/cache/flow/<module>.json` for every module — incremental:
 * modules whose spec hash and body hashes are unchanged are skipped.
 *
 * @param {{ dir: string, modules: Record<string, *>, hashes: Record<string, string>, version: string }} specs
 * @param {{ force?: boolean }} [opts]
 * @returns {{ written: string[], skipped: string[] }}
 */
export function emitFlow(specs, opts = {}) {
	const appRoot = dirname(specs.dir);
	const graph = buildGraph(specs.modules);
	const written = [];
	const skipped = [];
	for (const [moduleName, moduleSpec] of Object.entries(specs.modules)) {
		const file = flowFile(appRoot, moduleName);
		const specHash = specs.hashes?.[moduleName];
		if (!opts.force && isFresh(readFlowFile(file), specHash, appRoot)) {
			skipped.push(moduleName);
			continue;
		}
		const { units, bodies } = buildModuleFlow(moduleName, moduleSpec, { graph, appRoot });
		const entry = { module: moduleName, specHash, bodies, units };
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(entry, null, '\t') + '\n');
		written.push(moduleName);
	}
	return { written, skipped };
}

function listOf(value) {
	return Array.isArray(value) ? value : [];
}

function addedRemoved(before, after) {
	const b = new Set(before);
	const a = new Set(after);
	return {
		added: [...a].filter((x) => !b.has(x)),
		removed: [...b].filter((x) => !a.has(x))
	};
}

/** Detail-level deltas for one stage kind present on both sides. */
function stageDelta(kind, b, a) {
	const out = [];
	switch (kind) {
		case 'auth':
			if (b.mode !== a.mode) out.push(`auth ${b.mode ?? 'none'} → ${a.mode ?? 'none'}`);
			break;
		case 'transport':
			if (b.route !== a.route) out.push(`route ${b.route} → ${a.route}`);
			if (b.method !== a.method) out.push(`method ${b.method} → ${a.method}`);
			if (b.mode !== a.mode) out.push(`transport ${b.mode} → ${a.mode}`);
			break;
		case 'policy': {
			const { added, removed } = addedRemoved(listOf(b.guards), listOf(a.guards));
			out.push(...added.map((g) => `+guard ${g}`), ...removed.map((g) => `-guard ${g}`));
			break;
		}
		case 'machine':
			if (b.requires !== a.requires) out.push(`requires \`${b.requires}\` → \`${a.requires}\``);
			break;
		case 'steps': {
			const { added, removed } = addedRemoved(listOf(b.entries), listOf(a.entries));
			out.push(...added.map((e) => `steps +${e}`), ...removed.map((e) => `steps -${e}`));
			break;
		}
		case 'emit': {
			const { added, removed } = addedRemoved(listOf(b.events), listOf(a.events));
			out.push(
				...added.map((e) => `now emits ${e}`),
				...removed.map((e) => `no longer emits ${e}`)
			);
			break;
		}
		case 'refresh': {
			const { added, removed } = addedRemoved(listOf(b.queries), listOf(a.queries));
			out.push(
				...added.map((q) => `refresh now touches ${q}`),
				...removed.map((q) => `refresh no longer touches ${q}`)
			);
			break;
		}
		case 'body': {
			const callsOf = (s) => listOf(s.calls).map((c) => c.to);
			const { added, removed } = addedRemoved(callsOf(b), callsOf(a));
			out.push(
				...added.map((c) => `body now calls ${c}`),
				...removed.map((c) => `body no longer calls ${c}`)
			);
			break;
		}
		case 'stream': {
			const { added, removed } = addedRemoved(listOf(b.frame), listOf(a.frame));
			out.push(
				...added.map((f) => `stream frame +${f}`),
				...removed.map((f) => `stream frame -${f}`)
			);
			break;
		}
		case 'respond':
			if ((b.schema ?? null) !== (a.schema ?? null)) {
				out.push(`respond schema ${b.schema ?? 'none'} → ${a.schema ?? 'none'}`);
			}
			break;
		case 'consume':
			if (JSON.stringify(b.retry) !== JSON.stringify(a.retry)) {
				out.push(`retry ${JSON.stringify(b.retry)} → ${JSON.stringify(a.retry)}`);
			}
			if ((b.dlq ?? null) !== (a.dlq ?? null)) out.push(`dlq ${b.dlq ?? 'none'} → ${a.dlq ?? 'none'}`);
			break;
		default:
			if (JSON.stringify(b) !== JSON.stringify(a)) out.push(`${kind} stage changed`);
	}
	return out;
}

function unitDelta(before, after) {
	const deltas = [];
	const bKinds = before.stages.map((s) => s.kind);
	const aKinds = after.stages.map((s) => s.kind);
	for (const [i, stage] of after.stages.entries()) {
		if (!bKinds.includes(stage.kind)) {
			const next = after.stages[i + 1];
			deltas.push(`+${stage.kind} stage${next ? ` before ${next.kind}` : ''}`);
		}
	}
	for (const kind of bKinds) {
		if (!aKinds.includes(kind)) deltas.push(`-${kind} stage`);
	}
	for (const stage of after.stages) {
		const prior = before.stages.find((s) => s.kind === stage.kind);
		if (prior) deltas.push(...stageDelta(stage.kind, prior, stage));
	}
	return deltas;
}

/**
 * Semantic flow diff (K-26): old units vs new units → compact human
 * strings for the apply response. Empty array means no behavioral change.
 *
 * @param {Record<string, *>} beforeUnits
 * @param {Record<string, *>} afterUnits
 * @returns {string[]}
 */
export function flowDelta(beforeUnits, afterUnits) {
	const deltas = [];
	const addresses = new Set([
		...Object.keys(beforeUnits ?? {}),
		...Object.keys(afterUnits ?? {})
	]);
	for (const address of [...addresses].sort()) {
		const before = beforeUnits?.[address];
		const after = afterUnits?.[address];
		if (!before && after) {
			deltas.push(`${address}: new flow (${after.stages.map((s) => s.kind).join(' → ')})`);
		} else if (before && !after) {
			deltas.push(`${address}: flow removed`);
		} else if (before && after) {
			deltas.push(...unitDelta(before, after).map((d) => `${address}: ${d}`));
		}
	}
	return deltas;
}

/**
 * Build (or load) the whole app's flow graph: `{ version, units }` keyed by
 * unit address. Always derives fresh — callers wanting the cached files
 * read `.norns/cache/flow/` directly.
 *
 * @param {string} [dir] specs directory
 * @returns {{ version: string, units: Record<string, *> }}
 */
export function flowApp(dir) {
	const specs = loadSpecs(dir);
	const appRoot = dirname(specs.dir);
	const graph = buildGraph(specs.modules);
	const units = {};
	for (const [moduleName, moduleSpec] of Object.entries(specs.modules)) {
		Object.assign(units, buildModuleFlow(moduleName, moduleSpec, { graph, appRoot }).units);
	}
	return { version: specs.version, units };
}
