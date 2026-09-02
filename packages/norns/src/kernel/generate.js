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
	humanizeName,
	pagesEmitter,
	policiesEmitter,
	queriesEmitter,
	remotesEmitter,
	servicesEmitter,
	triggersEmitter
} from './emit-units.js';
import { machinesEmitter } from './emit-machines.js';
import { workerEntryFile, wranglerFile } from './emit-wrangler.js';
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
	refusals.push(...checkBodyHygiene(specs));
	refusals.push(...checkAppComponents(specs));

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
 * D40/K-36: app-local Component bindings are contract-checked like palette
 * ones — the unit must exist, `with:` keys must be declared props, and the
 * `.n` body must be on disk (the page imports it).
 *
 * @param {{ dir?: string, modules: Record<string, *> }} specs
 * @returns {Refusal[]}
 */
export function checkAppComponents(specs) {
	/** @type {Refusal[]} */
	const refusals = [];
	const appRoot = typeof specs.dir === 'string' ? dirname(specs.dir) : null;

	const checkUnit = (at, path, addr) => {
		const parsed = parseAddress(addr);
		const unit = specs.modules[parsed.module]?.components?.[parsed.name];
		if (unit === undefined) {
			refusals.push({
				address: at,
				path,
				code: 'INVALID_BINDING',
				message: `no Component declared at ${addr}`,
				fix: `declare ${addr} (props/events) and write its body via setBody`
			});
			return null;
		}
		const rel = `src/${parsed.module}/components/${parsed.name}.n`;
		if (appRoot !== null && !existsSync(join(appRoot, rel))) {
			refusals.push({
				address: addr,
				path: rel,
				code: 'COMPONENT_BODY_MISSING',
				message: `Component ${addr} has no body at ${rel}`,
				fix: `write it with { op: "setBody", path: "${addr}", value: "<pug>" }`
			});
		}
		return unit;
	};

	for (const [moduleName, spec] of Object.entries(specs.modules)) {
		for (const [pageName, page] of Object.entries(spec.pages ?? {})) {
			const at = `${moduleName}.Page.${pageName}`;
			(page.components ?? []).forEach((entry, i) => {
				const base = `${at}.components[${i}]`;
				if (typeof entry?.component === 'string' && isAddress(entry.component)) {
					const parsed = parseAddress(entry.component);
					if (parsed.kind === 'Component') {
						const unit = checkUnit(at, base, entry.component);
						if (unit) {
							const declared = new Set(Object.keys(unit.props ?? {}));
							for (const key of Object.keys(entry.with ?? {})) {
								if (!declared.has(key)) {
									refusals.push({
										address: at,
										path: `${base}.with.${key}`,
										code: 'INVALID_BINDING',
										message: `<${entry.component}> binding rejected: "${key}" is not a declared prop`,
										fix: `declare props.${key} on the Component or drop the binding`
									});
								}
							}
						}
						return;
					}
				}
				for (const [key, value] of Object.entries(entry ?? {})) {
					if (typeof value !== 'string' || !isAddress(value)) continue;
					if (parseAddress(value).kind === 'Component') checkUnit(at, `${base}.${key}`, value);
				}
			});
		}
	}
	return refusals;
}

