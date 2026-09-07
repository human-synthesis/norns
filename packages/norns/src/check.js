import { readFileSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile as compileCivet } from '@danielx/civet';
import { walk } from './lint.js';

/**
 * `norns check` — compile-check every Norns source file the way the build
 * does, without running the build.
 *
 *   - `.n` / `.svelte` (any extension in the project's `extensions`) go
 *     through the project's own `svelte.config.js` preprocess chain (Pug,
 *     Civet, auto-imports) and then the Svelte compiler.
 *   - `.c` / `.civet` modules go through the Civet compiler.
 *
 * Errors carry `file:line:column` in the *source* file where the pipeline
 * can map them (Pug and Civet errors are mapped by norns-core; Svelte compile
 * errors are mapped through the preprocess source map when one is available
 * — template positions usually are not, and are then reported as positions
 * in the preprocessed output with `mapped: false`).
 *
 * @typedef {{
 *   file: string,
 *   line: number | null,
 *   column: number | null,
 *   message: string,
 *   stage: 'civet' | 'pug' | 'preprocess' | 'svelte',
 *   code?: string,
 *   frame?: string | null,
 *   mapped: boolean
 * }} CheckDiagnostic
 *
 * @typedef {{ files: number, errors: CheckDiagnostic[], warnings: CheckDiagnostic[] }} CheckResult
 */

/**
 * Load `svelte.config.js` from `cwd` (ESM). Returns null when absent.
 *
 * @param {string} cwd
 * @returns {Promise<import('@sveltejs/kit').Config | null>}
 */
export async function loadSvelteConfig(cwd) {
	for (const name of ['svelte.config.js', 'svelte.config.mjs']) {
		const p = join(cwd, name);
		if (existsSync(p)) {
			const mod = await import(pathToFileURL(p).href);
			return mod.default ?? mod;
		}
	}
	return null;
}

async function loadTraceMapping() {
	try {
		return await import('@jridgewell/trace-mapping');
	} catch {
		return null;
	}
}

/**
 * @param {string} source
 * @param {number} line 1-based
 * @param {number | null} column 1-based
 * @returns {string}
 */
export function codeFrame(source, line, column) {
	const lines = source.split('\n');
	const from = Math.max(1, line - 2);
	const to = Math.min(lines.length, line + 1);
	const width = String(to).length;
	const out = [];
	for (let n = from; n <= to; n++) {
		const marker = n === line ? '>' : ' ';
		out.push(`${marker} ${String(n).padStart(width)}| ${lines[n - 1] ?? ''}`);
		if (n === line && column) {
			out.push(`  ${' '.repeat(width)}| ${' '.repeat(Math.max(0, column - 1))}^`);
		}
	}
	return out.join('\n');
}

function firstLine(msg) {
	return String(msg).split('\n')[0];
}

/**
 * Strip a leading `file:line:col` / `file:line:col:` prefix that norns-core
 * and Civet put on their messages so it isn't printed twice.
 */
function stripLocationPrefix(msg) {
	return msg.replace(/^\S+:\d+:\d+:?\s*/, '');
}

/**
 * @param {{
 *   cwd?: string,
 *   preprocess?: any,
 *   extensions?: string[],
 *   srcDir?: string,
 *   warnings?: boolean
 * }} [opts]
 * @returns {Promise<CheckResult>}
 */
export async function nornsCheck(opts = {}) {
	const cwd = opts.cwd ?? process.cwd();
	let pre = opts.preprocess;
	let extensions = opts.extensions;

	if (pre === undefined || extensions === undefined) {
		const config = await loadSvelteConfig(cwd);
		if (pre === undefined) {
			if (config?.preprocess) pre = config.preprocess;
			else {
				const { nornsPreprocess } = await import('@human-synthesis/norns-core/preprocess');
				pre = nornsPreprocess();
			}
		}
		if (extensions === undefined) extensions = config?.extensions ?? ['.svelte', '.n'];
	}

	const { preprocess, compile } = await import('svelte/compiler');
	const trace = await loadTraceMapping();

	const srcDir = opts.srcDir ?? (existsSync(join(cwd, 'src')) ? join(cwd, 'src') : cwd);
	const componentFiles = walk(srcDir, (n) => extensions.some((ext) => n.endsWith(ext)));
	const moduleFiles = walk(srcDir, (n) => n.endsWith('.c') || n.endsWith('.civet'));

	/** @type {CheckDiagnostic[]} */
	const errors = [];
	/** @type {CheckDiagnostic[]} */
	const warnings = [];
	const rel = (f) => relative(cwd, f);

	for (const file of componentFiles) {
		const source = readFileSync(file, 'utf8');
		let processed;
		try {
			processed = await preprocess(source, pre, { filename: file });
		} catch (e) {
			errors.push(preprocessError(e, rel(file), source));
			continue;
		}

		try {
			const result = compile(processed.code, {
				filename: file,
				generate: 'client'
			});
			if (opts.warnings) {
				for (const w of result.warnings ?? []) {
					warnings.push(
						svelteDiagnostic(w, rel(file), source, processed, trace, w.code, w.message)
					);
				}
			}
		} catch (e) {
			errors.push(svelteDiagnostic(e, rel(file), source, processed, trace, e.code, e.message));
		}
	}

	for (const file of moduleFiles) {
		const source = readFileSync(file, 'utf8');
		try {
			await compileCivet(source, { js: true, filename: file });
		} catch (e) {
			const line = typeof e.line === 'number' ? e.line : null;
			const column = typeof e.column === 'number' ? e.column : null;
			errors.push({
				file: rel(file),
				line,
				column,
				message: `Civet: ${stripLocationPrefix(firstLine(e.message))}`,
				stage: 'civet',
				frame: line ? codeFrame(source, line, column) : null,
				mapped: true
			});
		}
	}

	return { files: componentFiles.length + moduleFiles.length, errors, warnings };
}

