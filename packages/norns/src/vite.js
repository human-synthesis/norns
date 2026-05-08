import { readFile, stat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { compile as compileCivet } from '@danielx/civet';

const DEFAULT_EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];
const NORNS_EXTENSIONS = ['.svelte', '.n', '.civet', '.c'];
const RESOLVE_EXTENSIONS = [...NORNS_EXTENSIONS, '.ts', '.js'];
const FRAMEWORK_PKGS = ['@human-synthesis/norns-core', '@human-synthesis/norns'];

async function fileExists(path) {
	try {
		const s = await stat(path);
		return s.isFile();
	} catch {
		return false;
	}
}

/**
 * Resolve framework package src dirs that live OUTSIDE the consuming app's
 * node_modules (i.e. workspace symlinks pointing at sibling repos). Returns
 * real on-disk paths to watch. Empty array when packages are installed
 * normally — published consumers never enter this branch.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function resolveWorkspaceFrameworkSrcs(root) {
	const require = createRequire(join(root, 'package.json'));
	const out = [];
	for (const pkg of FRAMEWORK_PKGS) {
		try {
			const pkgJsonPath = require.resolve(`${pkg}/package.json`);
			const real = await realpath(pkgJsonPath);
			const pkgDir = dirname(real);
			// Only watch when the real path resolves outside any node_modules —
			// that's the workspace-symlink case. A normal install resolves to
			// a real path inside node_modules and we leave it alone.
			if (!pkgDir.includes(`${join('/', 'node_modules', '/')}`)) {
				out.push(join(pkgDir, 'src'));
			}
		} catch {
			// Package not installed (e.g. only norns-core present) — skip.
		}
	}
	return out;
}

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
 * CoffeeScript is no longer supported.
 *
 * @returns {import('vite').Plugin}
 */
export function nornsCivetPlugin() {
	/** @type {string[]} */
	let watchSrcs = [];
	return {
		name: 'norns:civet',
		enforce: 'pre',
		async config(_userConfig, { command }) {
			if (command === 'serve') {
				watchSrcs = await resolveWorkspaceFrameworkSrcs(process.cwd());
			}
			/** @type {import('vite').UserConfig} */
			const cfg = {
				resolve: {
					extensions: [...DEFAULT_EXTENSIONS, ...NORNS_EXTENSIONS]
				},
				optimizeDeps: {
					exclude: [...FRAMEWORK_PKGS]
				}
			};
			if (watchSrcs.length > 0) {
				cfg.server = {
					fs: { allow: watchSrcs.map((p) => dirname(p)) },
					watch: {
						ignored: [
							'**/.git/**',
							(path) => {
								if (watchSrcs.some((src) => path.startsWith(src))) return false;
								return path.includes(`${join('/', 'node_modules', '/')}`);
							}
						]
					}
				};
			}
			return cfg;
		},
		async resolveId(source, importer) {
			if (!importer) return null;
			// Already explicit relative or absolute — let the default resolver run.
			if (source.startsWith('.') || source.startsWith('/')) return null;
			// Scoped package or package-with-subpath — treat as a bare module.
			if (source.startsWith('@') || source.includes('/')) return null;
			// Skip imports from inside node_modules — library code uses proper
			// module resolution; we'd otherwise hijack legitimate package imports
			// (e.g. `import { parse } from 'cookie'`) when a sibling file with
			// the same name happens to exist in the same dir.
			if (importer.includes(`${join('/', 'node_modules', '/')}`)) return null;

			// Single bare name — try resolving as a sibling file first, falling
			// back to the default resolver (node_modules) if nothing matches.
			const dir = dirname(importer);
			for (const ext of RESOLVE_EXTENSIONS) {
				const candidate = join(dir, source + ext);
				if (await fileExists(candidate)) return candidate;
			}
			return null;
		},
		async load(id) {
			const [path] = id.split('?');
			if (!path.endsWith('.civet') && !path.endsWith('.c')) return null;
			const source = await readFile(path, 'utf8');
			const result = await compileCivet(source, {
				js: true,
				sourceMap: true,
				filename: path
			});
			return { code: result.code, map: result.sourceMap?.json?.(path) ?? null };
		}
	};
}
