# Norns

**AI-driven software architecture and development framework, based on Svelte.**

SvelteKit with **Pug + Civet** and the `.n` / `.c` file extensions — preconfigured. The `.c` extension is recognised as an alias for `.civet`; both compile through Civet.

Includes a small runtime layer: feature-folder modularity, a DI container, route/page wrappers with valibot validation, and a migrations CLI.

## Stack

- [Svelte 5](https://svelte.dev) — components and runes
- [SvelteKit 2](https://kit.svelte.dev) — file-system routing, SSR, endpoints
- [Pug](https://pugjs.org) — templates
- [Civet](https://civet.dev) — script (TypeScript-flavored, indented)
- [Tailwind CSS v4](https://tailwindcss.com) — recommended styling (consumer-installed)
- [Vite](https://vitejs.dev) — bundler
- [bun](https://bun.sh) — runtime / package manager

## Install

```sh
bun add -D @human-synthesis/norns @sveltejs/kit svelte
```

Or use the [`norns-app`](https://github.com/human-synthesis/norns-app) starter, which has everything wired up.

## Setup

`svelte.config.js`:

```js
import { nornsConfig } from '@human-synthesis/norns/config';

export default nornsConfig({
  // your overrides here
});
```

`vite.config.js`:

```js
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { nornsCivetPlugin } from '@human-synthesis/norns/vite';

export default defineConfig({
  plugins: [nornsCivetPlugin(), sveltekit()]
});
```

`package.json`:

```json
{
  "scripts": {
    "dev": "norns dev",
    "build": "norns build",
    "preview": "norns preview",
    "migrate": "norns migrate"
  }
}
```

## Auto-imports

`nornsAutoImport()` returns an object that's both a Svelte preprocessor (for `.n` / `.svelte` files) and a Vite plugin (for standalone `.c` / `.civet` modules). The same instance has all four resolvers: framework helpers, project components, project utilities, and library presets. Wire it in both places — Svelte's compiler ignores the Vite hooks, Vite ignores the Svelte hooks:

```js
// svelte.config.js
import { nornsConfig } from '@human-synthesis/norns/config';
import { nornsPreprocess } from '@human-synthesis/norns/preprocess';
import { nornsAutoImport } from '@human-synthesis/norns/auto-import';

export default nornsConfig({
  preprocess: [
    ...nornsPreprocess(),
    nornsAutoImport({
      componentDirs: ['src/lib/components', 'src/routes'],
      exportDirs: ['src/lib', 'src/routes']
    })
  ]
});
```

```js
// vite.config.js
import { nornsCivetPlugin } from '@human-synthesis/norns/vite';
import { nornsAutoImport } from '@human-synthesis/norns/auto-import';

export default {
  plugins: [
    nornsCivetPlugin(),
    nornsAutoImport({ exportDirs: ['src/lib', 'src/routes'] }),
    sveltekit()
  ]
};
```

### What gets auto-imported

| Layer | Resolves | Examples |
|-------|----------|----------|
| Helpers | Hardcoded module-name lists, optionally path-gated | `onMount` from `svelte`, `redirect` from `@sveltejs/kit`, `page` from `$app/state` (client) or `@human-synthesis/norns/server` (server) |
| Components (dir scan) | Capitalised basenames in `componentDirs` | `<Card>` → `$lib/components/Card.svelte`; `<Game>` → `./Game.n` (route-colocated, importer-relative) |
| Components (preset map) | Bare-specifier `Record<name, importPath>` from a UI library | `<Btn>` → `'@human-synthesis/norns-ui/components/Btn.n'` (used verbatim) |
| Project utilities | Named exports (`export const X`, `export X := …`, `export { a, b }`) discovered in `exportDirs` | `notes` from `$lib/notes/server/public`; `scheduleAiMove` from `./ai` (sibling) |

Resolution priority is **helpers → component dir → component preset → exports**. A name picked up earlier shadows a later match silently — first-match-wins lets you override a library preset by dropping a file under your own `componentDirs`.

Path emission:

- Files inside `$lib` emit `$lib/...` paths (portable, friendly to the dts file).
- Files outside `$lib` emit a path relative to the importer.
- Project-utility paths are stripped of their file extension to match Norns/SvelteKit convention (`'$lib/notes/server/public'`, not `…/public.c`); the configured `extensions` array does the rest.

Files without a `<script>` block get one prepended automatically when a known component is referenced from markup. Runes (`$state`, `$derived`, `$effect`, `$props`) are Svelte compiler globals — no import needed; the plugin doesn't touch them.

### Defaults

- **Helpers**: `svelte`, `svelte/store`, `@sveltejs/kit`, `$app/state` (non-server paths), `@human-synthesis/norns/server` (server paths only).
- **Component dirs**: `['src/lib/components']`.
- **Component extensions**: `['.svelte', '.n']`.
- **Export dirs**: `false` (off) — opt in. SvelteKit route/hook files (`+*.{c,svelte,n}`, `hooks.*`) are excluded from the export scan since their named exports (`load`, `actions`, `handle`, …) are framework-consumed.
- **Export extensions**: `['.c', '.civet', '.js']`. `.ts` is excluded by default — regex-based scanning can't reliably tell value exports from type-only ones under `verbatimModuleSyntax`.

### UI library presets

A preset is a function returning a config slice — typically a `components` map. Compose it with your own config:

```js
// vite.config.js
import { presetUI } from '@human-synthesis/norns-ui/auto-import';

const ui = presetUI();

export default {
  plugins: [
    nornsCivetPlugin(),
    nornsAutoImport({
      exportDirs: ['src/lib', 'src/routes'],
      components: ui.components   // { Btn: '@human-synthesis/norns-ui/components/Btn.n', … }
    }),
    sveltekit()
  ]
};
```

Drop `src/lib/components/Btn.n` in your project and it shadows the preset's `Btn` silently — `componentDirs` resolves first.

> **Roadmap.** Helpers from a preset (e.g. `toast()` from a UI library) currently can't merge with the defaults — passing `helpers` to `nornsAutoImport` _replaces_ the default list. A `presets` (or `additionalHelpers`) option to extend without replacing is a planned follow-up; for now, presets only deliver components.

### Full options reference

| Option | Default | Notes |
|--------|---------|-------|
| `helpers` | `DEFAULT_HELPERS` (5 modules) | Pass `false` to disable. Each entry: `{ from, imports[], match? }` where `match` is a regex tested against the filename. |
| `componentDirs` | `['src/lib/components']` | `false` or `[]` to disable. |
| `componentExtensions` | `['.svelte', '.n']` | |
| `components` | `null` | `Record<name, importPath>` — bare-specifier preset map. |
| `exportDirs` | `false` | Off by default. Opt in with e.g. `['src/lib', 'src/routes']`. |
| `exportExtensions` | `['.c', '.civet', '.js']` | |
| `libRoot` | `'src/lib'` | Project-relative root that `libAlias` maps to. |
| `libAlias` | `'$lib'` | Alias prefix emitted in import paths. |
| `root` | `process.cwd()` | Project root. |

## Runtime — feature folders + DI

Wire your hooks once:

```civet
# src/hooks.server.c
import { boot } from '@human-synthesis/norns/server'

features := import.meta.glob './lib/*/server/module.c', { eager: true }
app := await boot { features }

{ handle, handleError } := app
export { handle, handleError }
```

Each feature is a folder under `src/lib/<feature>/`:

```
src/lib/notes/
  server/
    module.c        # registers DI bindings + migrations
    repo.c          # SQL / data access
    service.c       # business logic
    public.c        # the ONLY file other features may import
  shared/
    schema.c        # valibot validation schemas
```

Routes use thin wrappers from `@human-synthesis/norns/server`:

```civet
# src/routes/notes/+page.server.c
import { page } from '@human-synthesis/norns/server'
import { notes } from '$lib/notes/server/public'
import { createNoteSchema } from '$lib/notes/shared/schema'

export load := page.load
  handler: ({ container }) =>
    notes: notes(container).list()

export actions := page.actions
  create:
    input: createNoteSchema
    run: ({ input, container }) =>
      id := notes(container).create input
      throw redirect 303, `/notes/${id}`
```

The wrappers handle: input parsing, [valibot](https://valibot.dev) validation, container resolution, and consistent error mapping.

## Migrations

```sh
bun run migrate create notes/add_pinned    # scaffold migrations/notes/<ts>_add_pinned.sql
bun run migrate up                         # apply pending migrations
bun run migrate status                     # list applied + pending
```

Migration files live at `<project>/migrations/<feature>/*.sql`. The CLI tracks applied migrations in a `norns_migrations` table.

v1 supports SQLite via `better-sqlite3`. For Cloudflare D1 use `wrangler d1 migrations apply`. Postgres / libSQL via the CLI are planned.

## Drivers

The `db` helpers wire Drizzle across multiple targets:

```civet
# module.c — Node + better-sqlite3 in dev
import { betterSqlite } from '@human-synthesis/norns/server'
db := await betterSqlite 'data/app.db', { pragma: ['journal_mode = WAL'] }
app.single 'db', => db
```

D1, libSQL, and Postgres factories ship in the same module; the driver packages are user-installed (peer-style).

## License

MIT © Daniel Teodoroiu / [Human Synthesis](https://humansynthesis.ai). Built on top of [SvelteKit](https://github.com/sveltejs/kit) and [Svelte](https://github.com/sveltejs/svelte) © Svelte Contributors, MIT licensed.
