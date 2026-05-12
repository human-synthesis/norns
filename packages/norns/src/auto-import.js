import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

// `match`: optional regex tested against the filename. When set, the helper
// module only fires for matching files. Used to scope helpers that have
// distinct client / server variants — most importantly `page`, which is
// exported by both `$app/state` (client) and `@human-synthesis/norns/server`
// (server) with completely different shapes.
//
// The same predicate is reused (`isServerPath`) to classify project-utility
// exports: an export from a server-path file is invisible to client importers.
// That's the structural guarantee that prevents `db` / `bcrypt` / `repo.c`
// internals from being silently auto-imported into `.n` components and
// dragged into the client bundle.
const SERVER_PATH_RE = /(\.server\.|\/server\/|\+server\.|hooks\.server\.)/;
const NON_SERVER_PATH_RE = /^(?!.*(?:\.server\.|\/server\/|\+server\.|hooks\.server\.))/;

function isServerPath(file) {
	return SERVER_PATH_RE.test(file.replace(/\\/g, '/'));
}

const DEFAULT_HELPERS = [
	{
		from: 'svelte',
		imports: [
			'onMount',
			'onDestroy',
			'beforeUpdate',
			'afterUpdate',
			'tick',
			'getContext',
			'setContext',
			'hasContext',
			'createEventDispatcher',
			'untrack',
			'mount',
			'unmount',
			'flushSync'
		]
	},
	{
		from: 'svelte/store',
		imports: ['writable', 'readable', 'derived', 'readonly', 'get']
	},
	{
		from: '@sveltejs/kit',
		imports: [
			'error',
			'redirect',
			'fail',
			'isRedirect',
			'isHttpError',
			'isActionFailure',
			'json',
			'text'
		]
	},
	{
		from: '$app/state',
		imports: ['page', 'navigating', 'updated'],
		match: NON_SERVER_PATH_RE
	},
	{
		from: '@human-synthesis/norns/server',
		imports: [
			'Container',
			'createContainer',
			'withScope',
			'getScope',
			'getContainer',
			'boot',
			'createApp',
			'contextHandle',
			'errorHandle',
			'route',
			'page',
			'validate',
			'ValidationError',
			'betterSqlite',
			'd1',
			'libsql',
			'postgres',
			'withTransaction'
		],
		match: SERVER_PATH_RE
	}
];

const DEFAULT_COMPONENT_DIRS = ['src/lib/components'];
const DEFAULT_COMPONENT_EXTS = ['.svelte', '.n'];
const DEFAULT_EXPORT_EXTS = ['.c', '.civet', '.js'];
const DEFAULT_LIB_ROOT = 'src/lib';
const DEFAULT_LIB_ALIAS = '$lib';

const IDENT_RE = /\b[A-Za-z_$][\w$]*\b/g;
const SCRIPT_OR_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Walk `dir` recursively and return absolute paths of files matching `exts`.
 * Returns [] silently if dir doesn't exist — letting users register dirs
 * that may be created later.
 *
 * @param {string} dir
 * @param {string[]} exts
 * @returns {string[]}
 */
