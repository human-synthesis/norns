import { nornsPreprocess } from '@human-synthesis/norns-core/preprocess';

/**
 * Build a SvelteKit config preconfigured for Norns: Coffee/Pug preprocessing
 * and `.coffee` recognized as a SvelteKit module extension (so files like
 * `+page.coffee` and `hooks.server.coffee` work).
 *
 * Spread your own overrides at the call site to extend or replace defaults.
 *
 * @param {import('@sveltejs/kit').Config} [overrides]
 * @returns {import('@sveltejs/kit').Config}
 */
export function nornsConfig(overrides = {}) {
	const { kit: kitOverrides = {}, preprocess: preprocessOverride, ...rest } = overrides;
	return {
		preprocess: preprocessOverride ?? nornsPreprocess(),
		kit: {
			moduleExtensions: ['.js', '.ts', '.coffee'],
			...kitOverrides
		},
		...rest
	};
}