const RAW_SQL_RE = /\bsql\.raw\s*\(|\bsql`/;
const PUG_UNESCAPED_RE = /!\{/;

const KIND_COLLECTIONS = { Action: 'actions', Job: 'jobs', Function: 'functions', Endpoint: 'endpoints', Worker: 'workers', Route: 'routes' };

/**
 * K-35/D35: close the escape hatches UNDECLARED_NETWORK left open —
 * token-shaped string literals in custom bodies (SECRET_IN_BODY), raw SQL
 * without a declared `raw-sql` capability (RAW_SQL), and unescaped Pug
 * interpolation in custom `.n` snippet templates (PUG_UNESCAPED).
 *
 * @param {{ dir?: string, modules: Record<string, *> }} specs
 * @returns {Refusal[]}
 */
export function checkBodyHygiene(specs) {
	if (typeof specs.dir !== 'string') return [];
	const appRoot = dirname(specs.dir);
	/** @type {Refusal[]} */
	const refusals = [];
	for (const [moduleName, spec] of Object.entries(specs.modules)) {
		for (const [address, rel] of customBodyFiles(moduleName, spec)) {
			const file = join(appRoot, rel);
			if (!existsSync(file)) continue;
			const lines = readFileSync(file, 'utf-8').split('\n');
			const secretAt = lines.findIndex((line) =>
				[...line.matchAll(/'([^']*)'|"([^"]*)"/g)].some((m) => looksLikeSecret(m[1] ?? m[2]))
			);
			if (secretAt !== -1) {
				refusals.push({
					address,
					path: `${rel}:${secretAt + 1}`,
					code: 'SECRET_IN_BODY',
					message: `custom body holds a token-shaped literal at ${rel}:${secretAt + 1}`,
					fix: 'read secrets from the env binding named in spec (wrangler secret put), never a literal'
				});
			}
			const kind = address.split('.')[1];
			const unit = spec[KIND_COLLECTIONS[kind]]?.[address.split('.')[2]];
			const allowed = Array.isArray(unit?.capabilities) && unit.capabilities.includes('raw-sql');
			if (!allowed) {
				const sqlAt = lines.findIndex((line) => RAW_SQL_RE.test(line));
				if (sqlAt !== -1) {
					refusals.push({
						address,
						path: `${rel}:${sqlAt + 1}`,
						code: 'RAW_SQL',
						message: `custom body uses raw SQL at ${rel}:${sqlAt + 1}`,
						fix: "use the drizzle query builder, or declare capabilities: ['raw-sql'] on the unit"
					});
				}
			}
		}
		for (const name of Object.keys(spec.snippets ?? {})) {
			const rel = `src/${moduleName}/snippets/${name}.n`;
			const file = join(appRoot, rel);
			if (!existsSync(file)) continue;
			const hit = readFileSync(file, 'utf-8')
				.split('\n')
				.findIndex((line) => PUG_UNESCAPED_RE.test(line));
			if (hit !== -1) {
				refusals.push({
					address: `${moduleName}.Snippet.${name}`,
					path: `${rel}:${hit + 1}`,
					code: 'PUG_UNESCAPED',
					message: `snippet renders unescaped HTML via !{…} at ${rel}:${hit + 1}`,
					fix: 'use escaped {interpolation}; unescaped output is an XSS vector'
				});
			}
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
 * When the specs declare statically-routed Pages, the layout is an admin
 * shell: sidebar nav (one link per Page, active state via aria-current)
 * around the content. Styled by the `.norns-*` atoms in norns-ui; override
 * through `app.settings.tokens` or `src/app.css`. `app.settings.shell: false`
 * suppresses the shell entirely (a single-page app gets a sidebar whose only
 * link is the page it is already on — pure chrome).
 *
 * @param {{ app?: *, modules: Record<string, *> }} specs
 * @param {boolean} hasAppCss
 * @param {boolean} [hasTokens]
 * @returns {{ path: string, text: string }}
 */
export function layoutFile(specs, hasAppCss, hasTokens = false) {
	let nav = [];
	const shellSetting = specs?.app?.settings?.shell;
	const shell = shellSetting !== false;
	const shellCfg = shellSetting && typeof shellSetting === 'object' ? shellSetting : null;

	// D46/K-40: `settings.shell.nav` is the middle grain — declared order,
	// grouping and naming of the chrome the generator already emits.
	if (shellCfg?.nav && Array.isArray(shellCfg.nav)) {
		for (const group of shellCfg.nav) {
			let head = typeof group?.group === 'string' ? group.group : null;
			for (const addr of Array.isArray(group?.pages) ? group.pages : []) {
				const [m, , n] = String(addr).split('.');
				const p = specs?.modules?.[m]?.pages?.[n];
				if (typeof p?.route !== 'string') continue;
				const label = ['index', 'home', 'main', 'page'].includes(n) ? m : n;
				nav.push({ href: p.route, label: humanizeName(label), ...(head ? { head } : {}) });
				head = null; // group header renders once, on its first page
			}
		}
	} else {
		for (const [moduleName, spec] of Object.entries(shell ? (specs?.modules ?? {}) : {})) {
			for (const [name, p] of Object.entries(spec?.pages ?? {})) {
				const route = p?.route;
				if (typeof route !== 'string' || route.includes('[') || route.includes(':')) continue;
				// Generic page names label as their module: companies.Page.index → "Companies".
				const label = ['index', 'home', 'main', 'page'].includes(name) ? moduleName : name;
				nav.push({ href: route, label: humanizeName(label) });
			}
		}
		nav.sort((a, b) => a.href.localeCompare(b.href));
	}
	const brand = shellCfg?.brand ?? humanizeName(specs?.app?.name ?? 'App');

	const script = [
		'<script>',
		...(hasAppCss ? ["\timport '$custom/app.css';"] : []),
		...(hasTokens ? ["\timport './tokens.css';"] : []),
		...(nav.length ? ["\timport { page } from '$app/state';"] : []),
		'\tlet { children } = $props();',
		...(nav.length ? [`\tconst nav = ${JSON.stringify(nav)};`] : []),
		'</script>'
	];
	const body = nav.length
		? [
				'<div class="norns-shell">',
				'\t<aside class="norns-sidebar">',
				`\t\t<div class="norns-brand">${brand}</div>`,
				'\t\t<nav class="norns-nav">',
				'\t\t\t{#each nav as item (item.href)}',
				'\t\t\t\t{#if item.head}<div class="norns-nav-group">{item.head}</div>{/if}',
				"\t\t\t\t<a href={item.href} aria-current={page.url.pathname === item.href ? 'page' : undefined}>{item.label}</a>",
				'\t\t\t{/each}',
				'\t\t</nav>',
				'\t</aside>',
				'\t<main class="norns-main">{@render children()}</main>',
				'</div>'
			]
		: ['{@render children()}'];
	return {
		path: 'routes/+layout.svelte',
		text: ['<!-- GENERATED by `norns generate` — do not edit. -->', ...script, '', ...body, ''].join('\n')
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
		// The wrangler config's ROOM binding names a Durable Object class —
		// the entry that exports it is emitted with it, or deploy is DOA (v6 K-44).
		const workerEntry = workerEntryFile(specs);
		if (workerEntry) pending.push(workerEntry);
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
		pending.push(layoutFile(specs, existsSync(join(appRoot, 'src', 'app.css')), Boolean(overrides)));
	}

	// K-40/D45: app settings materialize for the hook (serializer, dev seed,
	// auth wiring) — the spec is the source, the hook only consumes.
	if (specs.app?.settings && Object.keys(specs.app.settings).length > 0) {
		const settingsFile = {
			path: 'lib/app/settings.c',
			text: `// GENERATED by \`norns generate\` — do not edit.\n\nexport SETTINGS := ${JSON.stringify(specs.app.settings, null, '\t')}\n`
		};
		const current = join(outRoot, settingsFile.path);
		if (!existsSync(current) || readFileSync(current, 'utf-8') !== settingsFile.text) {
			pending.push(settingsFile);
		}
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