function walk(dir, exts) {
	const out = [];
	const stack = [dir];
	while (stack.length > 0) {
		const cur = /** @type {string} */ (stack.pop());
		let entries;
		try {
			entries = readdirSync(cur, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(cur, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && exts.includes(extname(entry.name))) out.push(full);
		}
	}
	return out;
}

/**
 * Resolve the import path used to reference `componentFile` from
 * `importerFile`. Components under `<root>/<libRoot>` get the `$lib/...`
 * alias (portable across the project, friendly to dts output). Components
 * outside that root fall back to a path relative to the importer — needed
 * for route-colocated components in `src/routes/**`, which SvelteKit
 * doesn't expose under any built-in alias.
 *
 * @param {string} componentFile  Absolute path of the discovered component.
 * @param {string | undefined} importerFile  Absolute path of the file pulling it in.
 * @param {string} root
 * @param {string} libRoot
 * @param {string} libAlias
 * @returns {string | null}
 */
function resolveComponentPath(componentFile, importerFile, root, libRoot, libAlias) {
	const libBase = resolve(root, libRoot);
	const fromLib = relative(libBase, componentFile).replace(/\\/g, '/');
	if (!fromLib.startsWith('..')) return `${libAlias}/${fromLib}`;

	if (!importerFile) return null;
	let rel = relative(dirname(importerFile), componentFile).replace(/\\/g, '/');
	if (!rel.startsWith('.')) rel = `./${rel}`;
	return rel;
}

/**
 * @param {string} root
 * @param {string[]} dirs
 * @param {string[]} exts
 * @returns {Map<string, string>}  name → absolute file path
 */
function buildComponentMap(root, dirs, exts) {
	/** @type {Map<string, string>} */
	const map = new Map();
	for (const d of dirs) {
		const abs = resolve(root, d);
		for (const file of walk(abs, exts)) {
			const name = basename(file, extname(file));
			if (!/^[A-Z]/.test(name)) continue; // components must be capitalised
			if (map.has(name)) continue; // first match wins
			map.set(name, file);
		}
	}
	return map;
}

// Standard ES + Civet `:=` / `.=` export shapes. Type-only exports
// (`export type X`, `export interface X`, `export type { … }`) deliberately
// don't match — auto-import emits value imports, and emitting a value import
// for a type-only export breaks under TS `verbatimModuleSyntax`. Default
// exports also skipped: filename-as-identifier collides with the component
// scanner and the semantics of "auto-import a default" are project-specific.
const EXPORT_VAR_RE = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_FN_CLASS_RE =
	/^\s*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_CIVET_RE = /^\s*export\s+([A-Za-z_$][\w$]*)\s*[:.]=/gm;
const EXPORT_BLOCK_RE = /^\s*export\s*\{([^}]*)\}/gm;

/**
 * Extract the set of named-value exports declared in `source`. Regex-based;
 * accepts standard ES (`export const`, `export function`, `export {}`) and
 * Civet's `:=` / `.=` operators. Rare misses just mean a name doesn't
 * auto-import; the user notices and adds an explicit import — non-fatal.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
function extractExports(source) {
	/** @type {Set<string>} */
	const out = new Set();
	let m;

	for (const re of [EXPORT_VAR_RE, EXPORT_FN_CLASS_RE, EXPORT_CIVET_RE]) {
		re.lastIndex = 0;
		while ((m = re.exec(source)) !== null) out.add(m[1]);
	}

	EXPORT_BLOCK_RE.lastIndex = 0;
	while ((m = EXPORT_BLOCK_RE.exec(source)) !== null) {
		for (const part of m[1].split(',')) {
			const seg = part.trim();
			if (!seg) continue;
			// `type` prefix on a `{}` block entry is TS type-only — `{ type Foo }`
			// or `{ Foo as type Bar }`. Skip those rather than emit a value import.
			if (/^type\s/.test(seg)) continue;
			const asMatch = seg.match(/(\w+)\s+as\s+(\w+)/);
			out.add(asMatch ? asMatch[2] : seg);
		}
	}

	return out;
}

// SvelteKit route conventions (`+page.server.c`, `+layout.c`, `+server.c`,
// `+error.svelte`, …) and hooks (`hooks.server.c`, `hooks.client.c`) export
// names like `load`, `actions`, `GET`, `handle`, `prerender` that are
// CONSUMED BY THE FRAMEWORK — never meant to be imported by other code. If
// they entered the export map, a user identifier called `load` would
// auto-import a random route's load function. Excluded by basename.
const ROUTE_FILE_RE = /^(\+|hooks\.)/;

// Glob → regex. Supports `**`, `*`, `?`, and brace alternation `{a,b}`.
// Patterns are matched against project-relative paths (POSIX-style separators).
//
//   src/lib/**/public.{c,civet}   → src/lib/(?:.*/)?public\.(?:c|civet)
//   src/**/store.c                → src/(?:.*/)?store\.c
//
// Substitutions cascade: an early `**/` → `(?:.*/)?` expansion contains `*`,
// which a later single-`*` rule would clobber. Every regex expansion is
// stashed in a multi-char placeholder first; placeholders are swapped for
// their final regex form once all glob meta has been consumed.
function compileGlob(pattern) {
	const PH_Q = '__NORNS_GLOB_Q__';
	const PH_AS = '__NORNS_GLOB_AS__';
	const PH_NS = '__NORNS_GLOB_NS__';

	let p = pattern.replace(/[.+()^$|]/g, '\\$&');
	p = p.replace(/\?/g, PH_Q);
	p = p.replace(/\{([^}]+)\}/g, (_, inner) =>
		'(?:' +
		inner
			.split(',')
			.map((s) => s.trim().replace(/[.+()^$|?]/g, '\\$&'))
			.join('|') +
		')'
	);
	p = p.replace(/\*\*\//g, `(?:${PH_AS}/)?`);
	p = p.replace(/\/\*\*/g, `(?:/${PH_AS})?`);
	p = p.replace(/\*\*/g, PH_AS);
	p = p.replace(/\*/g, PH_NS);
	p = p.replace(new RegExp(PH_AS, 'g'), '.*');
	p = p.replace(new RegExp(PH_NS, 'g'), '[^/]*');
	p = p.replace(new RegExp(PH_Q, 'g'), '[^/]');
	return new RegExp('^' + p + '$');
}

