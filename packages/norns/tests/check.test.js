import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nornsPreprocess } from '@human-synthesis/norns-core/preprocess';
import { nornsCheck } from '../src/check.js';

let cwd;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'norns-check-'));
	mkdirSync(join(cwd, 'src', 'lib'), { recursive: true });
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function write(rel, content) {
	writeFileSync(join(cwd, rel), content);
}

const run = () => nornsCheck({ cwd, preprocess: nornsPreprocess(), extensions: ['.svelte', '.n'] });

describe('nornsCheck', () => {
	test('a clean project has no errors and counts files', async () => {
		write('src/lib/Ok.n', "section\n\tp {label}\n\t+if('on')\n\t\tspan yes\n\t+else\n\t\tspan no\n\n<script>\n\t{ label = 'x', on = false } := $props()\n</script>\n");
		write('src/lib/ok.c', 'export add := (a: number, b: number) => a + b\n');
		const result = await run();
		expect(result.errors).toEqual([]);
		expect(result.files).toBe(2);
	});

	test('a Pug error is reported on the source line of the .n file', async () => {
		write('src/lib/Bad.n', 'section\n\tp hi\n  span oops\n\n<script>\n\tx := 1\n</script>\n');
		const result = await run();
		expect(result.errors).toHaveLength(1);
		const [e] = result.errors;
		expect(e.file).toBe('src/lib/Bad.n');
		expect(e.stage).toBe('pug');
		expect(e.line).toBe(3);
		expect(e.mapped).toBe(true);
		expect(e.message).toMatch(/^Pug: /);
		expect(e.frame).toContain('span oops');
	});

	test('a Civet error in a .n script block is reported on the file line', async () => {
		write('src/lib/BadScript.n', 'p hi\n\n<script>\n\tok := 1\n\tbroken := (\n\tmore := 2\n</script>\n');
		const result = await run();
		expect(result.errors).toHaveLength(1);
		const [e] = result.errors;
		expect(e.file).toBe('src/lib/BadScript.n');
		expect(e.stage).toBe('civet');
		expect(e.line).toBeGreaterThanOrEqual(5);
		expect(e.line).toBeLessThanOrEqual(7);
		expect(e.message).toMatch(/^Civet: /);
	});

	test('a Civet error in a .c module is reported with its line', async () => {
		write('src/lib/bad.c', 'a := 1\nb := (\nc := 3\n');
		const result = await run();
		expect(result.errors).toHaveLength(1);
		const [e] = result.errors;
		expect(e.file).toBe('src/lib/bad.c');
		expect(e.stage).toBe('civet');
		expect(e.line).toBeGreaterThanOrEqual(2);
		expect(e.mapped).toBe(true);
	});

	test('a Svelte compile error is reported (unmapped positions say so)', async () => {
		// `{#each x of y}` is copied verbatim by the +each mixin and rejected by Svelte.
		write('src/lib/Each.n', "ul\n\t+each('row of rows')\n\t\tli {row}\n\n<script>\n\t{ rows = [] } := $props()\n</script>\n");
		const result = await run();
		expect(result.errors).toHaveLength(1);
		const [e] = result.errors;
		expect(e.file).toBe('src/lib/Each.n');
		expect(e.stage).toBe('svelte');
		expect(e.message).toMatch(/^Svelte: /);
		if (!e.mapped) expect(e.message).toContain('norns diag --template');
	});

	test('warnings are collected only when asked', async () => {
		write('src/lib/Warn.n', 'img(src="/x.png")\n');
		const quiet = await run();
		expect(quiet.warnings).toEqual([]);
		const loud = await nornsCheck({ cwd, preprocess: nornsPreprocess(), extensions: ['.n'], warnings: true });
		expect(loud.errors).toEqual([]);
		expect(loud.warnings.length).toBeGreaterThan(0);
		expect(loud.warnings[0].file).toBe('src/lib/Warn.n');
	});
});
