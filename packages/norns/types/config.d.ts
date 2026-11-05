/**
 * Build the options for SvelteKit 3's `sveltekit()` Vite plugin, preconfigured
 * for Norns: `.n` components, `.c`/`.civet` module extensions and hooks, the
 * `$lib` alias, and the Pug + Civet preprocessor. A Kit 2 style `kit: {...}`
 * block is flattened into the top level.
 *
 *   sveltekit(nornsConfig({ adapter: adapter() }))
 */
export function nornsConfig(overrides?: Record<string, any>): import("@sveltejs/kit/vite").Config;
