/**
 * Generator pipeline (K-09): load → validate → refuse → plan → emit.
 *
 * Incremental by module hash: a cache under `.norns/cache/generate.json`
 * records the per-module spec hash of the last successful run; only
 * changed modules are re-emitted. Emitters (K-10..K-12: schema, queries,
 * actions, pages, routes) register in EMITTERS — each returns files
 * relative to `.norns/generated/`.
 *
 * The refusal engine turns unsafe-but-shapely specs into structured
 * errors `{ address, path, code, message, fix? }` — the safe path is the
 * only path.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import * as v from 'valibot';

import { isAddress, listUnits, parseAddress } from './address.js';
import { schemaEmitter } from './emit-schema.js';
import {
	actionsEmitter,
	componentKey,
	endpointsEmitter,
	jobsEmitter,
	pagesEmitter,
	policiesEmitter,
	queriesEmitter,
	remotesEmitter,
	servicesEmitter,
	triggersEmitter
} from './emit-units.js';
import { machinesEmitter } from './emit-machines.js';
import { wranglerFile } from './emit-wrangler.js';
import { emitFlow } from './flow.js';
import { buildGraph } from './graph.js';
import { loadSpecs, validateSpecs } from './validate.js';

/** @typedef {{ address: string, path?: string, code: string, message: string, fix?: string }} Refusal */

/**
 * Generator-specific refusals, beyond what `validate` rejects.
 *
 * @param {{ modules: Record<string, *> }} specs
 * @param {{ contracts?: Record<string, *> }} [opts] palette props contracts
 *   (valibot schemas keyed by component tag, normally loaded from
 *   `@human-synthesis/norns-ui/contracts` in the app's node_modules)
 * @returns {Refusal[]}
 */
export function checkGenerate(specs, opts = {}) {
	/** @type {Refusal[]} */
	const refusals = [];
	const graph = buildGraph(specs.modules);
	if (opts.contracts) refusals.push(...checkBindings(specs, opts.contracts));
	refusals.push(...checkLiveBindings(specs));
	refusals.push(...checkSnippetBindings(specs, opts.snippetSlots ?? null));
	refusals.push(...checkTokenOverrides(specs, opts.tokens ?? null));
	refusals.push(...checkNetworkInBodies(specs));

	for (const [moduleName, spec] of Object.entries(specs.modules)) {
		for (const unit of listUnits(moduleName, spec)) {
			if (unit.kind === 'Action') {
				const writes = (graph.outbound.get(unit.address) ?? []).filter(
					(e) => e.type === 'writes'
				);
				for (const edge of writes) {
					const guarded = (graph.inbound.get(edge.to) ?? []).some((e) => e.type === 'guards');
					if (!guarded) {
						refusals.push({
							address: unit.address,
							path: `${unit.address}.steps`,
							code: 'UNGUARDED_ACTION',
							message: `action writes ${edge.to} but no Policy guards that entity`,
							fix: `add policies.${edge.to.split('.').pop()} with read/write rules to module "${moduleName}"`
						});
					}
				}
			}
			if (unit.kind === 'Action') {
				const a = unit.value;
				if (a && typeof a === 'object' && a.transport === 'remote') {
					refusals.push({
						address: unit.address,
						path: `${unit.address}.transport`,
						code: 'UNSPIKED_TRANSPORT',
						message: '`transport: remote` is not generated yet (spike pending) — only `form` actions are emitted',
						fix: 'use `transport: form` (default) or drop the field'
					});
				}
			}
			if (unit.kind === 'Service' || unit.kind === 'Endpoint') {
				refusals.push(...checkServiceSecrets(unit));
			}
			if (unit.kind === 'Query') {
				const q = unit.value;
				if (q && typeof q === 'object' && !q.live && !q.groupBy && q.limit === undefined) {
					refusals.push({
						address: unit.address,
						path: `${unit.address}.limit`,
						code: 'UNPAGINATED_QUERY',
						message: 'query has no limit and is neither live nor grouped — unbounded reads are refused',
						fix: 'add `limit` (or mark the query `live` / add `groupBy`)'
					});
				}
			}
		}
	}
	return refusals;
}

