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
	pagesEmitter,
	policiesEmitter,
	queriesEmitter,
	remotesEmitter,
	triggersEmitter
} from './emit-units.js';
import { machinesEmitter } from './emit-machines.js';
import { wranglerFile } from './emit-wrangler.js';
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
				const [first, ...rest] = keys;
				const tag = first[0].toUpperCase() + first.slice(1);
				const contract = contracts[tag];
				if (!contract) return;

				const primary = entry[first];
				const parsed =
					typeof primary === 'string' && isAddress(primary) ? parseAddress(primary) : null;
				const props = {};
				if (parsed) props[parsed.kind === 'Action' ? 'action' : 'data'] = primary;
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
	triggersEmitter,
	pagesEmitter,
	remotesEmitter
];

const require = createRequire(import.meta.url);

const FILE_KINDS = {
	'schema.c': 'Entity',
	'queries.c': 'Query',
	'actions.c': 'Action',
	'machines.c': 'Action',
	'policies.c': 'Policy',
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
 * Load palette props contracts from the app's own dependency tree. Apps
 * that don't use norns-ui simply skip binding validation.
 *
 * @param {string} appRoot
 * @returns {Record<string, *> | null}
 */
function loadContracts(appRoot) {
	try {
		const appRequire = createRequire(join(appRoot, 'package.json'));
		return appRequire('@human-synthesis/norns-ui/contracts').contracts ?? null;
	} catch {
		return null;
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
 * surface. Imports the app's global stylesheet when `src/app.css` exists.
 *
 * @param {boolean} hasAppCss
 * @returns {{ path: string, text: string }}
 */
export function layoutFile(hasAppCss) {
	return {
		path: 'routes/+layout.svelte',
		text: [
			'<!-- GENERATED by `norns generate` — do not edit. -->',
			'<script>',
			...(hasAppCss ? ["\timport '$custom/app.css';"] : []),
			'\tlet { children } = $props();',
			'</script>',
			'',
			'{@render children()}',
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
	const contracts = opts.contracts ?? loadContracts(appRoot);
	const refusals = checkGenerate(specs, contracts ? { contracts } : {});
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

	// App-level: the wrangler config derives from all modules, so refresh it
	// whenever anything re-emitted (or it's missing entirely).
	if (pending.length > 0 || !existsSync(join(outRoot, 'wrangler.json'))) {
		pending.push(wranglerFile(specs));
	}

	// App-level: the live SSE route exists iff any query is live.
	if (
		hasLiveQueries(specs) &&
		(pending.length > 0 || !existsSync(join(outRoot, 'routes', '_norns', 'live', '+server.c')))
	) {
		pending.push(liveRouteFile());
	}

	// App-level: a root layout so generated routes render inside a shell.
	if (pending.length > 0 || !existsSync(join(outRoot, 'routes', '+layout.svelte'))) {
		pending.push(layoutFile(existsSync(join(appRoot, 'src', 'app.css'))));
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

	return { version: specs.version, written, skipped, refusals: [] };
}
