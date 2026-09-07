import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

export const SKIP_DIRS = new Set([
	'node_modules',
	'.svelte-kit',
	'.git',
	'build',
	'dist',
	'static',
	'.next',
	'.cache',
	'.turbo',
	'data',
	'coverage'
]);

/**
 * @typedef {{ file: string; line: number; severity: 'error' | 'warning'; rule: string; msg: string }} Finding
 */

/**
 * Recursively list files under `dir` whose basename passes `filter`,
 * skipping build/vendor directories and dot-directories.
 *
 * @param {string} dir
 * @param {(name: string) => boolean} filter
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function walk(dir, filter, out = []) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.') && entry.name !== '.') continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walk(full, filter, out);
		} else if (entry.isFile() && filter(entry.name)) {
			out.push(full);
		}
	}
	return out.sort();
}

/** Remove string and template literals from a line so regexes don't match inside them. */
function stripStrings(line) {
	let out = '';
	let mode = 0; // 0=code, 1=', 2=", 3=`
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		const prev = line[i - 1];
		if (mode === 0) {
			if (c === "'") mode = 1;
			else if (c === '"') mode = 2;
			else if (c === '`') mode = 3;
			else out += c;
		} else if (mode === 1 && c === "'" && prev !== '\\') mode = 0;
		else if (mode === 2 && c === '"' && prev !== '\\') mode = 0;
		else if (mode === 3 && c === '`' && prev !== '\\') mode = 0;
	}
	return out;
}

/**
 * Civet rules. Runs over a whole `.c` / `.civet` file, or over the body of
 * a `<script>` block in a `.n` / `.svelte` file (with `lineOffset` set to
 * the line the block's content starts on, so findings point at the file).
 *
 * @param {string} file
 * @param {string} content
 * @param {number} [lineOffset]
 * @returns {Finding[]}
 */