const SECRET_SHAPE_RE =
	/(?:^|[^A-Za-z0-9])(?:sk|pk|rk)_(?:live|test|prod)_[A-Za-z0-9]{8,}|^(?:ghp|gho|github_pat)_|^xox[a-z]-|^AKIA[0-9A-Z]{12}|^eyJ[A-Za-z0-9_-]{10,}/;

/** Token-shaped: known prefixes, or long spaceless mixed-class strings that are not URLs. */
function looksLikeSecret(s) {
	if (typeof s !== 'string') return false;
	if (SECRET_SHAPE_RE.test(s)) return true;
	return (
		s.length >= 32 &&
		!/\s/.test(s) &&
		/[A-Z]/.test(s) &&
		/[a-z]/.test(s) &&
		/[0-9]/.test(s) &&
		!/^https?:\/\//.test(s)
	);
}

function* stringLeaves(value, path = '') {
	if (typeof value === 'string') yield [path, value];
	else if (value && typeof value === 'object') {
		for (const [k, child] of Object.entries(value)) {
			yield* stringLeaves(child, path ? `${path}.${k}` : k);
		}
	}
}

/**
 * D15: credentials never in spec. Refuses userinfo/query params in a
 * service base URL and any token-shaped literal anywhere in the unit —
 * `auth.binding` is a binding *name*; the value lives in the environment
 * (`wrangler secret put`).
 *
 * @param {{ address: string, value: * }} unit a Service unit
 * @returns {Refusal[]}
 */
export function checkServiceSecrets(unit) {
	/** @type {Refusal[]} */
	const refusals = [];
	const svc = unit.value ?? {};
	const push = (path, message) =>
		refusals.push({
			address: unit.address,
			path: `${unit.address}.${path}`,
			code: 'SECRET_IN_SPEC',
			message,
			fix: 'keep only an UPPER_SNAKE binding name in spec and set the value with `wrangler secret put`'
		});
	if (typeof svc.base === 'string') {
		try {
			const u = new URL(svc.base);
			if (u.username || u.password) push('base', 'base URL embeds userinfo credentials');
			if (u.search) push('base', 'base URL embeds query parameters — move keys/tokens to an env binding');
		} catch {
			// meta-schema already rejects non-URL bases
		}
	}
	for (const [path, s] of stringLeaves(svc)) {
		if (path !== 'base' && looksLikeSecret(s)) {
			push(path, `"${s.slice(0, 8)}…" looks like a literal secret — credentials never go in spec`);
		}
	}
	return refusals;
}

