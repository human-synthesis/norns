import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nornsAutoImport } from '../src/auto-import.js';
import {
	_collectDeclared as collectDeclared,
	_collectIdentifiers as collectIdentifiers,
	_computeImports as computeImports,
	_extractExports as extractExports,
	_renderImports as renderImports
} from '../src/auto-import.js';

/**
 * Drive a preprocessor pair (markup + script) the way Svelte does:
 * markup first (for the whole file), then script (for the script body).
 *
 * @param {ReturnType<typeof nornsAutoImport>} pp
 * @param {string} fileContent
 * @param {string} scriptBody
 * @param {string} filename
 * @param {{ lang?: string }} [attrs]
 */
async function drive(pp, fileContent, _ignoredScriptBody, filename, attrs = {}) {
	let current = fileContent;

	if (pp.markup) {
		const r = await pp.markup({ content: current, filename });
		if (r?.code != null) current = r.code;
	}

	// Mirror Svelte's pipeline: run the script hook on each script block in
	// the current source (post-markup). If markup injected a new block, that
	// block is what the script hook sees.
	if (pp.script) {
		const m = current.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
		if (m) {
			const r = await pp.script({
				content: m[1],
				attributes: attrs,
				markup: current,
				filename
			});
			if (r?.code != null) current = current.replace(m[0], `<script>${r.code}</script>`);
		}
	}

	return current === fileContent ? null : current;
}

describe('collectIdentifiers', () => {
	test('captures every identifier in the source', () => {
		const set = new Set();
		collectIdentifiers('onMount(() => tick())', set);
		expect(set.has('onMount')).toBe(true);
		expect(set.has('tick')).toBe(true);
	});

	test('captures capitalised component names', () => {
		const set = new Set();
		collectIdentifiers('<Card title="x"><Button /></Card>', set);
		expect(set.has('Card')).toBe(true);
		expect(set.has('Button')).toBe(true);
	});
});

describe('collectDeclared', () => {
	test('picks up named imports including aliases', () => {
		const decl = collectDeclared(`import { foo, bar as baz } from 'pkg';`);
		expect(decl.has('foo')).toBe(true);
		expect(decl.has('baz')).toBe(true);
		expect(decl.has('bar')).toBe(false);
	});

	test('picks up default and namespace imports', () => {
		const decl = collectDeclared(`import D from 'a';\nimport * as N from 'b';`);
		expect(decl.has('D')).toBe(true);
		expect(decl.has('N')).toBe(true);
	});

	test('picks up top-level const/let/var/function/class', () => {
		const decl = collectDeclared(
			`const a = 1; let b = 2; var c = 3; function d() {} class E {}`
		);
		for (const name of ['a', 'b', 'c', 'd', 'E']) expect(decl.has(name)).toBe(true);
	});
});

describe('renderImports', () => {
	test('groups by source module', () => {
		const out = renderImports([
			{ name: 'onMount', from: 'svelte', kind: 'named' },
			{ name: 'tick', from: 'svelte', kind: 'named' },
			{ name: 'writable', from: 'svelte/store', kind: 'named' }
		]);
		expect(out).toContain(`import { onMount, tick } from 'svelte';`);
		expect(out).toContain(`import { writable } from 'svelte/store';`);
	});

	test('combines default + named from the same source', () => {
		const out = renderImports([
			{ name: 'Card', from: '$lib/components/Card.svelte', kind: 'default' }
		]);
		expect(out).toBe(`import Card from '$lib/components/Card.svelte';`);
	});
});

