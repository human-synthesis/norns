import { nornsPreprocess } from '@human-synthesis/norns-core/preprocess';

/**
 * Build a SvelteKit config preconfigured for Norns.
 *
 * Defaults:
 * - `extensions: ['.svelte', '.n']`         — both vanilla and Norns components
 * - `kit.moduleExtensions: ['.js', '.ts', '.c']` — Kit special files (`+page.c` etc.)
 * - `preprocess: nornsPreprocess()`         — Coffee + Pug + rune fusion + auto-close
 *
 * Spread your own overrides at the call site to extend or replace defaults.
 *
 * @param {import('@sveltejs/kit').Config} [overrides]
 * @returns {import('@sveltejs/kit').Config}
 */
export function nornsConfig(overrides = {}) {
	const {
		kit: kitOverrides = {},
		preprocess: preprocessOverride,
		extensions: extensionsOverride,
		...rest
	} = overrides;
	return {
		extensions: extensionsOverride ?? ['.svelte', '.n'],
		preprocess: preprocessOverride ?? nornsPreprocess(),
		kit: {
			moduleExtensions: ['.js', '.ts', '.c'],
			...kitOverrides
		},
		...rest
	};
}