/** Global `fetch(` — not `.fetch(` (DO stubs, service bindings) or `myfetch(`. */
const GLOBAL_FETCH_RE = /(?<![.\w])fetch\s*\(/;

function* customBodyFiles(moduleName, spec) {
	for (const [name, a] of Object.entries(spec.actions ?? {})) {
		if (a?.impl === 'custom') yield [`${moduleName}.Action.${name}`, `src/${moduleName}/actions/${name}.c`];
	}
	for (const [name, j] of Object.entries(spec.jobs ?? {})) {
		if (j?.impl === 'custom') yield [`${moduleName}.Job.${name}`, `src/${moduleName}/jobs/${name}.c`];
	}
	for (const name of Object.keys(spec.functions ?? {})) {
		yield [`${moduleName}.Function.${name}`, `src/${moduleName}/functions/${name}.c`];
	}
	for (const name of Object.keys(spec.endpoints ?? {})) {
		yield [`${moduleName}.Endpoint.${name}`, `src/${moduleName}/endpoints/${name}.c`];
	}
	for (const [name, w] of Object.entries(spec.workers ?? {})) {
		if (typeof w?.source === 'string') yield [`${moduleName}.Worker.${name}`, w.source];
	}
	for (const [name, r] of Object.entries(spec.routes ?? {})) {
		if (typeof r?.source === 'string') yield [`${moduleName}.Route.${name}`, r.source];
	}
}

/**
 * X-07: the generated service client is the only network path a custom
 * body may take. Scans declared L3 bodies (custom actions/jobs, functions,
 * endpoints, worker/route sources) for direct global `fetch(` calls.
 * No-op for in-memory specs (no `dir`) — the lint needs files on disk.
 *
 * @param {{ dir?: string, modules: Record<string, *> }} specs
 * @returns {Refusal[]}
 */
export function checkNetworkInBodies(specs) {
	if (typeof specs.dir !== 'string') return [];
	const appRoot = dirname(specs.dir);
	/** @type {Refusal[]} */
	const refusals = [];
	for (const [moduleName, spec] of Object.entries(specs.modules)) {
		for (const [address, rel] of customBodyFiles(moduleName, spec)) {
			const file = join(appRoot, rel);
			if (!existsSync(file)) continue;
			const hit = readFileSync(file, 'utf-8')
				.split('\n')
				.findIndex((line) => GLOBAL_FETCH_RE.test(line));
			if (hit === -1) continue;
			refusals.push({
				address,
				path: `${rel}:${hit + 1}`,
				code: 'UNDECLARED_NETWORK',
				message: `custom body calls global fetch() at ${rel}:${hit + 1} — the generated service client is the only network path`,
				fix: 'declare the host as a Service (with auth binding + operations) and call it through the generated client'
			});
		}
	}
	return refusals;
}

/**
 * Validate page `components:` entries against palette props contracts
 * (U-02). Each entry is normalized the way the pages emitter binds it: the
 * first key names the component; its value becomes the `data` prop when it
 * is a Query address and the `action` prop when it is an Action address.
 * Tags without a contract are left alone — they may be custom components.
 *
 * @param {{ modules: Record<string, *> }} specs
 * @param {Record<string, *>} contracts valibot schema per component tag
 * @returns {Refusal[]}
 */
export function checkBindings(specs, contracts) {
	/** @type {Refusal[]} */
	const refusals = [];
	for (const [moduleName, moduleSpec] of Object.entries(specs.modules)) {
		for (const [pageName, page] of Object.entries(moduleSpec.pages ?? {})) {
			(page.components ?? []).forEach((entry, i) => {
				const keys = Object.keys(entry);
				if (keys.length === 0) return;
				const first = componentKey(entry);
				const rest = keys.filter((k) => k !== first);
				const tag = first[0].toUpperCase() + first.slice(1);
				const contract = contracts[tag];
				if (!contract) return;

				const primary = entry[first];
				const parsed =
					typeof primary === 'string' && isAddress(primary) ? parseAddress(primary) : null;
				const props = {};
				if (parsed) props[parsed.kind === 'Action' ? 'action' : 'data'] = primary;
				else if (primary && typeof primary === 'object' && !Array.isArray(primary)) {
					// realtime bindings (K-27) — the emitter turns these into
					// streamSource/roomChannel props, so validate that shape
					if (typeof primary.stream === 'string') props.streamSource = primary.stream;
					if (typeof primary.room === 'string') props.roomChannel = primary.room;
				}
				for (const key of rest) props[key] = entry[key];

				const result = v.safeParse(contract, props);
				if (result.success) return;
				const issue = result.issues[0];
				const at = issue.path?.map((p) => p.key).join('.');
				refusals.push({
					address: `${moduleName}.Page.${pageName}`,
					path: `${moduleName}.Page.${pageName}.components[${i}]${at ? `.${at}` : ''}`,
					code: 'INVALID_BINDING',
					message: `<${tag}> binding rejected${at ? ` at \`${at}\`` : ''}: ${issue.message}`,
					fix: `match the ${tag} props contract exported by @human-synthesis/norns-ui/contracts`
				});
			});
		}
	}
	return refusals;
}

/**
 * Validate realtime page bindings (K-27) — object-primary component
 * entries like `{ streamText: { stream: "m.Endpoint.x" } }` and
 * `{ chatThread: { room: "m.Worker.x", sends: [...], receives: [...] } }`.
 * `stream` must target an Endpoint with a `stream` output mode; `room` a
 * Worker declared `room: true`. Optional `sends`/`receives` message-name
 * lists are cross-checked against the Room's declared message schemas
 * (`in` for sends, `out` for receives). Needs no palette contracts — the
 * target shape lives in the spec itself.
 *
 * @param {{ modules: Record<string, *> }} specs
 * @returns {Refusal[]}
 */
export function checkLiveBindings(specs) {
	/** @type {Refusal[]} */
	const refusals = [];
	for (const [moduleName, moduleSpec] of Object.entries(specs.modules)) {
		for (const [pageName, page] of Object.entries(moduleSpec.pages ?? {})) {
			(page.components ?? []).forEach((entry, i) => {
				const first = componentKey(entry);
				if (!first) return;
				const binding = entry[first];
				if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return;
				const tag = first[0].toUpperCase() + first.slice(1);
				const refuse = (sub, message, fix) =>
					refusals.push({
						address: `${moduleName}.Page.${pageName}`,
						path: `${moduleName}.Page.${pageName}.components[${i}].${first}.${sub}`,
						code: 'INVALID_BINDING',
						message,
						fix
					});

				if ('stream' in binding) {
					const addr = binding.stream;
					const parsed = typeof addr === 'string' && isAddress(addr) ? parseAddress(addr) : null;
					const target =
						parsed?.kind === 'Endpoint'
							? specs.modules[parsed.module]?.endpoints?.[parsed.name]
							: undefined;
					if (!parsed || parsed.kind !== 'Endpoint' || !target) {
						refuse(
							'stream',
							`<${tag}> \`stream\` binding needs an existing Endpoint address, got ${JSON.stringify(addr)}`,
							'point `stream` at a declared module.Endpoint.name'
						);
					} else if (!target.stream) {
						refuse(
							'stream',
							`${addr} has no \`stream\` output mode — <${tag}> consumes typed SSE frames`,
							'declare `stream: { frame: { … } }` on the Endpoint (output and stream are exclusive)'
						);
					}
				}

				if ('room' in binding) {
					const addr = binding.room;
					const parsed = typeof addr === 'string' && isAddress(addr) ? parseAddress(addr) : null;
					const target =
						parsed?.kind === 'Worker'
							? specs.modules[parsed.module]?.workers?.[parsed.name]
							: undefined;
					if (!parsed || parsed.kind !== 'Worker' || !target) {
						refuse(
							'room',
							`<${tag}> \`room\` binding needs an existing Worker address, got ${JSON.stringify(addr)}`,
							'point `room` at a declared module.Worker.name'
						);
						return;
					}
					if (target.room !== true) {
						refuse(
							'room',
							`${addr} is not a Room — <${tag}> needs a Worker declared \`room: true\``,
							'set `room: true` (plus `messages`/`state`) on the Worker'
						);
						return;
					}
					const messages = target.messages ?? {};
					for (const [listKey, dir] of [
						['sends', 'in'],
						['receives', 'out']
					]) {
						for (const name of Array.isArray(binding[listKey]) ? binding[listKey] : []) {
							if (messages[name]?.[dir]) continue;
							refuse(
								listKey,
								`${addr} declares no \`${dir}\` schema for message ${JSON.stringify(name)}`,
								`declare \`messages.${name}.${dir}\` on the Worker or drop it from \`${listKey}\``
							);
						}
					}
				}
			});
		}
	}
	return refusals;
}

