import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nornsPreprocess } from '@human-synthesis/norns-core/preprocess';

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
export function nornsConfig(overrides = {}) {
	const {
		kit: kitOverrides = {},
		preprocess: preprocessOverride,
		extensions: extensionsOverride,
		...rest
	} = overrides;

	const cwd = process.cwd();
	const userFiles = kitOverrides.files ?? {};
	const userHooks = userFiles.hooks ?? {};

	const hooks = {
		...userHooks,
		server: userHooks.server ?? findHook(cwd, ['src/hooks.server.c', 'src/hooks.server.civet']),
		client: userHooks.client ?? findHook(cwd, ['src/hooks.client.c', 'src/hooks.client.civet']),
		universal: userHooks.universal ?? findHook(cwd, ['src/hooks.c', 'src/hooks.civet'])
	};
	// Drop keys whose value is undefined so SvelteKit applies its defaults
	for (const k of /** @type {const} */ (['server', 'client', 'universal'])) {
		if (hooks[k] === undefined) delete hooks[k];
	}

	const { files: _ignoredUserFiles, ...kitRest } = kitOverrides;

	return {
		extensions: extensionsOverride ?? ['.svelte', '.n'],
		preprocess: preprocessOverride ?? nornsPreprocess(),
		kit: {
			moduleExtensions: ['.js', '.ts', '.c', '.civet'],
			...kitRest,
			files: {
				...userFiles,
				hooks
			}
		},
		...rest
	};
}

/**
 * Return the first relative path whose file exists, or `undefined` so
 * SvelteKit falls back to its default `.js` / `.ts` resolution.
 *
 * @param {string} cwd
 * @param {string[]} candidates
 * @returns {string | undefined}
 */
function findHook(cwd, candidates) {
	for (const rel of candidates) {
		if (existsSync(join(cwd, rel))) return rel;
	}
	return undefined;
}