/**
 * @param {any} e
 * @param {string} file
 * @param {string} source
 * @returns {CheckDiagnostic}
 */
function preprocessError(e, file, source) {
	const line = typeof e.line === 'number' ? e.line : null;
	const column = typeof e.column === 'number' ? e.column : null;
	/** @type {CheckDiagnostic['stage']} */
	let stage = 'preprocess';
	if (e.code === 'norns_pug_error') stage = 'pug';
	else if (e.code === 'norns_civet_error' || e.name === 'ParseError') stage = 'civet';
	const label = stage === 'pug' ? 'Pug' : stage === 'civet' ? 'Civet' : 'Preprocess';
	let message = stripLocationPrefix(firstLine(e.message));
	message = message.replace(/^(Pug|Civet):\s*/, '');
	return {
		file,
		line,
		column,
		message: `${label}: ${message}`,
		stage,
		frame: e.frame ?? (line ? codeFrame(source, line, column) : null),
		mapped: line !== null && !e.approximate
	};
}

/**
 * @param {any} e Svelte CompileError or warning
 * @returns {CheckDiagnostic}
 */
function svelteDiagnostic(e, file, source, processed, trace, code, message) {
	const start = e.start ?? null;
	let line = start?.line ?? null;
	let column = start?.column != null ? start.column + 1 : null;
	let mapped = false;

	if (line && processed?.map && trace) {
		try {
			const map = new trace.TraceMap(processed.map);
			const pos = trace.originalPositionFor(map, { line, column: (start.column ?? 1) - 0 });
			if (pos && pos.line != null) {
				line = pos.line;
				column = pos.column != null ? pos.column + 1 : null;
				mapped = true;
			}
		} catch {
			// no usable map — fall through with preprocessed positions
		}
	}

	// A source map that maps back to the same line of a Pug-rendered
	// template is only trustworthy when the mapped line actually contains
	// the offending text; otherwise stay honest and say "unmapped".
	if (mapped) {
		const srcLine = source.split('\n')[line - 1] ?? '';
		const outLine = processed.code.split('\n')[start.line - 1] ?? '';
		if (!srcLine.trim() || (outLine.trim() && !looksRelated(srcLine, outLine))) mapped = false;
	}

	const frame = mapped
		? codeFrame(source, line, column)
		: line
			? codeFrame(processed.code, start.line, (start.column ?? 0) + 1)
			: null;

	return {
		file,
		line: mapped ? line : start?.line ?? null,
		column: mapped ? column : start?.column != null ? start.column + 1 : null,
		message: mapped
			? `Svelte: ${firstLine(message)}`
			: `Svelte: ${firstLine(message)} (position is in the preprocessed output — run \`norns diag --template ${file}\` to see it)`,
		stage: 'svelte',
		code,
		frame,
		mapped
	};
}

/** Heuristic: do two lines share a meaningful token? */
function looksRelated(a, b) {
	const tokens = (s) =>
		new Set(
			s
				.split(/[^\w$.-]+/)
				.map((t) => t.trim())
				.filter((t) => t.length >= 3)
		);
	const ta = tokens(a);
	for (const t of tokens(b)) if (ta.has(t)) return true;
	return false;
}

/**
 * Pretty-print a check result. Returns the error count.
 *
 * @param {CheckResult} result
 * @returns {number}
 */
export function printCheck(result) {
	const all = [...result.errors.map((e) => ({ ...e, severity: 'error' })), ...result.warnings.map((w) => ({ ...w, severity: 'warning' }))];
	if (all.length === 0) {
		console.log(`norns check: ${result.files} file(s), no errors.`);
		return 0;
	}
	/** @type {Map<string, any[]>} */
	const byFile = new Map();
	for (const d of all) {
		if (!byFile.has(d.file)) byFile.set(d.file, []);
		byFile.get(d.file).push(d);
	}
	for (const [file, items] of byFile) {
		for (const d of items.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))) {
			const loc = d.line ? `${file}:${d.line}${d.column ? `:${d.column}` : ''}` : file;
			const tag = d.severity === 'error' ? 'error' : 'warn ';
			console.log(`\n${loc}  ${tag}  ${d.message}`);
			if (d.frame) console.log(d.frame.replace(/^/gm, '    '));
		}
	}
	console.log(
		`\nnorns check: ${result.errors.length} error(s), ${result.warnings.length} warning(s) across ${result.files} file(s).`
	);
	return result.errors.length;
}

/** @param {string} file */
export function isComponentFile(file, extensions = ['.svelte', '.n']) {
	return extensions.some((ext) => basename(file).endsWith(ext));
}