/**
 * Validate Snippet bindings (U-07): a page component prop bound to a
 * `m.Snippet.n` address must reference a declared Snippet unit, and — when
 * palette slot metadata is available — its declared `args` must match the
 * slot's calling convention (the emitter forwards those args as props to
 * the custom body, so a mismatch is a broken render, not a style issue).
 *
 * @param {{ modules: Record<string, *> }} specs
 * @param {Record<string, Record<string, string[]>> | null} [slots]
 *   `snippetSlots` from @human-synthesis/norns-ui/contracts: tag → prop → args
 * @returns {Refusal[]}
 */
export function checkSnippetBindings(specs, slots = null) {
	/** @type {Refusal[]} */
	const refusals = [];
	for (const [moduleName, moduleSpec] of Object.entries(specs.modules)) {
		for (const [pageName, page] of Object.entries(moduleSpec.pages ?? {})) {
			(page.components ?? []).forEach((entry, i) => {
				const keys = Object.keys(entry ?? {});
				if (keys.length === 0) return;
				const first = componentKey(entry);
				const tag = first[0].toUpperCase() + first.slice(1);
				for (const key of keys) {
					const value = entry[key];
					if (typeof value !== 'string' || !isAddress(value)) continue;
					const parsed = parseAddress(value);
					if (parsed.kind !== 'Snippet') continue;
					const refuse = (message, fix) =>
						refusals.push({
							address: `${moduleName}.Page.${pageName}`,
							path: `${moduleName}.Page.${pageName}.components[${i}].${key}`,
							code: 'INVALID_BINDING',
							message,
							fix
						});
					const target = specs.modules[parsed.module]?.snippets?.[parsed.name];
					if (!target) {
						refuse(
							`no Snippet declared at ${value}`,
							`declare \`snippets.${parsed.name}\` (with \`args\`) in module "${parsed.module}" — the body lives in src/${parsed.module}/snippets/${parsed.name}.n`
						);
						continue;
					}
					const want = slots?.[tag]?.[key];
					if (!want) continue;
					const got = target.args ?? [];
					if (want.length !== got.length || want.some((a, j) => a !== got[j])) {
						refuse(
							`<${tag}> \`${key}\` slot passes (${want.join(', ')}) but ${value} declares args (${got.join(', ')})`,
							`set \`args: [${want.map((a) => `"${a}"`).join(', ')}]\` on the Snippet — the emitter forwards them as same-named props`
						);
					}
				}
			});
		}
	}
	return refusals;
}

