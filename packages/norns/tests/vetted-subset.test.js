import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSpec } from '@human-synthesis/norns-tron/spec';

import { generateApp } from '../src/kernel/index.js';
import { nornsLint } from '../src/lint.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

function splitNorn(text) {
	const scripts = [];
	const template = text.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_, body) => {
		scripts.push(body);
		return '';
	});
	return { template, script: scripts.join('\n') };
}

// Trap patterns from docs/vetted-subset.md. `where` selects which text each
// pattern scans: civet code (.c files + .n script blocks) or .n template lines.
const TRAPS = [
	{ name: 'civet `isnt`', where: 'civet', re: /\bisnt\b/ },
	{ name: 'civet keywords in brace imports', where: 'civet', re: /import\s*\{[^}]*\b(?:and|or|not)\b[^}]*\}/ },
	{ name: 'unquoted and/or/not object keys', where: 'civet', re: /[{,]\s*(?:and|or|not)\s*:/ },
	{ name: 'async generator method shorthand', where: 'civet', re: /^\s+async\s*\*\s*\w+\s*\(/m },
	{ name: '$bindable props', where: 'civet', re: /\$bindable\b/ },
	{ name: '`.= $props()` (only needed for bindables)', where: 'civet', re: /\.=\s*\$props\(/ },
	{ name: 'markup snippet (TDZ trap)', where: 'template', re: /\+snippet\(|\{#snippet\b/ },
	{ name: 'pug interpolation #{…}', where: 'template', re: /(^|[^\\])#\{/ },
	{ name: 'leading svelte block without pipe', where: 'template', re: /^\s*\{[@#:/]/m },
	{ name: 'class shorthand with `:` or `/`', where: 'template', re: /^\s*[\w#.-]*\.[\w-]*[:/][\w-]/m },
	{ name: 'class shorthand with fraction', where: 'template', re: /^\s*[\w#.-]*\.[\w-]+\.\d/m },
	{ name: '+each without ` as `', where: 'template', re: /\+each\((['"])(?:(?!\1).)*\1/, ok: (m) => / as /.test(m[0]) }
];

function scan(files) {
	const hits = [];
	for (const { path, text } of files) {
		const isNorn = path.endsWith('.n');
		const civet = isNorn ? splitNorn(text).script : path.endsWith('.c') ? text : '';
		const template = isNorn ? splitNorn(text).template : '';
		for (const trap of TRAPS) {
			const target = trap.where === 'civet' ? civet : template;
			if (!target) continue;
			const re = new RegExp(trap.re.source, trap.re.flags.includes('g') ? trap.re.flags : trap.re.flags + 'g');
			let m;
			while ((m = re.exec(target)) !== null) {
				if (trap.ok?.(m)) continue;
				hits.push(`${path}: ${trap.name} → ${m[0].trim()}`);
			}
		}
	}
	return hits;
}

const GOLDEN = join(import.meta.dir, 'golden', 'generated');

describe('vetted subset — trap patterns are detectable', () => {
	const CASES = [
		['civet', 'if a isnt b { return }', 'civet `isnt`'],
		['civet', "import { eq, and } from 'drizzle-orm'", 'civet keywords in brace imports'],
		['civet', 'ops := { and: dz.and }', 'unquoted and/or/not object keys'],
		['civet', 'class X {\n\tasync *rows() { yield 1 }\n}', 'async generator method shorthand'],
		['civet', '{ value } := $props()\nvalue := $bindable()', '$bindable props'],
		['civet', '{ data } .= $props()', '`.= $props()` (only needed for bindables)'],
		['template', "+snippet('panelA')\n\tp A", 'markup snippet (TDZ trap)'],
		['template', 'p total: #{total}', 'pug interpolation #{…}'],
		['template', '{#each items as item}', 'leading svelte block without pipe'],
		['template', '.hover:bg-blue-500', 'class shorthand with `:` or `/`'],
		['template', 'div.gap-2.5', 'class shorthand with fraction'],
		["template", "+each('item of items')\n\tp x", '+each without ` as `']
	];
	for (const [kind, snippet, trapName] of CASES) {
		test(trapName, () => {
			const path = kind === 'civet' ? 'lib/m/actions.c' : 'routes/m/+page.n';
			const text = kind === 'civet' ? snippet : `${snippet}\n<script>\n\tx := 1\n</script>\n`;
			const hits = scan([{ path, text }]);
			expect(hits.some((h) => h.includes(trapName))).toBe(true);
		});
	}

	test('vetted +each with ` as ` is allowed', () => {
		const text = "+each('data.rows as row')\n\tp x\n<script>\n\tx := 1\n</script>\n";
		expect(scan([{ path: 'routes/m/+page.n', text }])).toEqual([]);
	});
});

describe('vetted subset — golden generated tree', () => {
	const files = walk(GOLDEN).map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));

	test('golden tree exists and covers .c and .n outputs', () => {
		expect(files.some((f) => f.path.endsWith('.c'))).toBe(true);
		expect(files.some((f) => f.path.endsWith('.n'))).toBe(true);
	});

	test('contains no trap patterns', () => {
		expect(scan(files)).toEqual([]);
	});

	test('nornsLint reports no findings', () => {
		expect(nornsLint(GOLDEN)).toEqual([]);
	});
});

describe('vetted subset — fresh generator output', () => {
	const root = mkdtempSync(join(tmpdir(), 'norns-vetted-'));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	test('generateApp output contains no trap patterns', () => {
		const dir = join(root, 'specs');
		writeSpec(join(dir, 'app.tron'), APP);
		writeSpec(join(dir, 'orders.tron'), ORDERS);
		writeSpec(join(dir, 'catalog.tron'), CATALOG);
		generateApp(dir);
		const out = join(root, '.norns', 'generated');
		const files = walk(out)
			.filter((p) => p.endsWith('.c') || p.endsWith('.n'))
			.map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
		expect(files.length).toBeGreaterThan(0);
		expect(scan(files)).toEqual([]);
	});
});