function lintCivetSource(file, content, lineOffset = 0) {
	/** @type {Finding[]} */
	const out = [];
	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const ln = lines[i];
		const lineNo = i + 1 + lineOffset;
		const trimmed = ln.trim();
		if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;

		const codeOnly = stripStrings(ln);

		// `isnt` compiles to an undefined identifier reference at runtime.
		if (/\bisnt\b/.test(codeOnly)) {
			out.push({
				file,
				line: lineNo,
				severity: 'error',
				rule: 'civet/no-isnt',
				msg: '`isnt` compiles to a bare identifier reference. Use `!==`.'
			});
		}

		// `async *name(` as class method shorthand — Civet parser rejects it.
		// Match indented lines (likely inside a class) where the next token after
		// `async *` is an identifier followed by `(`.
		if (/^\s+async\s*\*\s*\w+\s*\(/.test(ln)) {
			out.push({
				file,
				line: lineNo,
				severity: 'error',
				rule: 'civet/no-async-generator-method',
				msg: 'Civet rejects `async *name()` as class method shorthand. Use a callback API or top-level `async function*`.'
			});
		}

		// `:= $state` (const) then later reassignment of the same name.
		const stateConst = codeOnly.match(/(?:^|[\s,({[])(\w+)\s*:=\s*\$state\b/);
		if (stateConst) {
			const name = stateConst[1];
			const reassignRe = new RegExp(`^\\s*${name}\\s*(?:=(?!=|>)|\\+\\+|--|[-+*/]=)`);
			for (let j = i + 1; j < lines.length; j++) {
				if (reassignRe.test(stripStrings(lines[j]))) {
					out.push({
						file,
						line: lineNo,
						severity: 'error',
						rule: 'civet/state-const-reassign',
						msg: `\`${name}\` uses \`:=\` ($state const) but is reassigned at line ${j + 1 + lineOffset}. Use \`.=\` for $state values you reassign.`
					});
					break;
				}
			}
		}
	}

	return out;
}

/**
 * @param {string} file
 * @param {string} content
 * @returns {Finding[]}
 */
function lintCivetFile(file, content) {
	return lintCivetSource(file, content, 0);
}

/**
 * Locate `<script>` / `<style>` blocks. Returns character ranges plus, for
 * script blocks, the body and the line its content starts on.
 *
 * @param {string} content
 */
function findBlocks(content) {
	const ranges = [];
	const scripts = [];
	const blockRe = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
	let m;
	while ((m = blockRe.exec(content)) !== null) {
		ranges.push([m.index, m.index + m[0].length]);
		if (m[1].toLowerCase() === 'script') {
			const attrs = m[2];
			const body = m[3];
			const bodyStart = m.index + m[0].indexOf('>') + 1;
			const lineOffset = content.slice(0, bodyStart).split('\n').length - 1;
			scripts.push({ attrs, body, lineOffset });
		}
	}
	return { ranges, scripts };
}

/**
 * Lint a `.n` (or `.svelte`) component: Pug rules over the template lines,
 * Civet rules over every `<script>` block whose language is Civet (which is
 * the `.n` default when `lang` is omitted).
 *
 * @param {string} file
 * @param {string} content
 * @returns {Finding[]}
 */
function lintNornFile(file, content) {
	/** @type {Finding[]} */
	const out = [];

	const { ranges, scripts } = findBlocks(content);
	const isNorn = file.endsWith('.n');

	for (const s of scripts) {
		const langMatch = s.attrs.match(/\blang\s*=\s*["']?([\w-]+)/i);
		const lang = langMatch ? langMatch[1].toLowerCase() : isNorn ? 'civet' : 'js';
		if (lang === 'civet' || lang === 'cv') {
			out.push(...lintCivetSource(file, s.body, s.lineOffset));
		}
	}

	// Map line index → starting offset
	const lineStart = [0];
	for (let i = 0; i < content.length; i++) {
		if (content[i] === '\n') lineStart.push(i + 1);
	}
	const inBlock = (lineNo) => {
		const s = lineStart[lineNo - 1];
		return ranges.some(([a, b]) => s >= a && s < b);
	};

	const lines = content.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const ln = lines[i];
		const lineNo = i + 1;
		if (inBlock(lineNo)) continue;
		const trimmed = ln.trim();
		if (!trimmed || trimmed.startsWith('//')) continue;

		// `{@html ...}` / `{#each}` etc. at start of pug line without `| ` prefix.
		if (/^\s*\{[@#:/]/.test(ln)) {
			out.push({
				file,
				line: lineNo,
				severity: 'error',
				rule: 'pug/svelte-block-needs-pipe',
				msg: 'Leading `{` is parsed by Pug as a tag. Prefix with `| ` to emit as text.'
			});
		}

		// `#{expr}` Pug interpolation — evaluates at preprocess time, not runtime.
		// Allow `\#{` escaped form.
		if (/(^|[^\\])#\{/.test(ln)) {
			out.push({
				file,
				line: lineNo,
				severity: 'error',
				rule: 'pug/no-pug-interpolation',
				msg: 'Pug `#{expr}` evaluates at preprocess time. Use Svelte `{expr}` for runtime data.'
			});
		}

		// `+each('item of items')` — the `of` form is copied verbatim into the
		// Svelte block and rejected by the compiler. Svelte wants `items as item`.
		const each = trimmed.match(/^\+each\s*\(\s*(['"])(.+)\1\s*\)/);
		if (each && /^\s*[\w$[\]{}, ]+\s+of\s+/.test(each[2]) && !/\s+as\s+/.test(each[2])) {
			out.push({
				file,
				line: lineNo,
				severity: 'error',
				rule: 'pug/each-as-form',
				msg: 'Svelte `{#each}` takes `items as item`, not `item of items`. Write `+each(\'items as item\')` (optionally `(item.id)` for the key).'
			});
		}
	}

	return out;
}

/**
 * @param {string} file
 * @param {string} content
 * @returns {Finding[]}
 */
function lintViteConfig(file, content) {
	/** @type {Finding[]} */
	const out = [];
	if (!/allowedHosts\s*:\s*(true|\[)/.test(content)) {
		out.push({
			file,
			line: 1,
			severity: 'warning',
			rule: 'vite/allowed-hosts',
			msg: 'Set `server.allowedHosts: true` (or an explicit list) so Vite accepts reverse-proxied Host headers in dev.'
		});
	}
	return out;
}

/**
 * @param {string} cwd
 * @returns {Finding[]}
 */
export function nornsLint(cwd) {
	/** @type {Finding[]} */
	const findings = [];

	const srcDir = existsSync(join(cwd, 'src')) ? join(cwd, 'src') : cwd;
	const civetFiles = walk(srcDir, (n) => n.endsWith('.c') || n.endsWith('.civet'));
	const nornFiles = walk(srcDir, (n) => n.endsWith('.n'));

	for (const f of civetFiles) {
		try {
			findings.push(...lintCivetFile(f, readFileSync(f, 'utf8')));
		} catch (e) {
			findings.push({
				file: f,
				line: 1,
				severity: 'warning',
				rule: 'lint/read-error',
				msg: `Could not read: ${e.message}`
			});
		}
	}
	for (const f of nornFiles) {
		try {
			findings.push(...lintNornFile(f, readFileSync(f, 'utf8')));
		} catch (e) {
			findings.push({
				file: f,
				line: 1,
				severity: 'warning',
				rule: 'lint/read-error',
				msg: `Could not read: ${e.message}`
			});
		}
	}

	const viteCfg = ['vite.config.js', 'vite.config.ts', 'vite.config.mjs']
		.map((n) => join(cwd, n))
		.find(existsSync);
	if (viteCfg) {
		findings.push(...lintViteConfig(viteCfg, readFileSync(viteCfg, 'utf8')));
	}

	return findings.map((f) => ({ ...f, file: relative(cwd, f.file) }));
}

/**
 * Lint a single source string (used by tests and by editors that want to
 * lint an unsaved buffer). `file` decides which rule set applies.
 *
 * @param {string} file
 * @param {string} content
 * @returns {Finding[]}
 */
export function lintSource(file, content) {
	if (file.endsWith('.c') || file.endsWith('.civet')) return lintCivetFile(file, content);
	if (file.endsWith('.n') || file.endsWith('.svelte')) return lintNornFile(file, content);
	if (/vite\.config\.(js|ts|mjs)$/.test(file)) return lintViteConfig(file, content);
	return [];
}

/**
 * Summarize findings.
 *
 * @param {Finding[]} findings
 * @returns {{ errors: number; warnings: number }}
 */
export function countFindings(findings) {
	let errors = 0;
	let warnings = 0;
	for (const f of findings) {
		if (f.severity === 'error') errors++;
		else warnings++;
	}
	return { errors, warnings };
}

/**
 * Pretty-print findings. Returns the number of errors.
 * @param {Finding[]} findings
 * @returns {{ errors: number; warnings: number }}
 */
export function printFindings(findings) {
	if (findings.length === 0) {
		console.log('norns lint: no issues found.');
		return { errors: 0, warnings: 0 };
	}
	// Group by file for readability.
	/** @type {Map<string, Finding[]>} */
	const byFile = new Map();
	for (const f of findings) {
		if (!byFile.has(f.file)) byFile.set(f.file, []);
		byFile.get(f.file).push(f);
	}
	for (const [file, items] of byFile) {
		console.log(`\n${file}`);
		for (const it of items.sort((a, b) => a.line - b.line)) {
			const tag = it.severity === 'error' ? 'error' : 'warn ';
			console.log(`  ${it.line.toString().padStart(4)}  ${tag}  ${it.rule}  ${it.msg}`);
		}
	}
	const { errors, warnings } = countFindings(findings);
	console.log(
		`\nnorns lint: ${errors} error(s), ${warnings} warning(s) across ${byFile.size} file(s).`
	);
	return { errors, warnings };
}