const TOKEN_NAME_RE = /^--[a-z][a-z0-9-]*$/;

const asVarName = (name) => (name.startsWith('--') ? name : `--${name}`);

/**
 * Validate app-level design-token overrides (U-10): `app.settings.tokens`
 * is a record of token name → CSS value, emitted verbatim into a
 * generated stylesheet — so names must be kebab-case custom properties
 * (checked against the palette token manifest when available) and values
 * must not be able to escape their declaration.
 *
 * @param {{ app?: * }} specs
 * @param {{ vars?: Record<string, string> } | null} [tokens]
 *   `tokens` section of @human-synthesis/norns-ui/manifest
 * @returns {Refusal[]}
 */
export function checkTokenOverrides(specs, tokens = null) {
	const overrides = specs.app?.settings?.tokens;
	if (overrides === undefined) return [];
	const at = (name) => ({
		address: 'app.settings.tokens',
		path: name ? `app.settings.tokens.${name}` : 'app.settings.tokens'
	});
	if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
		return [
			{
				...at(''),
				code: 'INVALID_TOKEN',
				message: 'settings.tokens must be a record of design-token name → CSS value',
				fix: 'e.g. `"settings": { "tokens": { "color-primary-500": "oklch(55% 0.2 260)" } }`'
			}
		];
	}
	/** @type {Refusal[]} */
	const refusals = [];
	const known = tokens?.vars ? new Set(Object.keys(tokens.vars)) : null;
	for (const [name, value] of Object.entries(overrides)) {
		const varName = asVarName(name);
		if (!TOKEN_NAME_RE.test(varName)) {
			refusals.push({
				...at(name),
				code: 'INVALID_TOKEN',
				message: `"${name}" is not a token name (lowercase kebab-case, optional leading --)`
			});
			continue;
		}
		if (known && !known.has(varName)) {
			refusals.push({
				...at(name),
				code: 'UNKNOWN_TOKEN',
				message: `"${varName}" is not a palette design token`,
				fix: 'browse `tokens.vars` in @human-synthesis/norns-ui/manifest for the addressable set'
			});
			continue;
		}
		if (typeof value !== 'string' || value.trim() === '') {
			refusals.push({
				...at(name),
				code: 'INVALID_TOKEN',
				message: `override for "${varName}" must be a non-empty CSS value string`
			});
			continue;
		}
		// eslint-disable-next-line no-control-regex
		if (/[;{}]|url\s*\(|[ -]/i.test(value)) {
			refusals.push({
				...at(name),
				code: 'INVALID_TOKEN',
				message: `override for "${varName}" is not a plain CSS value — \`;\`, braces, \`url()\` and control characters are refused`
			});
		}
	}
	return refusals;
}