const EXPORT_WALK_SKIP = new Set([
	'node_modules',
	'.svelte-kit',
	'.git',
	'build',
	'dist',
	'.cache',
	'.turbo'
]);

/** Walk `root` and return absolute paths of files matching any of `globs`. */
function walkGlobs(root, globs) {
	if (globs.length === 0) return [];
	const regexes = globs.map(compileGlob);
	/** @type {string[]} */
	const out = [];
	const stack = [root];
	while (stack.length > 0) {
		const cur = /** @type {string} */ (stack.pop());
		let entries;
		try {
			entries = readdirSync(cur, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.') && entry.name !== '.') continue;
			if (EXPORT_WALK_SKIP.has(entry.name)) continue;
			const full = join(cur, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile()) {
				const rel = relative(root, full).replace(/\\/g, '/');
				if (regexes.some((re) => re.test(rel))) out.push(full);
			}
		}
	}
	return out;
}

/**
 * Walk files matching `globs` and build a name → candidate map.
 *
 * Each candidate carries its `isServer` classification. Resolution at
 * import time picks the right candidate based on the importer's scope.
 * SvelteKit route/hook files are excluded by basename so framework-consumed
 * exports (`load`, `actions`, `handle`) don't enter the map.
 *
 * @param {string} root
 * @param {string[]} globs   project-relative glob patterns
 * @param {string[]} exts    file extensions accepted (defence-in-depth)
 * @returns {Map<string, Array<{ file: string; isServer: boolean }>>}
 */
function buildExportMap(root, globs, exts) {
	/** @type {Map<string, Array<{ file: string; isServer: boolean }>>} */
	const map = new Map();
	const files = walkGlobs(root, globs);
	for (const file of files) {
		if (ROUTE_FILE_RE.test(basename(file))) continue;
		if (!exts.includes(extname(file))) continue;
		let source;
		try {
			source = readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		const rel = relative(root, file).replace(/\\/g, '/');
		const isServer = isServerPath(rel);
		for (const name of extractExports(source)) {
			let list = map.get(name);
			if (!list) {
				list = [];
				map.set(name, list);
			}
			list.push({ file, isServer });
		}
	}
	return map;
}

/**
 * Collapse a raw candidate map into one server-scope and one client-scope
 * candidate per name. If a single scope has multiple candidates, that's a
 * conflict — log it and exclude that scope. Mixed scopes (one server + one
 * client) are kept and resolved dynamically by importer scope.
 *
 * @param {Map<string, Array<{ file: string; isServer: boolean }>>} raw
 * @param {(msg: string) => void} [log]
 * @returns {Map<string, { server?: string; client?: string }>}
 */
function resolveExportConflicts(raw, log = console.warn) {
	/** @type {Map<string, { server?: string; client?: string }>} */
	const out = new Map();
	for (const [name, candidates] of raw) {
		const servers = candidates.filter((c) => c.isServer);
		const clients = candidates.filter((c) => !c.isServer);
		/** @type {{ server?: string; client?: string }} */
		const entry = {};
		if (servers.length === 1) entry.server = servers[0].file;
		else if (servers.length > 1) {
			log(
				`[norns-auto-import] conflict: \`${name}\` exported from multiple server files — not auto-imported, use explicit imports:`
			);
			for (const c of servers) log(`  - ${c.file}`);
		}
		if (clients.length === 1) entry.client = clients[0].file;
		else if (clients.length > 1) {
			log(
				`[norns-auto-import] conflict: \`${name}\` exported from multiple client files — not auto-imported, use explicit imports:`
			);
			for (const c of clients) log(`  - ${c.file}`);
		}
		if (entry.server || entry.client) out.set(name, entry);
	}
	return out;
}

/**
 * Resolve the import specifier for a project-utility file. Same path logic
 * as `resolveComponentPath`, but strips the file extension so imports use
 * the user's existing convention (`'$lib/notes/server/public'`, not
 * `'$lib/notes/server/public.c'`). Vite resolves these via the configured
 * `extensions` array.
 *
 * @param {string} file
 * @param {string | undefined} importer
 * @param {string} root
 * @param {string} libRoot
 * @param {string} libAlias
 * @returns {string | null}
 */
function resolveExportPath(file, importer, root, libRoot, libAlias) {
	const path = resolveComponentPath(file, importer, root, libRoot, libAlias);
	if (!path) return null;
	return path.replace(/\.[a-z0-9]+$/i, '');
}

/**
 * Collect every identifier that appears in `source`. Scans raw text — does
 * not strip strings or comments. Worst case is an unused import, which the
 * Svelte / Vite pipeline tree-shakes at build time, so the looseness is
 * cheap.
 *
 * @param {string} source
 * @param {Set<string>} into
 */
function collectIdentifiers(source, into) {
	IDENT_RE.lastIndex = 0;
	let m;
	while ((m = IDENT_RE.exec(source)) !== null) into.add(m[0]);
}

/**
 * Names already in the script's lexical scope: existing imports plus
 * top-level declarations. Heuristic regex — covers the common shapes; rare
 * misses just produce a duplicate-import error which the user notices
 * immediately.
 *
 * @param {string} script
 * @returns {Set<string>}
 */
function collectDeclared(script) {
	/** @type {Set<string>} */
	const out = new Set();

	// import { a, b as c } from '...'  /  import D from '...'  /  import * as E from '...'
	const importRe = /import\s+(?:(\w+)\s*,?\s*)?(?:\{\s*([^}]+)\s*\}|\*\s+as\s+(\w+))?\s*from/g;
	let m;
	while ((m = importRe.exec(script)) !== null) {
		if (m[1]) out.add(m[1]);
		if (m[3]) out.add(m[3]);
		if (m[2]) {
			for (const part of m[2].split(',')) {
				const seg = part.trim();
				if (!seg) continue;
				const asMatch = seg.match(/(\w+)\s+as\s+(\w+)/);
				out.add(asMatch ? asMatch[2] : seg);
			}
		}
	}

	const declRe = /\b(?:const|let|var|function|class)\s+(\w+)/g;
	while ((m = declRe.exec(script)) !== null) out.add(m[1]);

	// Destructured object patterns: `let { a, b: aliased, c = 1, ...rest } = expr`.
	// Critical for Svelte 5 components that pull `page` etc. via `$props()` —
	// without this, the auto-importer injects a duplicate `page` import that
	// collides with the destructured binding (Kit's generated `root.svelte`
	// hits this exactly).
	const objDestructRe = /\b(?:const|let|var)\s*\{([^}]+)\}\s*=/g;
	while ((m = objDestructRe.exec(script)) !== null) {
		const tokenRe = /(?:\.\.\.\s*)?([\w$]+)(?:\s*:\s*([\w$]+))?/g;
		let pm;
		while ((pm = tokenRe.exec(m[1])) !== null) out.add(pm[2] || pm[1]);
	}

	// Destructured array patterns: `let [a, b, ...rest] = expr`.
	const arrDestructRe = /\b(?:const|let|var)\s*\[([^\]]+)\]\s*=/g;
	while ((m = arrDestructRe.exec(script)) !== null) {
		const idRe = /(?:\.\.\.\s*)?([\w$]+)/g;
		let pm;
		while ((pm = idRe.exec(m[1])) !== null) out.add(pm[1]);
	}

	return out;
}

