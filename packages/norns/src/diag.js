import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { compile as compileCivet } from '@danielx/civet';

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
export async function nornsDiag(file) {
	const abs = resolve(file);
	if (!existsSync(abs)) throw new Error(`No such file: ${file}`);

	const content = readFileSync(abs, 'utf8');
	let source = content;

	if (abs.endsWith('.n') || abs.endsWith('.svelte')) {
		const m = content.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
		if (!m) throw new Error(`No <script> block in ${file}`);
		source = m[1];
	}

	const result = await compileCivet(source, {
		js: true,
		filename: abs
	});
	// Civet returns a plain string when no sourceMap option is supplied,
	// otherwise an object with `.code`. Handle both.
	return typeof result === 'string' ? result : result.code;
}

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
export async function nornsDiagTemplate(file, preprocessors) {
	const abs = resolve(file);
	if (!existsSync(abs)) throw new Error(`No such file: ${file}`);
	if (!abs.endsWith('.n') && !abs.endsWith('.svelte')) {
		throw new Error(`--template expects a .n or .svelte file, got ${basename(abs)}`);
	}
	const { preprocess } = await import('svelte/compiler');
	const content = readFileSync(abs, 'utf8');
	const result = await preprocess(content, preprocessors, { filename: abs });
	return result.code;
}