/**
 * Normalized `--name → value` record from `app.settings.tokens`, or null
 * when the app declares no overrides.
 *
 * @param {{ app?: * }} specs
 * @returns {Record<string, string> | null}
 */
export function tokenOverrides(specs) {
	const raw = specs.app?.settings?.tokens;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const entries = Object.entries(raw);
	if (entries.length === 0) return null;
	return Object.fromEntries(entries.map(([name, value]) => [asVarName(name), value]));
}

/**
 * Emitters (K-10..K-12). Each: { name, emit(ctx) } where ctx =
 * { moduleName, moduleSpec, specs, graph } and the return value is a list
 * of { path, text } relative to the generated root.
 * @type {{ name: string, emit: (ctx: *) => { path: string, text: string }[] }[]}
 */
export const EMITTERS = [
	schemaEmitter,
	policiesEmitter,
	machinesEmitter,
	queriesEmitter,
	actionsEmitter,
	servicesEmitter,
	jobsEmitter,
	triggersEmitter,
	pagesEmitter,
	remotesEmitter,
	endpointsEmitter
];

const require = createRequire(import.meta.url);

const FILE_KINDS = {
	'schema.c': 'Entity',
	'queries.c': 'Query',
	'actions.c': 'Action',
	'machines.c': 'Action',
	'policies.c': 'Policy',
	'services.c': 'Service',
	'jobs.c': 'Job',
	'triggers.c': 'Trigger'
};

/** `lib/orders/actions.c` + an error near line N → `orders.Action.<unit>`. */
function selfCheckAddress(file, message) {
	const lib = file.path.match(/^lib\/([^/]+)\/([^/]+)$/);
	const kind = lib ? FILE_KINDS[lib[2]] : file.path.startsWith('routes/') ? 'Page' : null;
	if (!kind) return file.path;
	const line = Number(message.match(/:(\d+):\d+/)?.[1] ?? NaN);
	const lines = file.text.split('\n');
	for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
		const unit = lines[i]?.match(/^export (\w+) :=/)?.[1];
		if (unit && lib) return `${lib[1]}.${kind}.${unit}`;
	}
	return lib ? `${lib[1]}.${kind}.*` : file.path;
}

const scriptOf = (pug) => pug.match(/<script>\n([\s\S]*?)<\/script>/)?.[1] ?? null;

/**
 * Self-check (K-14): every emitted `.c` file and `.n` script block must
 * compile through Civet before anything is written — a generator bug can
 * never leave a broken tree behind. (svelte-check across the assembled
 * app runs in the app's own check pipeline, not here.)
 *
 * @param {{ path: string, text: string }[]} files
 * @returns {Refusal[]}
 */
export function selfCheck(files) {
	const { compile } = require('@danielx/civet');
	const refusals = [];
	for (const file of files) {
		const src = file.path.endsWith('.c') ? file.text : file.path.endsWith('.n') ? scriptOf(file.text) : null;
		if (src === null) continue;
		try {
			compile(src, { sync: true, js: true });
		} catch (e) {
			const message = String(e.message ?? e).split('\n')[0];
			refusals.push({
				address: selfCheckAddress(file, message),
				path: file.path,
				code: 'SELFCHECK_FAILED',
				message: `emitted file does not compile: ${message}`
			});
		}
	}
	return refusals;
}

