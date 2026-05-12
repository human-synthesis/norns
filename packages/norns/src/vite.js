import { readFile, stat, realpath, readdir, mkdir, writeFile } from 'node:fs/promises';
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

/* === pugTailwindExtract ==================================================
 *
 * Tailwind v4's content extractor tokenizes candidates against a fixed
 * non-class alphabet. Pug class-shorthand chains followed directly by an
 * attribute paren — `.grid.gap-6(class="…")` — fail that tokenizer: the
 * substring `.gap-6(` reads as one non-class token, so `gap-6` never
 * reaches the candidate set and the CSS rule is never generated.
 *
 * Because the `tag.cls.cls(attrs)` form is idiomatic Pug, asking authors
 * to either move every utility into `class="…"` or hand-maintain a
 * safelist is a paper cut on every page they touch.
 *
 * This plugin walks every `.n` file under `root`, extracts each `.cls`
 * segment via a permissive regex, and writes the deduplicated set into a
 * single sidecar HTML file. Consumers reference the file from their CSS
 * via `@source "./.tailwind-pug-classes.html";` so Tailwind picks it up
 * like any other content source.
 *
 * The regex is permissive on purpose — it captures every `.candidate`
 * segment in the source, including occasional false positives like
 * `.svelte` inside template text. Those are free: Tailwind's own
 * candidate-validation step drops anything that isn't a real utility, so
 * the only cost is a few extra bytes in the sidecar.
 *
 * Runs with `enforce: 'pre'` so the scan sees the raw Pug source, not the
 * Svelte output that the rest of the chain emits.
 * ========================================================================
 */

/**
 * Match every `.candidate` segment. Class names may contain Tailwind's
 * full alphabet — letters, digits, `-`, `_`, `:`, `/`, and arbitrary-value
 * brackets `[...]`. Pug shorthand never contains a `.` inside a class
 * (the dot is the delimiter), so `text-[1.5rem]`-style values never appear
 * in shorthand — those always live inside `class="…"`, which Tailwind
 * extracts directly.
 */
const SEGMENT_RE = /\.([A-Za-z][\w\-:/]*(?:\[[^\]]*\])?)/g;

function extractPugClasses(source) {
	const out = new Set();
	let m;
	SEGMENT_RE.lastIndex = 0;
	while ((m = SEGMENT_RE.exec(source))) {
		if (m[1]) out.add(m[1]);
	}
	return out;
}

async function walkNFiles(dir, ext, out = []) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
			await walkNFiles(full, ext, out);
		} else if (entry.isFile() && full.endsWith(ext)) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Vite plugin that extracts Tailwind class candidates from Pug shorthand
 * in `.n` files and writes them to a sidecar file Tailwind can scan.
 *
 * @param {object} [options]
 * @param {string} [options.root]     Directory to scan (default `src`).
 * @param {string} [options.ext]      File extension (default `.n`).
 * @param {string} [options.outFile]  Sidecar path relative to root
 *                                    (default `.tailwind-pug-classes.html`).
 *                                    Reference it from your CSS with:
 *                                      @source "./.tailwind-pug-classes.html";
 *
 * @returns {import('vite').Plugin}
 */
export function pugTailwindExtract({
	root = 'src',
	ext = '.n',
	outFile = '.tailwind-pug-classes.html'
} = {}) {
	let projectRoot = process.cwd();
	const fileClasses = new Map(); // absolute path -> Set<string>

	async function writeSidecar() {
		const all = new Set();
		for (const set of fileClasses.values()) {
			for (const c of set) all.add(c);
		}
		const sorted = [...all].sort();
		const html =
			'<!-- AUTO-GENERATED by @human-synthesis/norns/vite pugTailwindExtract. Do not edit. -->\n' +
			`<div class="${sorted.join(' ')}"></div>\n`;
		const out = join(projectRoot, root, outFile);
		await mkdir(dirname(out), { recursive: true });
		await writeFile(out, html, 'utf8');
	}

	async function scanFile(abs) {
		try {
			const content = await readFile(abs, 'utf8');
			fileClasses.set(abs, extractPugClasses(content));
		} catch {
			fileClasses.delete(abs);
		}
	}

	async function scanAll() {
		const dir = join(projectRoot, root);
		const files = await walkNFiles(dir, ext);
		await Promise.all(files.map(scanFile));
		await writeSidecar();
	}

	return {
		name: 'norns:pug-tailwind-extract',
		// Run before the Civet/Pug transform so the scan sees raw shorthand.
		enforce: 'pre',
		configResolved(config) {
			projectRoot = config.root || process.cwd();
		},
		async buildStart() {
			await scanAll();
		},
		async handleHotUpdate({ file }) {
			if (!file.endsWith(ext)) return;
			await scanFile(file);
			await writeSidecar();
		},
		configureServer(server) {
			server.watcher.on('add', async (file) => {
				if (!file.endsWith(ext)) return;
				await scanFile(file);
				await writeSidecar();
			});
			server.watcher.on('unlink', async (file) => {
				if (!file.endsWith(ext)) return;
				fileClasses.delete(file);
				await writeSidecar();
			});
		}
	};
}