describe('computeImports', () => {
	test('only adds names that are referenced and not declared', () => {
		const helpers = [{ from: 'svelte', imports: ['onMount', 'tick'] }];
		// Map now holds absolute file paths; resolution happens inside computeImports
		const components = new Map([['Card', '/proj/src/lib/components/Card.svelte']]);

		const result = computeImports(
			new Set(['onMount', 'Card']),
			new Set(['onMount']),
			helpers,
			components,
			'/proj/src/routes/page.svelte',
			{ root: '/proj', libRoot: 'src/lib', libAlias: '$lib' }
		);

		expect(result).toEqual([{ name: 'Card', from: '$lib/components/Card.svelte', kind: 'default' }]);
	});

	test('emits importer-relative paths for components outside libRoot', () => {
		const components = new Map([['Game', '/proj/src/routes/tic/Game.n']]);

		const result = computeImports(
			new Set(['Game']),
			new Set(),
			[],
			components,
			'/proj/src/routes/tic/+page.n',
			{ root: '/proj', libRoot: 'src/lib', libAlias: '$lib' }
		);

		expect(result).toEqual([{ name: 'Game', from: './Game.n', kind: 'default' }]);
	});

	test('componentSpecs map: bare-specifier paths used verbatim', () => {
		const result = computeImports(
			new Set(['Btn', 'Card']),
			new Set(),
			[],
			new Map(),
			'/proj/src/routes/+page.n',
			{ root: '/proj' },
			{
				Btn: '@human-synthesis/norns-ui/components/Btn.n',
				Card: '@human-synthesis/norns-ui/components/Card.n',
				Unused: '@human-synthesis/norns-ui/components/Unused.n'
			}
		);

		expect(result).toEqual([
			{ name: 'Btn', from: '@human-synthesis/norns-ui/components/Btn.n', kind: 'default' },
			{ name: 'Card', from: '@human-synthesis/norns-ui/components/Card.n', kind: 'default' }
		]);
	});

	test('componentDirs override componentSpecs (first match wins)', () => {
		// User has lib/components/Btn.n that should shadow the library's Btn
		const components = new Map([['Btn', '/proj/src/lib/components/Btn.n']]);

		const result = computeImports(
			new Set(['Btn', 'Card']),
			new Set(),
			[],
			components,
			'/proj/src/routes/+page.n',
			{ root: '/proj', libRoot: 'src/lib', libAlias: '$lib' },
			{
				Btn: '@human-synthesis/norns-ui/components/Btn.n',
				Card: '@human-synthesis/norns-ui/components/Card.n'
			}
		);

		// Btn comes from user dir; Card falls through to the spec map
		expect(result).toContainEqual({ name: 'Btn', from: '$lib/components/Btn.n', kind: 'default' });
		expect(result).toContainEqual({
			name: 'Card',
			from: '@human-synthesis/norns-ui/components/Card.n',
			kind: 'default'
		});
		expect(result.length).toBe(2);
	});

	test('componentSpecs entries that are declared do not import', () => {
		const result = computeImports(
			new Set(['Btn']),
			new Set(['Btn']), // user already imported Btn from somewhere
			[],
			new Map(),
			'/proj/src/routes/+page.n',
			{ root: '/proj' },
			{ Btn: '@human-synthesis/norns-ui/components/Btn.n' }
		);

		expect(result).toEqual([]);
	});
});

describe('extractExports', () => {
	test('captures const/let/var, function, class declarations', () => {
		const e = extractExports(
			`export const a = 1\nexport let b = 2\nexport function c() {}\nexport class D {}`
		);
		expect(e.has('a')).toBe(true);
		expect(e.has('b')).toBe(true);
		expect(e.has('c')).toBe(true);
		expect(e.has('D')).toBe(true);
	});

	test("captures Civet's `:=` and `.=` operators", () => {
		const e = extractExports(`export count := 5\nexport mode .= 'idle'\nexport fn := =>`);
		expect(e.has('count')).toBe(true);
		expect(e.has('mode')).toBe(true);
		expect(e.has('fn')).toBe(true);
	});

	test('captures `export { a, b as c }` blocks', () => {
		const e = extractExports(`export { mode, board, turn as currentTurn, play }`);
		expect(e.has('mode')).toBe(true);
		expect(e.has('board')).toBe(true);
		expect(e.has('currentTurn')).toBe(true);
		expect(e.has('turn')).toBe(false); // aliased name shouldn't be importable
		expect(e.has('play')).toBe(true);
	});

	test('skips type-only exports (TS verbatimModuleSyntax safety)', () => {
		const e = extractExports(
			`export type Foo = string\nexport interface Bar {}\nexport type { Baz }`
		);
		expect(e.has('Foo')).toBe(false);
		expect(e.has('Bar')).toBe(false);
		expect(e.has('Baz')).toBe(false);
	});

	test('does not match `export default …`', () => {
		const e = extractExports(`export default function foo() {}`);
		expect(e.size).toBe(0);
	});
});