/**
 * @param {Set<string>} referenced
 * @param {Set<string>} declared
 * @param {Array<{ from: string, imports: string[], match?: RegExp }>} helpers
 * @param {Map<string, string>} components            name → absolute file path (from dir scan)
 * @param {string} [filename]
 * @param {{ root?: string, libRoot?: string, libAlias?: string }} [ctx]
 * @param {Record<string, string> | null} [componentSpecs]  name → bare specifier (from user `components` map). Resolved AFTER the dir-scan map so user folders override silently.
 * @param {Map<string, { server?: string; client?: string }> | null} [exports]   name → scoped candidate map. Resolved LAST and gated by importer scope (`isServerPath`).
 * @returns {Array<{ name: string, from: string, kind: 'named' | 'default', annotate?: boolean }>}
 */
function computeImports(
	referenced,
	declared,
	helpers,
	components,
	filename = '',
	ctx = {},
	componentSpecs = null,
	exports = null
) {
	const out = [];
	const root = ctx.root ?? '';
	const libRoot = ctx.libRoot ?? '';
	const libAlias = ctx.libAlias ?? '';

	/** @type {Set<string>} every name we've already added — prevents collisions across helpers / components / specs / exports (resolution order = priority order). */
	const added = new Set();

	const wants = (name) => referenced.has(name) && !declared.has(name) && !added.has(name);

	// 1. Helpers — fastest match, runs first. A path-gated helper (e.g.
	// `$app/state.page` non-server, or `@human-synthesis/norns/server.page`
	// server) takes precedence over project-utility scans for the same name.
	for (const helper of helpers) {
		if (helper.match && !helper.match.test(filename)) continue;
		for (const name of helper.imports) {
			if (wants(name)) {
				out.push({ name, from: helper.from, kind: 'named' });
				added.add(name);
			}
		}
	}

	// 2. Components from dir scan — capitalised basenames in `componentDirs`.
	for (const [name, componentFile] of components) {
		if (!wants(name)) continue;
		const from = resolveComponentPath(componentFile, filename, root, libRoot, libAlias);
		if (from) {
			out.push({ name, from, kind: 'default' });
			added.add(name);
		}
	}

	// 3. Components from bare-specifier map (UI library presets like
	// `presetUI()`). Used verbatim — no $lib aliasing or relative-path
	// computation. A user's dir-scan match (step 2) shadows this silently.
	if (componentSpecs) {
		for (const name of Object.keys(componentSpecs)) {
			if (!wants(name)) continue;
			out.push({ name, from: componentSpecs[name], kind: 'default' });
			added.add(name);
		}
	}

	// 4. Project-utility named exports — `notes` from `$lib/notes/public`, etc.
	// Importer scope decides which candidate is allowed:
	//   - Server importer  → server candidate preferred, falls back to client.
	//   - Client importer  → ONLY a client-safe candidate; server-only exports
	//     are invisible (prevents bundling server code into the client).
	// Auto-injected imports get an `annotate` flag so `renderImports` can mark
	// them with a `// auto-import` comment.
	if (exports) {
		const importerIsServer = isServerPath(filename);
		for (const [name, scoped] of exports) {
			if (!wants(name)) continue;
			const chosenFile = importerIsServer
				? (scoped.server ?? scoped.client)
				: scoped.client;
			if (!chosenFile) continue;
			const from = resolveExportPath(chosenFile, filename, root, libRoot, libAlias);
			if (from) {
				out.push({ name, from, kind: 'named', annotate: true });
				added.add(name);
			}
		}
	}

	return out;
}

