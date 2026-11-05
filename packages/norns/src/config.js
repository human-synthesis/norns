import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nornsPreprocess } from '@human-synthesis/norns-core/preprocess';

/**
 * Build the options for SvelteKit 3's `sveltekit()` Vite plugin, preconfigured
 * for Norns. SvelteKit 3 no longer reads `svelte.config.js`; pass the result
 * straight to the plugin:
 *
 *   sveltekit(nornsConfig({ adapter: adapter() }))
 *
 * Defaults:
 * - `extensions: ['.svelte', '.n']`         — both vanilla and Norns components
 * - `moduleExtensions: ['.js', '.ts', '.c', '.civet']` — Kit special files
 *   (`+page.c`, `+page.civet`, etc.)
 * - `files.hooks.*` — set to `src/hooks.server.{c,civet}` (and the client /
 *   universal counterparts) when such a file exists, so `.c`/`.civet` hooks
 *   are found regardless of SvelteKit's entry resolution.

 * The `$lib` alias (which SvelteKit 3 no longer provides) comes from
 * `nornsCivetPlugin()` as a plain Vite alias — Kit's own `alias` option is
 * deprecated.
 * - `preprocess: nornsPreprocess()`         — Pug + Civet
 *
 * A SvelteKit 2 style `kit: { ... }` block is still accepted and flattened
 * into the top level, so older call sites keep working.
 *
 * @param {Record<string, any>} [overrides]
 * @returns {import('@sveltejs/kit/vite').Config}
 */
export function nornsConfig(overrides = {}) {
	const {
		kit: legacyKit = {},
		preprocess: preprocessOverride,
		extensions: extensionsOverride,
		...flat
	} = overrides;

	// Flatten the Kit 2 `kit` namespace; explicit top-level keys win.
	const options = { ...legacyKit, ...flat };

	const cwd = process.cwd();
	const userFiles = options.files ?? {};
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

	const { files: _files, ...rest } = options;

	return {
		extensions: extensionsOverride ?? ['.svelte', '.n'],
		preprocess: preprocessOverride ?? nornsPreprocess(),
		moduleExtensions: ['.js', '.ts', '.c', '.civet'],
		...rest,
		files: {
			...userFiles,
			hooks
		}
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