describe('nornsAutoImport — project-utility scanner', () => {
	test('auto-imports named exports from .c siblings via relative paths', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/routes/tic'), { recursive: true });
		writeFileSync(
			join(root, 'src/routes/tic/store.c'),
			`export { mode, board, play }\nexport count := 5`
		);

		const pp = nornsAutoImport({
			helpers: false,
			componentDirs: false,
			exportDirs: ['src/routes'],
			root
		});
		const r = await pp.transform(`mode; board; play; count;`, join(root, 'src/routes/tic/+page.server.c'));

		// The importer's path matches `+server.` — this is a `.c` so transform
		// fires; but `+page.server.c` isn't a Svelte hook, just illustrative —
		// what matters is that it imports from the discovered sibling.
		expect(r?.code).toContain(`from './store'`);
		expect(r?.code).toMatch(/import \{ [^}]*mode[^}]* \} from '\.\/store'/);
	});

	test('auto-imports lib utilities via $lib alias from .n script blocks', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib/notes/server'), { recursive: true });
		writeFileSync(
			join(root, 'src/lib/notes/server/public.c'),
			`export notes := (c) => c.resolve('notes.service')`
		);

		const pp = nornsAutoImport({
			helpers: false,
			componentDirs: false,
			exportDirs: ['src/lib'],
			root
		});
		const file = `<script>notes(container).list()\n</script>`;
		const out = await drive(
			pp,
			file,
			`notes(container).list()\n`,
			join(root, 'src/routes/feed/+page.server.c')
		);

		expect(out).toContain(`import { notes } from '$lib/notes/server/public';`);
	});

	test('skips export auto-import when name already declared', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib'), { recursive: true });
		writeFileSync(join(root, 'src/lib/things.c'), `export thing := 1`);

		const pp = nornsAutoImport({
			helpers: false,
			componentDirs: false,
			exportDirs: ['src/lib'],
			root
		});
		const r = await pp.transform(
			`import { thing } from '$lib/things'\nthing()`,
			join(root, 'src/routes/+page.server.c')
		);
		expect(r).toBe(null);
	});

	test('helper match wins over export with same name (gating order)', async () => {
		// `boot` is a Norns server helper. Even if a project file also exports
		// `boot`, the helper takes precedence in server paths.
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib'), { recursive: true });
		writeFileSync(join(root, 'src/lib/boot.c'), `export boot := => 'wrong'`);

		const pp = nornsAutoImport({
			componentDirs: false,
			exportDirs: ['src/lib'],
			root
		});
		const r = await pp.transform(`boot()`, join(root, 'src/hooks.server.c'));
		expect(r?.code).toContain(`from '@human-synthesis/norns/server'`);
		expect(r?.code).not.toContain(`from '$lib/boot'`);
	});

	test('SvelteKit route/hook files are excluded from the export map', async () => {
		// `load` / `actions` / `handle` are framework-consumed names — they must
		// not enter the auto-import map or a user variable called `load` would
		// pull a junk import from a random `+page.server.c`.
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/routes/feed'), { recursive: true });
		mkdirSync(join(root, 'src/lib'), { recursive: true });
		writeFileSync(
			join(root, 'src/routes/feed/+page.server.c'),
			`export load := => ({})\nexport actions := { create: {} }`
		);
		writeFileSync(join(root, 'src/hooks.server.c'), `export handle := => {}`);
		// User-defined utility — should still be discovered
		writeFileSync(join(root, 'src/lib/things.c'), `export thing := 1`);

		const pp = nornsAutoImport({
			helpers: false,
			componentDirs: false,
			exportDirs: ['src/lib', 'src/routes', 'src'],
			root
		});

		const r1 = await pp.transform(`load(); actions; handle();`, join(root, 'src/something.c'));
		expect(r1).toBe(null); // none of those should auto-import

		const r2 = await pp.transform(`thing();`, join(root, 'src/something.c'));
		expect(r2?.code).toContain(`from '$lib/things'`);
	});

	test('exportDirs disabled by default', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib'), { recursive: true });
		writeFileSync(join(root, 'src/lib/things.c'), `export thing := 1`);

		const pp = nornsAutoImport({ helpers: false, componentDirs: false, root });
		const r = await pp.transform(`thing()`, join(root, 'src/routes/+page.server.c'));
		expect(r).toBe(null);
	});
});

