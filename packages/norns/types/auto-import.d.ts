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
export function nornsAutoImport(options?: {
    helpers?: Array<{
        from: string;
        imports: string[];
        match?: RegExp;
    }> | false;
    componentDirs?: string[] | false;
    componentExtensions?: string[];
    components?: Record<string, string>;
    exportGlobs?: string[] | false;
    exportExtensions?: string[];
    libRoot?: string;
    libAlias?: string;
    root?: string;
    log?: (msg: string) => void;
}): {
    name: string;
    markup({ content, filename }: {
        content: any;
        filename: any;
    }): {
        code: string;
    };
    script({ content, attributes, filename }: {
        content: any;
        attributes: any;
        filename: any;
    }): {
        code: string;
    };
    enforce: "post";
    transform(code: any, id: any): {
        code: string;
        map: any;
    };
};
/**
 * @param {string} root
 * @param {string[]} dirs
 * @param {string[]} exts
 * @returns {Map<string, string>}  name → absolute file path
 */
declare function buildComponentMap(root: string, dirs: string[], exts: string[]): Map<string, string>;
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
declare function buildExportMap(root: string, globs: string[], exts: string[]): Map<string, Array<{
    file: string;
    isServer: boolean;
}>>;
/**
 * Names already in the script's lexical scope: existing imports plus
 * top-level declarations. Heuristic regex — covers the common shapes; rare
 * misses just produce a duplicate-import error which the user notices
 * immediately.
 *
 * @param {string} script
 * @returns {Set<string>}
 */
declare function collectDeclared(script: string): Set<string>;
/**
 * Collect every identifier that appears in `source`. Scans raw text — does
 * not strip strings or comments. Worst case is an unused import, which the
 * Svelte / Vite pipeline tree-shakes at build time, so the looseness is
 * cheap.
 *
 * @param {string} source
 * @param {Set<string>} into
 */
declare function collectIdentifiers(source: string, into: Set<string>): void;
declare function compileGlob(pattern: any): RegExp;
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
declare function computeImports(referenced: Set<string>, declared: Set<string>, helpers: Array<{
    from: string;
    imports: string[];
    match?: RegExp;
}>, components: Map<string, string>, filename?: string, ctx?: {
    root?: string;
    libRoot?: string;
    libAlias?: string;
}, componentSpecs?: Record<string, string> | null, exports?: Map<string, {
    server?: string;
    client?: string;
}> | null): Array<{
    name: string;
    from: string;
    kind: "named" | "default";
    annotate?: boolean;
}>;
/**
 * Extract the set of named-value exports declared in `source`. Regex-based;
 * accepts standard ES (`export const`, `export function`, `export {}`) and
 * Civet's `:=` / `.=` operators. Rare misses just mean a name doesn't
 * auto-import; the user notices and adds an explicit import — non-fatal.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
declare function extractExports(source: string): Set<string>;
declare function isServerPath(file: any): boolean;
/**
 * @param {Array<{ name: string, from: string, kind: 'named' | 'default', annotate?: boolean }>} entries
 * @returns {string}
 */
declare function renderImports(entries: Array<{
    name: string;
    from: string;
    kind: "named" | "default";
    annotate?: boolean;
}>): string;
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
declare function resolveExportConflicts(raw: Map<string, Array<{
    file: string;
    isServer: boolean;
}>>, log?: (msg: string) => void): Map<string, {
    server?: string;
    client?: string;
}>;
export { buildComponentMap as _buildComponentMap, buildExportMap as _buildExportMap, collectDeclared as _collectDeclared, collectIdentifiers as _collectIdentifiers, compileGlob as _compileGlob, computeImports as _computeImports, extractExports as _extractExports, isServerPath as _isServerPath, renderImports as _renderImports, resolveExportConflicts as _resolveExportConflicts };