/**
 * @param {Array<{ name: string, from: string, kind: 'named' | 'default', annotate?: boolean }>} entries
 * @returns {string}
 */
function renderImports(entries) {
	/** @type {Map<string, { default: string | null, named: string[], annotate: boolean }>} */
	const byFrom = new Map();
	for (const { name, from, kind, annotate } of entries) {
		let g = byFrom.get(from);
		if (!g) {
			g = { default: null, named: [], annotate: false };
			byFrom.set(from, g);
		}
		if (kind === 'default') g.default = name;
		else g.named.push(name);
		if (annotate) g.annotate = true;
	}
	const lines = [];
	for (const [from, { default: def, named, annotate }] of byFrom) {
		const parts = [];
		if (def) parts.push(def);
		if (named.length > 0) parts.push(`{ ${named.join(', ')} }`);
		const stmt = `import ${parts.join(', ')} from '${from}';`;
		lines.push(annotate ? `${stmt} // auto-import` : stmt);
	}
	return lines.join('\n');
}

/**
 * Norns auto-import. The returned object is BOTH a Svelte preprocessor
 * (handles `.n` / `.svelte` markup + script blocks) AND a Vite plugin
 * (handles standalone `.c` / `.civet` modules — server hooks, route
 * handlers, repo / service modules). Wire it in both places:
 *
 * ```js
 * // svelte.config.js
 * import { nornsConfig } from '@human-synthesis/norns/config';
 * import { nornsPreprocess } from '@human-synthesis/norns/preprocess';
 * import { nornsAutoImport } from '@human-synthesis/norns/auto-import';
 *
 * export default nornsConfig({
 *   preprocess: [...nornsPreprocess(), nornsAutoImport()]
 * });
 *
 * // vite.config.js
 * import { nornsCivetPlugin } from '@human-synthesis/norns/vite';
 * import { nornsAutoImport } from '@human-synthesis/norns/auto-import';
 *
 * export default { plugins: [nornsCivetPlugin(), nornsAutoImport()] };
 * ```
 *
 * Detection rules:
 *  - `.n` / `.svelte`: scans markup + `<script>` body. Injects into the
 *    existing script block, or prepends a fresh one when a component is
 *    referenced from markup but no script block exists.
 *  - `.c` / `.civet`: scans the JS that `nornsCivetPlugin` produced and
 *    prepends imports for any referenced helper that's not already in
 *    scope. Components don't apply here.
 *  - Helper modules can carry an optional `match` regex that gates them
 *    by filename — used for the server-only Norns DI/route helpers so
 *    they don't false-positive on a client `.civet` utility.
 *
 * @param {object} [options]
 * @param {Array<{ from: string, imports: string[], match?: RegExp }> | false} [options.helpers]
 *   Override or extend the helper-import list. `false` disables helpers.
 *   Defaults cover `svelte`, `svelte/store`, and `@human-synthesis/norns/server`
 *   (the latter scoped to server-path files via `match`).
 * @param {string[] | false} [options.componentDirs]
 *   Project-relative dirs to scan for components. Default
 *   `['src/lib/components']`. `[]` or `false` disables component auto-import.
 * @param {string[]} [options.componentExtensions]
 *   File extensions treated as components. Default `['.svelte', '.n']`.
 * @param {Record<string, string>} [options.components]
 *   Name → bare-specifier import-path map. Used by UI library presets such
 *   as `presetUI()` from `@human-synthesis/norns-ui/auto-import` —
 *   `{ Btn: '@human-synthesis/norns-ui/components/Btn.n', … }`. Resolved
 *   AFTER `componentDirs`, so a user's `src/lib/components/Btn.n` overrides
 *   the library's `Btn` silently (first-match-wins). The string is used as
 *   the import source verbatim — no `$lib` aliasing or relative-path
 *   computation.
 * @param {string[] | false} [options.exportGlobs]
 *   Glob patterns (project-relative, POSIX separators) matched against files
 *   to scan for named-value exports. The recommended convention is barrel-file
 *   scope — `['src/lib/**\/public.c']` exposes only each feature's intentional
 *   API surface and leaves repo/service/module internals invisible to
 *   auto-import. Supports `**`, `*`, `?`, and `{a,b}` alternation.
 *
 *   Path-based safety is enforced at resolution time: a file under
 *   `/server/` / `*.server.*` / `+server.*` / `hooks.server.*` is classified
 *   server-only and is NEVER auto-imported into a client (non-server) file.
 *   Name collisions inside the same scope are detected at startup, logged,
 *   and excluded from auto-import — forcing an explicit import to disambiguate.
 *
 *   Default `[]` (off; explicit imports for service-layer code).
 * @param {string[]} [options.exportExtensions]
 *   File extensions accepted for exports (defence-in-depth on top of the
 *   glob). Default `['.c', '.civet', '.js']` — `.ts` excluded because
 *   regex-scanned `.ts` can't reliably distinguish value vs type-only exports.
 * @param {string} [options.libRoot]   Default `'src/lib'`.
 * @param {string} [options.libAlias]  Default `'$lib'`.
 * @param {string} [options.root]      Default `process.cwd()`.
 * @param {(msg: string) => void} [options.log]
 *   Channel for conflict warnings. Default `console.warn`. Tests pass a
 *   stub to assert behavior without polluting output.
 */