export class GenerateError extends Error {
	/** @param {Refusal[]} refusals */
	constructor(refusals) {
		const lines = refusals.map(
			(r) => `  [${r.code}] ${r.address}: ${r.message}${r.fix ? `\n      fix: ${r.fix}` : ''}`
		);
		super(`norns generate: refused\n${lines.join('\n')}`);
		this.name = 'GenerateError';
		this.refusals = refusals;
	}
}

/**
 * Load palette props contracts + snippet slot metadata from the app's own
 * dependency tree. Apps that don't use norns-ui simply skip binding
 * validation.
 *
 * @param {string} appRoot
 * @returns {{ contracts: Record<string, *> | null, snippetSlots: Record<string, *> | null, tokens: { vars?: Record<string, string> } | null }}
 */
function loadPalette(appRoot) {
	try {
		const appRequire = createRequire(join(appRoot, 'package.json'));
		const mod = appRequire('@human-synthesis/norns-ui/contracts');
		let tokens = null;
		try {
			tokens = appRequire('@human-synthesis/norns-ui/manifest')?.tokens ?? null;
		} catch {
			tokens = null;
		}
		return { contracts: mod.contracts ?? null, snippetSlots: mod.snippetSlots ?? null, tokens };
	} catch {
		return { contracts: null, snippetSlots: null, tokens: null };
	}
}

/** Any `live: true` query anywhere means the app serves `/_norns/live`. */
function hasLiveQueries(specs) {
	for (const mod of Object.values(specs.modules)) {
		for (const query of Object.values(mod.queries ?? {})) {
			if (query?.live === true) return true;
		}
	}
	return false;
}

/**
 * App-level SSE endpoint streaming live-query refresh signals (R-11).
 *
 * @returns {{ path: string, text: string }}
 */
export function liveRouteFile() {
	return {
		path: 'routes/_norns/live/+server.c',
		text: [
			'// GENERATED by `norns generate` — do not edit.',
			'',
			`import { liveHandler } from '@human-synthesis/norns/server'`,
			'',
			`export GET := liveHandler`,
			''
		].join('\n')
	};
}

/**
 * Root layout for the generated route tree (app-level, like wrangler.json).
 * Plain `.svelte` — no Pug/Civet — so it stays outside the vetted-subset
 * surface. Imports the app's global stylesheet when `src/app.css` exists,
 * then the generated token-override sheet (after, so `app.settings.tokens`
 * wins over library defaults pulled in via app.css).
 *
 * @param {boolean} hasAppCss
 * @param {boolean} [hasTokens]
 * @returns {{ path: string, text: string }}
 */
export function layoutFile(hasAppCss, hasTokens = false) {
	return {
		path: 'routes/+layout.svelte',
		text: [
			'<!-- GENERATED by `norns generate` — do not edit. -->',
			'<script>',
			...(hasAppCss ? ["\timport '$custom/app.css';"] : []),
			...(hasTokens ? ["\timport './tokens.css';"] : []),
			'\tlet { children } = $props();',
			'</script>',
			'',
			'{@render children()}',
			''
		].join('\n')
	};
}

/**
 * App-level stylesheet applying `app.settings.tokens` overrides (U-10).
 *
 * @param {Record<string, string>} overrides normalized `--name → value`
 * @returns {{ path: string, text: string }}
 */
export function tokensFile(overrides) {
	return {
		path: 'routes/tokens.css',
		text: [
			'/* GENERATED by `norns generate` — do not edit. */',
			':root {',
			...Object.entries(overrides).map(([name, value]) => `\t${name}: ${value};`),
			'}',
			''
		].join('\n')
	};
}

function readCache(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf-8'));
	} catch {
		return { moduleHashes: {} };
	}
}

/**
 * Generate an app from its specs into `.norns/generated/`.
 *
 * @param {string} [dir] specs directory, defaults to `<cwd>/specs`
 * @param {{ out?: string, force?: boolean, contracts?: Record<string, *> }} [opts]
 * @returns {{ version: string, written: string[], skipped: string[], refusals: [] }}
 */