describe('nornsAutoImport — exportGlobs path scoping & conflicts', () => {
	test('server-only export is invisible to client importers', async () => {
		// `db` exported from a /server/ path file must NOT auto-import into a
		// client `.n` component — that's the bundle-pollution bug class.
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib/notes/server'), { recursive: true });
		writeFileSync(
			join(root, 'src/lib/notes/server/public.c'),
			`export db := () => 'never-in-client-bundle'`
		);

		const pp = nornsAutoImport({
			helpers: false,
			componentDirs: false,
			exportGlobs: ['src/lib/**/public.c'],
			root,
			log: () => {}
		});
		// Client importer = a .n component
		const r = await pp.transform(
			`const x = db()`,
			join(root, 'src/lib/components/Thing.c')
		);
		expect(r).toBe(null);
	});

	test('server importer CAN consume server-scoped export', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib/notes/server'), { recursive: true });
		writeFileSync(
			join(root, 'src/lib/notes/server/public.c'),
			`export notes := () => 'service'`
		);

		const pp = nornsAutoImport({
			helpers: false,
			componentDirs: false,
			exportGlobs: ['src/lib/**/public.c'],
			root,
			log: () => {}
		});
		const r = await pp.transform(
			`notes().list()`,
			join(root, 'src/routes/feed/+page.server.c')
		);
		expect(r?.code).toContain(`from '$lib/notes/server/public'`);
		// auto-import annotation present
		expect(r?.code).toMatch(/import \{ notes \} from '\$lib\/notes\/server\/public';\s*\/\/ auto-import/);
	});

	test('mixed-scope same name: server importer gets server, client importer gets client', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib/notes/server'), { recursive: true });
		mkdirSync(join(root, 'src/lib/notes/shared'), { recursive: true });
		// Server-scoped `notes` (e.g. service factory)
		writeFileSync(
			join(root, 'src/lib/notes/server/public.c'),
			`export notes := () => 'server'`
		);
		// Client-safe `notes` (e.g. a store re-export)
		writeFileSync(
			join(root, 'src/lib/notes/shared/public.c'),
			`export notes := () => 'client'`
		);

		const pp = nornsAutoImport({
			helpers: false,
			componentDirs: false,
			exportGlobs: ['src/lib/**/public.c'],
			root,
			log: () => {}
		});

		const rServer = await pp.transform(
			`notes()`,
			join(root, 'src/hooks.server.c')
		);
		expect(rServer?.code).toContain(`from '$lib/notes/server/public'`);

		const rClient = await pp.transform(
			`notes()`,
			join(root, 'src/lib/somewhere/util.c')
		);
		expect(rClient?.code).toContain(`from '$lib/notes/shared/public'`);
		expect(rClient?.code).not.toContain(`from '$lib/notes/server/public'`);
	});

	test('same-scope conflict is logged and excluded from auto-import', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib/a'), { recursive: true });
		mkdirSync(join(root, 'src/lib/b'), { recursive: true });
		writeFileSync(join(root, 'src/lib/a/public.c'), `export getById := () => 'a'`);
		writeFileSync(join(root, 'src/lib/b/public.c'), `export getById := () => 'b'`);

		/** @type {string[]} */
		const logs = [];
		const pp = nornsAutoImport({
			helpers: false,
			componentDirs: false,
			exportGlobs: ['src/lib/**/public.c'],
			root,
			log: (m) => logs.push(m)
		});

		// Conflict warning fires at init.
		expect(logs.some((l) => l.includes('conflict') && l.includes('getById'))).toBe(true);

		// And `getById` is now invisible to auto-import — user must import explicitly.
		const r = await pp.transform(`getById()`, join(root, 'src/lib/c/use.c'));
		expect(r).toBe(null);
	});

	test('exportGlobs respects glob scope (only public.c, not repo.c)', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib/notes/server'), { recursive: true });
		writeFileSync(
			join(root, 'src/lib/notes/server/public.c'),
			`export notes := () => 'public'`
		);
		writeFileSync(
			join(root, 'src/lib/notes/server/repo.c'),
			`export internalThing := () => 'internal'`
		);

		const pp = nornsAutoImport({
			helpers: false,
			componentDirs: false,
			exportGlobs: ['src/lib/**/public.c'],
			root,
			log: () => {}
		});

		// `notes` is visible (matches glob)
		const r1 = await pp.transform(`notes()`, join(root, 'src/routes/+page.server.c'));
		expect(r1?.code).toContain(`from '$lib/notes/server/public'`);

		// `internalThing` is invisible (repo.c doesn't match the glob)
		const r2 = await pp.transform(`internalThing()`, join(root, 'src/routes/+page.server.c'));
		expect(r2).toBe(null);
	});

	test('exportDirs is shimmed to exportGlobs and emits deprecation warning', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib'), { recursive: true });
		writeFileSync(join(root, 'src/lib/things.c'), `export thing := 1`);

		/** @type {string[]} */
		const logs = [];
		const pp = nornsAutoImport({
			helpers: false,
			componentDirs: false,
			exportDirs: ['src/lib'],
			root,
			log: (m) => logs.push(m)
		});

		expect(logs.some((l) => l.includes('exportDirs') && l.includes('deprecated'))).toBe(true);

		// Still works after the warning — backward compat is preserved.
		const r = await pp.transform(`thing()`, join(root, 'src/routes/+page.server.c'));
		expect(r?.code).toContain(`from '$lib/things'`);
	});
});

