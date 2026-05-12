import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pugTailwindExtract } from '../src/vite.js';

let cwd;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'norns-vite-'));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function writeN(path, content) {
	const full = join(cwd, path);
	mkdirSync(join(full, '..'), { recursive: true });
	writeFileSync(full, content);
	return full;
}

describe('pugTailwindExtract', () => {
	test('walks .n files at buildStart and writes a sidecar HTML', async () => {
		writeN(
			'src/routes/+page.n',
			[
				'.min-h-screen.flex.items-center.justify-center.p-4',
				'  Card(class="w-full max-w-md")',
				'    h1.text-2xl.font-bold Hello'
			].join('\n')
		);
		writeN('src/lib/Sidebar.n', 'aside.w-64.h-screen.bg-white/70 ok');

		const plugin = pugTailwindExtract({ root: 'src' });
		await plugin.configResolved({ root: cwd });
		await plugin.buildStart();

		const out = join(cwd, 'node_modules', '.cache', 'norns', 'tailwind-pug-classes.html');
		expect(existsSync(out)).toBe(true);
		// And the legacy `src/.tailwind-pug-classes.html` location from
		// pre-0.0.15 is NOT also created.
		expect(existsSync(join(cwd, 'src', '.tailwind-pug-classes.html'))).toBe(false);

		const html = readFileSync(out, 'utf8');
		// Single <div class="..."> with sorted, deduped classes.
		const match = html.match(/<div class="([^"]+)">/);
		expect(match).not.toBeNull();
		const found = new Set(match[1].split(' '));

		// Pug chains
		expect(found.has('min-h-screen')).toBe(true);
		expect(found.has('flex')).toBe(true);
		expect(found.has('items-center')).toBe(true);
		expect(found.has('justify-center')).toBe(true);
		expect(found.has('p-4')).toBe(true);
		expect(found.has('text-2xl')).toBe(true);
		expect(found.has('w-64')).toBe(true);
		expect(found.has('h-screen')).toBe(true);
		expect(found.has('bg-white/70')).toBe(true);

		// class="…" attribute tokens
		expect(found.has('w-full')).toBe(true);
		expect(found.has('max-w-md')).toBe(true);
	});

	test('skips classes inside <script> and <style> blocks', async () => {
		writeN(
			'src/Foo.n',
			[
				'.real-class',
				'<script>',
				"  const x = '.fake-class'",
				'</script>',
				'<style>',
				'  .fake-css-rule { color: red }',
				'</style>'
			].join('\n')
		);

		const plugin = pugTailwindExtract({ root: 'src' });
		await plugin.configResolved({ root: cwd });
		await plugin.buildStart();

		const html = readFileSync(join(cwd, 'node_modules', '.cache', 'norns', 'tailwind-pug-classes.html'), 'utf8');
		expect(html).toContain('real-class');
		expect(html).not.toContain('fake-class');
		expect(html).not.toContain('fake-css-rule');
	});

	test('rescans on handleHotUpdate when a .n file changes', async () => {
		const path = writeN('src/A.n', '.before');

		const plugin = pugTailwindExtract({ root: 'src' });
		await plugin.configResolved({ root: cwd });
		await plugin.buildStart();

		let html = readFileSync(join(cwd, 'node_modules', '.cache', 'norns', 'tailwind-pug-classes.html'), 'utf8');
		expect(html).toContain('before');

		writeFileSync(path, '.after-update');
		await plugin.handleHotUpdate({ file: path });

		html = readFileSync(join(cwd, 'node_modules', '.cache', 'norns', 'tailwind-pug-classes.html'), 'utf8');
		expect(html).toContain('after-update');
		expect(html).not.toContain('before');
	});

	test('ignores non-.n files in handleHotUpdate', async () => {
		writeN('src/A.n', '.first');
		const plugin = pugTailwindExtract({ root: 'src' });
		await plugin.configResolved({ root: cwd });
		await plugin.buildStart();

		// Should NOT throw or rebuild for non-.n changes.
		await plugin.handleHotUpdate({ file: join(cwd, 'src', 'other.css') });
		const html = readFileSync(join(cwd, 'node_modules', '.cache', 'norns', 'tailwind-pug-classes.html'), 'utf8');
		expect(html).toContain('first');
	});

	test('honors custom root, ext, outFile options', async () => {
		writeN('app/x.norn', '.custom-class');
		const plugin = pugTailwindExtract({
			root: 'app',
			ext: '.norn',
			outFile: 'app/sidecar.html'
		});
		await plugin.configResolved({ root: cwd });
		await plugin.buildStart();

		const out = join(cwd, 'app', 'sidecar.html');
		expect(existsSync(out)).toBe(true);
		expect(readFileSync(out, 'utf8')).toContain('custom-class');
	});

	test('outFile can point anywhere (project-root-relative)', async () => {
		writeN('src/Page.n', '.alternate-out-location');
		const plugin = pugTailwindExtract({
			root: 'src',
			outFile: '.tmp/sidecar.html'
		});
		await plugin.configResolved({ root: cwd });
		await plugin.buildStart();

		const out = join(cwd, '.tmp', 'sidecar.html');
		expect(existsSync(out)).toBe(true);
		expect(readFileSync(out, 'utf8')).toContain('alternate-out-location');
		// Default cache location is NOT also written when outFile is overridden.
		expect(existsSync(join(cwd, 'node_modules', '.cache', 'norns', 'tailwind-pug-classes.html'))).toBe(false);
	});
});