export function nornsAutoImport(options = {}) {
	const root = options.root ?? process.cwd();
	const helpers = options.helpers === false ? [] : (options.helpers ?? DEFAULT_HELPERS);
	const componentDirs =
		options.componentDirs === false ? [] : (options.componentDirs ?? DEFAULT_COMPONENT_DIRS);
	const componentExts = options.componentExtensions ?? DEFAULT_COMPONENT_EXTS;
	const exportExts = options.exportExtensions ?? DEFAULT_EXPORT_EXTS;
	const libRoot = options.libRoot ?? DEFAULT_LIB_ROOT;
	const libAlias = options.libAlias ?? DEFAULT_LIB_ALIAS;
	const componentSpecs = options.components ?? null;
	const log = options.log ?? console.warn;

	const effectiveGlobs =
		options.exportGlobs === false || options.exportGlobs == null ? [] : options.exportGlobs;

	const components =
		componentDirs.length === 0
			? new Map()
			: buildComponentMap(root, componentDirs, componentExts);
	const rawExports =
		effectiveGlobs.length === 0 ? null : buildExportMap(root, effectiveGlobs, exportExts);
	const exportsMap = rawExports ? resolveExportConflicts(rawExports, log) : null;
	const componentCtx = { root, libRoot, libAlias };

	/** @type {Map<string, string>} */
	const markupByFile = new Map();

	return {
		name: 'norns-auto-import',

		markup({ content, filename }) {
			if (!filename) return null;
			const stripped = content.replace(SCRIPT_OR_STYLE_RE, '');
			markupByFile.set(filename, stripped);

			// If a script block exists, the script hook will handle injection.
			if (/<script\b/i.test(content)) return null;

			// No script block — scan markup alone and prepend a new one if any
			// known identifier is referenced (almost always a component, since
			// helpers like onMount only make sense from script).
			/** @type {Set<string>} */
			const referenced = new Set();
			collectIdentifiers(stripped, referenced);

			const toAdd = computeImports(
				referenced,
				new Set(),
				helpers,
				components,
				filename,
				componentCtx,
				componentSpecs,
				exportsMap
			);
			if (toAdd.length === 0) return null;

			return { code: `<script>\n${renderImports(toAdd)}\n</script>\n${content}` };
		},

		script({ content, attributes, filename }) {
			const lang = attributes?.lang;
			if (lang && lang !== 'js' && lang !== 'javascript' && lang !== 'ts' && lang !== 'typescript') {
				return null;
			}

			const markup = filename ? (markupByFile.get(filename) ?? '') : '';

			/** @type {Set<string>} */
			const referenced = new Set();
			collectIdentifiers(markup, referenced);
			collectIdentifiers(content, referenced);

			const declared = collectDeclared(content);

			const toAdd = computeImports(
				referenced,
				declared,
				helpers,
				components,
				filename,
				componentCtx,
				componentSpecs,
				exportsMap
			);
			if (toAdd.length === 0) return null;

			return { code: `${renderImports(toAdd)}\n${content}` };
		},

		// Vite plugin hook — runs on standalone `.c` / `.civet` modules
		// (server hooks, +page.server.c, repo.c, …). `nornsCivetPlugin`'s
		// `load` already compiled them to JS by the time this fires, so we're
		// scanning real JS. Components don't apply here (server code doesn't
		// import .svelte), only helpers — and the path-based `match` filter
		// keeps server-only helpers (e.g. `@human-synthesis/norns/server`)
		// out of any client `.civet` utility modules.
		enforce: 'post',
		transform(code, id) {
			const [path] = id.split('?');
			if (path.includes('/node_modules/')) return null;
			const ext = extname(path);
			if (ext !== '.c' && ext !== '.civet') return null;

			/** @type {Set<string>} */
			const referenced = new Set();
			collectIdentifiers(code, referenced);
			const declared = collectDeclared(code);

			const toAdd = computeImports(
				referenced,
				declared,
				helpers,
				new Map(),
				path,
				componentCtx,
				null,
				exportsMap
			);
			if (toAdd.length === 0) return null;

			return { code: `${renderImports(toAdd)}\n${code}`, map: null };
		}
	};
}

export {
	buildComponentMap as _buildComponentMap,
	buildExportMap as _buildExportMap,
	collectDeclared as _collectDeclared,
	collectIdentifiers as _collectIdentifiers,
	compileGlob as _compileGlob,
	computeImports as _computeImports,
	extractExports as _extractExports,
	isServerPath as _isServerPath,
	renderImports as _renderImports,
	resolveExportConflicts as _resolveExportConflicts
};
