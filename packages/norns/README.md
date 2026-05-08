# Norns

**AI-driven software architecture and development framework, based on Svelte.**

SvelteKit with **Pug + Civet** and the `.n` / `.c` file extensions — preconfigured. The `.c` extension is recognised as an alias for `.civet`; both compile through Civet. CoffeeScript is no longer supported.

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

## Runtime — feature folders + DI

Wire your hooks once:

```coffee
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

```coffee
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

```coffee
# module.c — Node + better-sqlite3 in dev
import { betterSqlite } from '@human-synthesis/norns/server'
db := await betterSqlite 'data/app.db', { pragma: ['journal_mode = WAL'] }
app.single 'db', => db
```

D1, libSQL, and Postgres factories ship in the same module; the driver packages are user-installed (peer-style).

## License

MIT © Daniel Teodoroiu / [Human Synthesis](https://humansynthesis.ai). Built on top of [SvelteKit](https://github.com/sveltejs/kit) and [Svelte](https://github.com/sveltejs/svelte) © Svelte Contributors, MIT licensed.