describe('nornsAutoImport — preprocessor', () => {
	test('injects helper imports for referenced lifecycle calls', async () => {
		const pp = nornsAutoImport({ componentDirs: false, root: tmpdir() });
		const file = `<script>onMount(() => {});\n</script>\n<div>x</div>`;
		const out = await drive(pp, file, `onMount(() => {});\n`, '/tmp/Foo.svelte');
		expect(out).toContain(`import { onMount } from 'svelte';`);
		expect(out).toContain(`onMount(() => {});`);
		expect(out).toContain(`<div>x</div>`); // markup preserved
	});

	test('does not duplicate already-imported helpers', async () => {
		const pp = nornsAutoImport({ componentDirs: false, root: tmpdir() });
		const script = `import { onMount } from 'svelte';\nonMount(() => {});\n`;
		const file = `<script>${script}</script>`;
		const out = await drive(pp, file, script, '/tmp/Foo.svelte');
		expect(out).toBe(null);
	});

	test('skips non-JS scripts (e.g. lang="civet" before compilation)', async () => {
		const pp = nornsAutoImport({ componentDirs: false, root: tmpdir() });
		const out = await drive(
			pp,
			`<script lang="civet">onMount =>\n</script>`,
			`onMount =>\n`,
			'/tmp/F.svelte',
			{ lang: 'civet' }
		);
		expect(out).toBe(null);
	});

	test('resolves capitalised components from componentDirs', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib/components'), { recursive: true });
		writeFileSync(join(root, 'src/lib/components/Card.svelte'), '<div></div>');
		writeFileSync(join(root, 'src/lib/components/Button.n'), 'button');

		const pp = nornsAutoImport({ helpers: false, root });
		const file = `<script></script>\n<Card><Button /></Card>`;
		const out = await drive(pp, file, ``, '/tmp/Page.svelte');

		expect(out).toContain(`import Card from '$lib/components/Card.svelte';`);
		expect(out).toContain(`import Button from '$lib/components/Button.n';`);
	});

	test('lowercase tag names never resolve to components', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib/components'), { recursive: true });
		writeFileSync(join(root, 'src/lib/components/Card.svelte'), '<div></div>');

		const pp = nornsAutoImport({ helpers: false, root });
		const file = `<script></script>\n<div>card</div>`;
		const out = await drive(pp, file, ``, '/tmp/X.svelte');

		expect(out).toBe(null);
	});

	test('helpers: false disables helper auto-imports entirely', async () => {
		const pp = nornsAutoImport({ helpers: false, componentDirs: false, root: tmpdir() });
		const out = await drive(
			pp,
			`<script>onMount(() => {});\n</script>`,
			`onMount(() => {});\n`,
			'/tmp/F.svelte'
		);
		expect(out).toBe(null);
	});

	test('respects custom libAlias / libRoot', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'app/components'), { recursive: true });
		writeFileSync(join(root, 'app/components/Hero.svelte'), '<h1></h1>');

		const pp = nornsAutoImport({
			helpers: false,
			componentDirs: ['app/components'],
			libRoot: 'app',
			libAlias: '$app',
			root
		});
		const file = `<script></script>\n<Hero />`;
		const out = await drive(pp, file, ``, '/tmp/Y.svelte');

		expect(out).toContain(`import Hero from '$app/components/Hero.svelte';`);
	});

	test('prepends a new <script> block when none exists and components are referenced', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib/components'), { recursive: true });
		writeFileSync(join(root, 'src/lib/components/Header.n'), 'header');

		const pp = nornsAutoImport({ helpers: false, root });
		const file = `.flex\n\tHeader\n\tdiv content\n`;
		const out = await drive(pp, file, ``, '/tmp/Layout.n');

		expect(out).not.toBeNull();
		expect(out).toContain(`<script>`);
		expect(out).toContain(`import Header from '$lib/components/Header.n';`);
		expect(out).toContain(`</script>`);
		expect(out).toContain(`Header`); // original markup preserved
	});

	test('passes through unchanged when no script block and no known refs', async () => {
		const pp = nornsAutoImport({ componentDirs: false, root: tmpdir() });
		const file = `.flex\n\tdiv content\n`;
		const out = await drive(pp, file, ``, '/tmp/Plain.n');
		expect(out).toBe(null);
	});

	test('resolves route-colocated components via importer-relative paths', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/routes/tic'), { recursive: true });
		writeFileSync(join(root, 'src/routes/tic/Game.n'), 'game');
		writeFileSync(join(root, 'src/routes/tic/Board.n'), 'board');

		const pp = nornsAutoImport({
			helpers: false,
			componentDirs: ['src/routes'],
			root
		});
		const file = `<script></script>\n<Game><Board /></Game>`;
		const importer = join(root, 'src/routes/tic/+page.n');
		const out = await drive(pp, file, ``, importer);

		expect(out).toContain(`import Game from './Game.n';`);
		expect(out).toContain(`import Board from './Board.n';`);
	});

	test('vite transform: injects server helpers into +page.server.c', async () => {
		const pp = nornsAutoImport({ componentDirs: false, root: tmpdir() });
		const compiledJs = `export const load = page.load({ handler: () => ({}) });\n`;
		const r = await pp.transform(compiledJs, '/proj/src/routes/notes/+page.server.c');
		expect(r?.code).toContain(`import { page } from '@human-synthesis/norns/server';`);
		expect(r?.code).toContain(compiledJs);
	});

	test('vite transform: injects helpers based on /server/ path segment', async () => {
		const pp = nornsAutoImport({ componentDirs: false, root: tmpdir() });
		const compiledJs = `boot({ features: {} });\n`;
		const r = await pp.transform(compiledJs, '/proj/src/lib/notes/server/module.c');
		expect(r?.code).toContain(`import { boot } from '@human-synthesis/norns/server';`);
	});

	test('vite transform: server-gated helpers do NOT fire in client .civet utilities', async () => {
		const pp = nornsAutoImport({ componentDirs: false, root: tmpdir() });
		// `boot` is exclusively in the Norns server helper module, gated to
		// server paths. In a client utility path, the gate fails so nothing
		// injects — the param-shadowing here is irrelevant to the test.
		const compiledJs = `export const helper = (boot) => boot();\n`;
		const r = await pp.transform(compiledJs, '/proj/src/lib/utils.civet');
		expect(r).toBe(null);
	});

	test('vite transform: skips node_modules', async () => {
		const pp = nornsAutoImport({ componentDirs: false, root: tmpdir() });
		const r = await pp.transform(
			`page.load(...)`,
			'/proj/node_modules/something/file.c'
		);
		expect(r).toBe(null);
	});

	test('vite transform: skips non-civet/.c extensions', async () => {
		const pp = nornsAutoImport({ componentDirs: false, root: tmpdir() });
		const r = await pp.transform(`onMount(() => {})`, '/proj/src/foo.js');
		expect(r).toBe(null);
	});

	test('vite transform: respects existing imports', async () => {
		const pp = nornsAutoImport({ componentDirs: false, root: tmpdir() });
		const compiledJs = `import { page } from '@human-synthesis/norns/server';\nexport const load = page.load(...);\n`;
		const r = await pp.transform(compiledJs, '/proj/src/routes/+page.server.c');
		expect(r).toBe(null);
	});

	test('$app/state.page auto-imports in client .n files', async () => {
		const pp = nornsAutoImport({ componentDirs: false, root: tmpdir() });
		const file = `<script></script>\np {page.url.pathname}\n`;
		const out = await drive(pp, file, ``, '/proj/src/lib/components/Header.n');
		expect(out).toContain(`import { page } from '$app/state';`);
	});

	test('$app/state.page does NOT auto-import in server .c files (Norns server.page wins)', async () => {
		const pp = nornsAutoImport({ componentDirs: false, root: tmpdir() });
		const compiledJs = `export const load = page.load({});\n`;
		const r = await pp.transform(compiledJs, '/proj/src/routes/+page.server.c');
		expect(r?.code).toContain(`import { page } from '@human-synthesis/norns/server';`);
		expect(r?.code).not.toContain(`from '$app/state'`);
	});

	test('@sveltejs/kit helpers auto-import in server .c files', async () => {
		const pp = nornsAutoImport({ componentDirs: false, root: tmpdir() });
		const compiledJs = `throw redirect(303, '/');\n`;
		const r = await pp.transform(compiledJs, '/proj/src/routes/+page.server.c');
		expect(r?.code).toContain(`import { redirect } from '@sveltejs/kit';`);
	});

	test('preprocessor: server helpers do NOT fire in .n components', async () => {
		// `boot` (only in @human-synthesis/norns/server, server-gated) referenced
		// in an .n file shouldn't auto-import — match regex filters it out.
		const pp = nornsAutoImport({ componentDirs: false, root: tmpdir() });
		const file = `<script>boot({});\n</script>`;
		const out = await drive(pp, file, `boot({});\n`, '/proj/src/routes/+page.n');
		expect(out).toBe(null);
	});

	test('files referenced only in script (not markup) still trigger imports', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib/components'), { recursive: true });
		writeFileSync(join(root, 'src/lib/components/Modal.svelte'), '<div></div>');

		const pp = nornsAutoImport({ helpers: false, root });
		const script = `mount(Modal, document.body);\n`;
		const file = `<script>${script}</script>`;
		const out = await drive(pp, file, script, '/tmp/Z.svelte');

		expect(out).toContain(`import Modal from '$lib/components/Modal.svelte';`);
	});

	test('components option: bare-specifier auto-imports for UI library presets', async () => {
		const pp = nornsAutoImport({
			helpers: false,
			componentDirs: false,
			components: {
				Btn: '@human-synthesis/norns-ui/components/Btn.n',
				Field: '@human-synthesis/norns-ui/components/Field.n'
			},
			root: tmpdir()
		});
		const file = `<script></script>\nForm\n\tField(label="Email")\n\tBtn(type="submit") Save`;
		const out = await drive(pp, file, ``, '/proj/src/routes/+page.n');

		expect(out).toContain(`import Btn from '@human-synthesis/norns-ui/components/Btn.n';`);
		expect(out).toContain(`import Field from '@human-synthesis/norns-ui/components/Field.n';`);
		// Form is referenced but not in the map → no import emitted
		expect(out).not.toContain(`import Form `);
	});

	test('user lib/components silently overrides components map', async () => {
		const root = mkdtempSync(join(tmpdir(), 'norns-ai-'));
		mkdirSync(join(root, 'src/lib/components'), { recursive: true });
		// User has their own Btn — should win over the library's
		writeFileSync(join(root, 'src/lib/components/Btn.n'), 'button');

		const pp = nornsAutoImport({
			helpers: false,
			components: {
				Btn: '@human-synthesis/norns-ui/components/Btn.n',
				Card: '@human-synthesis/norns-ui/components/Card.n'
			},
			root
		});
		const file = `<script></script>\nBtn Hello\nCard test`;
		const out = await drive(pp, file, ``, '/proj/src/routes/page.n');

		// User's Btn wins
		expect(out).toContain(`import Btn from '$lib/components/Btn.n';`);
		// Card has no user override → falls through to the library
		expect(out).toContain(`import Card from '@human-synthesis/norns-ui/components/Card.n';`);
	});

	test('components map: existing imports are not duplicated', async () => {
		const pp = nornsAutoImport({
			helpers: false,
			componentDirs: false,
			components: { Btn: '@human-synthesis/norns-ui/components/Btn.n' },
			root: tmpdir()
		});
		const file = `<script>import Btn from 'somewhere-else';\n</script>\nBtn Hello`;
		const out = await drive(pp, file, `import Btn from 'somewhere-else';\n`, '/proj/src/routes/page.n');

		// User's existing import is preserved; no duplicate added
		expect(out).toBe(null);
	});
});
