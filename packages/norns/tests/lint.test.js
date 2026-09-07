import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintSource, nornsLint } from '../src/lint.js';

const rules = (findings) => findings.map((f) => `${f.rule}@${f.line}`);

describe('lintSource — .c files', () => {
	test('flags `isnt`', () => {
		const out = lintSource('a.c', "x := 1\nif x isnt 2\n\tconsole.log 'no'\n");
		expect(rules(out)).toEqual(['civet/no-isnt@2']);
	});

	test('ignores `isnt` inside strings', () => {
		const out = lintSource('a.c', "msg := 'this isnt flagged'\n");
		expect(out).toEqual([]);
	});

	test('flags `:= $state` that is later reassigned', () => {
		const out = lintSource('a.c', "count := $state 0\nbump := =>\n\tcount = count + 1\n");
		expect(rules(out)).toEqual(['civet/state-const-reassign@1']);
		expect(out[0].msg).toContain('line 3');
	});

	test('flags compound reassignment too', () => {
		const out = lintSource('a.c', 'count := $state 0\ncount += 1\n');
		expect(rules(out)).toEqual(['civet/state-const-reassign@1']);
	});

	test('`.= $state` reassigned is fine', () => {
		const out = lintSource('a.c', 'count .= $state 0\ncount = 1\n');
		expect(out).toEqual([]);
	});
});

describe('lintSource — .n files', () => {
	test('runs the Civet rules inside the <script> block with file line numbers', () => {
		const src = [
			'section',
			'\tp {count}',
			'',
			'<script>',
			'\tcount := $state 0',
			'\tbump := =>',
			'\t\tcount = count + 1',
			'</script>',
			''
		].join('\n');
		const out = lintSource('Counter.n', src);
		expect(rules(out)).toEqual(['civet/state-const-reassign@5']);
		expect(out[0].msg).toContain('line 7');
	});

	test('flags `isnt` in a script block', () => {
		const src = 'p hi\n\n<script>\n\tok := a isnt b\n</script>\n';
		const out = lintSource('X.n', src);
		expect(rules(out)).toEqual(['civet/no-isnt@4']);
	});

	test('does not apply Civet rules to a lang="ts" script', () => {
		const src = 'p hi\n\n<script lang="ts">\n\tconst ok = a isnt b\n</script>\n';
		expect(lintSource('X.n', src)).toEqual([]);
	});

	test('template rules skip script blocks and flag leading `{`', () => {
		const src = 'section\n\t{@html foo}\n\n<script>\n\tfoo := "<b>x</b>"\n</script>\n';
		const out = lintSource('X.n', src);
		expect(rules(out)).toEqual(['pug/svelte-block-needs-pipe@2']);
	});

	test('flags Pug interpolation', () => {
		const out = lintSource('X.n', 'p #{name}\n');
		expect(rules(out)).toEqual(['pug/no-pug-interpolation@1']);
	});

	test('flags `+each` written with `of`', () => {
		const out = lintSource('X.n', "ul\n\t+each('row of rows')\n\t\tli {row}\n");
		expect(rules(out)).toEqual(['pug/each-as-form@2']);
	});

	test('accepts `+each` with `as` and a key', () => {
		const out = lintSource('X.n', "ul\n\t+each('rows as row (row.id)')\n\t\tli {row}\n");
		expect(out).toEqual([]);
	});
});

describe('nornsLint over a project', () => {
	let cwd;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), 'norns-lint-'));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	test('walks src/, reports relative paths, warns on vite.config without allowedHosts', () => {
		mkdirSync(join(cwd, 'src', 'lib'), { recursive: true });
		writeFileSync(join(cwd, 'src', 'lib', 'a.c'), 'x := a isnt b\n');
		writeFileSync(join(cwd, 'src', 'lib', 'B.n'), 'p hi\n\n<script>\n\tn := $state 0\n\tn = 1\n</script>\n');
		writeFileSync(join(cwd, 'vite.config.js'), 'export default {}\n');
		const out = nornsLint(cwd);
		const byFile = Object.fromEntries(out.map((f) => [f.file, f.rule]));
		expect(byFile['src/lib/a.c']).toBe('civet/no-isnt');
		expect(byFile['src/lib/B.n']).toBe('civet/state-const-reassign');
		expect(byFile['vite.config.js']).toBe('vite/allowed-hosts');
	});
});
