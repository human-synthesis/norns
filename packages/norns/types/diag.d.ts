/**
 * Compile a `.c` / `.civet` file (or the `<script lang="civet">` block of a
 * `.n` / `.svelte` file) to plain JS so callers can inspect what Civet
 * actually produced. The diagnosis recipe is:
 *
 *   bunx norns diag path/to/file.c
 *
 * Use it when a Civet error message is unhelpful — the compiled output
 * proves whether the source is correct and the bug is downstream.
 *
 * @param {string} file path (relative or absolute)
 * @returns {Promise<string>} compiled JS
 */
export function nornsDiag(file: string): Promise<string>;
/**
 * Run a `.n` / `.svelte` file through the given Svelte preprocessor chain
 * (normally the project's `svelte.config.js` `preprocess`) and return the
 * resulting Svelte source: Pug rendered to markup, Civet compiled to JS,
 * auto-imports injected. This is exactly what the Svelte compiler sees, so
 * it is the place to look when a compile error quotes markup you never
 * wrote.
 *
 *   bunx norns diag --template src/routes/+page.n
 *
 * @param {string} file
 * @param {import('svelte/compiler').PreprocessorGroup | import('svelte/compiler').PreprocessorGroup[]} preprocessors
 * @returns {Promise<string>}
 */
export function nornsDiagTemplate(file: string, preprocessors: import("svelte/compiler").PreprocessorGroup | import("svelte/compiler").PreprocessorGroup[]): Promise<string>;
