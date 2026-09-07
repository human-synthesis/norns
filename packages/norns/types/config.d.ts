/**
 * Build a SvelteKit config preconfigured for Norns.
 *
 * Defaults:
 * - `extensions: ['.svelte', '.n']`         — both vanilla and Norns components
 * - `kit.moduleExtensions: ['.js', '.ts', '.c', '.civet']` — Kit special files
 *   (`+page.c`, `+page.civet`, etc.)
 * - `kit.files.hooks.server` — set to `src/hooks.server.{c,civet}` if either
 *   file exists. SvelteKit's upstream `resolve_entry` only searches `.js` /
 *   `.ts` for hooks (it doesn't honor `moduleExtensions`), so the explicit
 *   path is the non-invasive way to make `.c`/`.civet` hooks discoverable.
 *   Same for the client and universal counterparts.
 * - `preprocess: nornsPreprocess()`         — Pug + Civet
 *
 * Spread your own overrides at the call site to extend or replace defaults.
 *
 * @param {import('@sveltejs/kit').Config} [overrides]
 * @returns {import('@sveltejs/kit').Config}
 */
export function nornsConfig(overrides?: import("@sveltejs/kit").Config): import("@sveltejs/kit").Config;
