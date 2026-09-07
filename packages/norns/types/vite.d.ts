/**
 * Vite plugin that:
 *  - compiles `.civet` and `.c` files via @danielx/civet, so SvelteKit
 *    special files like `+page.civet`, `+page.server.c`, `hooks.server.civet`,
 *    and `+server.c` work the same as their `.js` / `.ts` counterparts;
 *  - registers `.svelte`, `.n`, `.civet`, `.c` with Vite's resolver so bare
 *    imports (`import X from './Foo'`) try those extensions in priority
 *    order, on top of Vite's defaults;
 *  - resolves bare-name imports (`import X from 'Foo'`, no `./` prefix) to a
 *    sibling file when one exists, in the same priority order. Real package
 *    imports (`'svelte/store'`, `'@scope/pkg'`) are unaffected because they
 *    contain a slash or scope marker;
 *  - in workspace-linked dev (sibling repos symlinked into node_modules),
 *    excludes the framework packages from `optimizeDeps` pre-bundling and
 *    lifts them out of the default `**\/node_modules\/**` watch ignore so
 *    Vite reads source on each request and HMR fires. No-op for normal
 *    (published) installs. The companion `norns dev` CLI handles
 *    process-level respawn when framework source changes — needed because
 *    Node's ESM module cache survives `server.restart()`.
 *
 * `.c` is recognised as an alias for `.civet` — both compile through Civet.
 *
 * @returns {import('vite').Plugin}
 */
export function nornsCivetPlugin(): import("vite").Plugin;
/**
 * Vite plugin that extracts Tailwind class candidates from Pug shorthand
 * in `.n` files and writes them to a sidecar file Tailwind can scan.
 *
 * @param {object} [options]
 * @param {string} [options.root]     Directory to scan (default `src`).
 * @param {string} [options.ext]      File extension (default `.n`).
 * @param {string} [options.outFile]  Sidecar path relative to the project
 *                                    root. The path is taken verbatim. Defaults
 *                                    to `node_modules/.cache/norns/tailwind-pug-classes.html`
 *                                    — node_modules is gitignored everywhere
 *                                    and `.cache/` is the conventional spot
 *                                    for build artifacts. Reference it from
 *                                    your CSS via `@source` with a path
 *                                    relative to the importing CSS file.
 *
 * @returns {import('vite').Plugin}
 */
export function pugTailwindExtract({ root, ext, outFile }?: {
    root?: string;
    ext?: string;
    outFile?: string;
}): import("vite").Plugin;
