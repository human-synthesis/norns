import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP_DIRS = new Set([
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

function walk(dir, filter, out = []) {
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
	return out;
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
 * @param {string} file
 * @param {string} content
 * @returns {Finding[]}
 */
function lintCivetFile(file, content) {
	/** @type {Finding[]} */
	const out = [];
	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const ln = lines[i];
		const lineNo = i + 1;
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
			const reassignRe = new RegExp(`^\\s*${name}\\s*=(?!=|>)`);
			for (let j = i + 1; j < lines.length; j++) {
				if (reassignRe.test(lines[j])) {
					out.push({
						file,
						line: lineNo,
						severity: 'error',
						rule: 'civet/state-const-reassign',
						msg: `\`${name}\` uses \`:=\` ($state const) but is reassigned at line ${j + 1}. Use \`.=\` for $state values you reassign.`
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
function lintNornFile(file, content) {
	/** @type {Finding[]} */
	const out = [];

	// Identify <script> / <style> ranges so we lint only template lines.
	const blockRanges = [];
	const blockRe = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
	let m;
	while ((m = blockRe.exec(content)) !== null) {
		blockRanges.push([m.index, m.index + m[0].length]);
	}

	// Map line index → starting offset
	const lineStart = [0];
	for (let i = 0; i < content.length; i++) {
		if (content[i] === '\n') lineStart.push(i + 1);
	}
	const inBlock = (lineNo) => {
		const s = lineStart[lineNo - 1];
		return blockRanges.some(([a, b]) => s >= a && s < b);
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
	const civetFiles = walk(
		srcDir,
		(n) => n.endsWith('.c') || n.endsWith('.civet')
	);
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
 * Pretty-print findings. Returns the number of errors.
 * @param {Finding[]} findings
 * @returns {{ errors: number; warnings: number }}
 */
export function printFindings(findings) {
	let errors = 0;
	let warnings = 0;
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
		for (const it of items) {
			const tag = it.severity === 'error' ? 'error' : 'warn ';
			if (it.severity === 'error') errors++;
			else warnings++;
			console.log(`  ${it.line.toString().padStart(4)}  ${tag}  ${it.rule}  ${it.msg}`);
		}
	}
	console.log(
		`\nnorns lint: ${errors} error(s), ${warnings} warning(s) across ${byFile.size} file(s).`
	);
	return { errors, warnings };
}