export function generateApp(dir, opts = {}) {
	const specs = loadSpecs(dir);
	const appRoot = dirname(specs.dir);
	const outRoot = resolve(opts.out ?? join(appRoot, '.norns', 'generated'));
	const cacheFile = join(appRoot, '.norns', 'cache', 'generate.json');

	const validation = validateSpecs(specs.dir);
	if (!validation.ok) {
		throw new GenerateError(
			validation.issues
				.filter((i) => i.level === 'error')
				.map((i) => ({ address: i.address, code: 'INVALID_SPEC', message: i.message }))
		);
	}
	const palette = loadPalette(appRoot);
	const contracts = opts.contracts ?? palette.contracts;
	const snippetSlots = opts.snippetSlots ?? palette.snippetSlots;
	const tokens = opts.tokens ?? palette.tokens;
	const refusals = checkGenerate(specs, {
		...(contracts ? { contracts } : {}),
		...(snippetSlots ? { snippetSlots } : {}),
		...(tokens ? { tokens } : {})
	});
	if (refusals.length > 0) throw new GenerateError(refusals);

	const cache = opts.force ? { moduleHashes: {} } : readCache(cacheFile);
	const graph = buildGraph(specs.modules);
	const written = [];
	const skipped = [];
	const pending = [];

	for (const [moduleName, moduleSpec] of Object.entries(specs.modules)) {
		if (cache.moduleHashes[moduleName] === specs.hashes[moduleName]) {
			skipped.push(moduleName);
			continue;
		}
		for (const emitter of EMITTERS) {
			pending.push(...emitter.emit({ moduleName, moduleSpec, specs, graph }));
		}
		cache.moduleHashes[moduleName] = specs.hashes[moduleName];
	}

	// App-level: the wrangler config derives from all modules AND app.tron
	// (name, dialect, cloudflare settings), so refresh it whenever anything
	// re-emitted, the app spec itself changed, or it's missing entirely.
	const appChanged = cache.appHash !== specs.hashes.app;
	if (pending.length > 0 || appChanged || !existsSync(join(outRoot, 'wrangler.json'))) {
		pending.push(wranglerFile(specs));
	}
	cache.appHash = specs.hashes.app;

	// App-level: the live SSE route exists iff any query is live.
	if (
		hasLiveQueries(specs) &&
		(pending.length > 0 || !existsSync(join(outRoot, 'routes', '_norns', 'live', '+server.c')))
	) {
		pending.push(liveRouteFile());
	}

	// App-level: token overrides from `app.settings.tokens` (U-10).
	const overrides = tokenOverrides(specs);
	if (overrides && (pending.length > 0 || !existsSync(join(outRoot, 'routes', 'tokens.css')))) {
		pending.push(tokensFile(overrides));
	}

	// App-level: a root layout so generated routes render inside a shell.
	if (pending.length > 0 || !existsSync(join(outRoot, 'routes', '+layout.svelte'))) {
		pending.push(layoutFile(existsSync(join(appRoot, 'src', 'app.css')), Boolean(overrides)));
	}

	const failures = selfCheck(pending);
	if (failures.length > 0) throw new GenerateError(failures);

	for (const file of pending) {
		const full = join(outRoot, file.path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, file.text, 'utf-8');
		written.push(file.path);
	}
	for (const name of Object.keys(cache.moduleHashes)) {
		if (!(name in specs.modules)) delete cache.moduleHashes[name];
	}

	const manifest = {
		version: specs.version,
		modules: specs.hashes,
		generatedAt: new Date().toISOString()
	};
	mkdirSync(outRoot, { recursive: true });
	writeFileSync(join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, '\t') + '\n');
	mkdirSync(dirname(cacheFile), { recursive: true });
	writeFileSync(cacheFile, JSON.stringify(cache, null, '\t') + '\n');

	emitFlow(specs, { force: opts.force });

	return { version: specs.version, written, skipped, refusals: [] };
}
