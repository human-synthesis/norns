import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile as compileCivet } from '@danielx/civet';

/**
 * Compile a `.c` / `.civet` file (or the `<script lang="civet">` block of a
 * `.n` / `.svelte` file) to plain JS so callers can inspect what Civet
 * actually produced. The diagnosis recipe is:
 *
 *   bun norns diag path/to/file.c
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
