# Authoring Norns specs

Norns apps are **spec-canonical**: the TRON files under `specs/` are the single
source of truth. `norns generate` turns them into a complete SvelteKit app
(schema, queries, actions, policies, state machines, pages, wrangler config)
under the gitignored `.norns/generated/` tree. Hand-written code lives only in
`src/` — either *custom bodies* referenced from the spec (`impl: custom`) or
runtime wiring (`hooks.server.c`).

The generator **refuses** rather than guesses. If a spec is ambiguous, unsafe,
or references something that doesn't exist, generation stops with a structured
refusal (`code`, `message`, `fix`) instead of emitting wrong code.

## Files

```
specs/
  app.tron          app-level config: name, dialect, module list
  <module>.tron     one file per module
src/                custom code only
migrations/         committed SQL, written by `norns migrate gen`
.norns/             generated output + caches (gitignore this)
```

## Workflow

```sh
norns generate      # specs → .norns/generated (incremental, per-module hash)
norns migrate gen   # entity diff → migrations/<module>/*.sql — commit these
norns trace         # run every Action example against sandboxed SQLite
norns dev           # watch specs/, regenerate on save, serve the app
norns build         # production build (Cloudflare worker by default)
```

`norns trace` is the spec-level test suite: each action example seeds the
entity graph, executes the real generated action (including custom bodies),
and asserts `expect` against the resulting row.

## app.tron

```tron
{ "name": "shop", "dialect": "d1", "modules": ["catalog", "orders"] }
```

- `dialect`: `d1` (default target), `sqlite`, or `postgres`.
- `settings.cloudflare`: `d1_id`, `compatibility_date`, `r2: true`,
  `queue: true` — flows into the generated `wrangler.json`.

## Module specs

```tron
{
  "module": "orders",
  "depends": ["core", "catalog"],
  "entities":  { ... },
  "queries":   { ... },
  "actions":   { ... },
  "policies":  { ... },
  "pages":     { ... },
  "triggers":  { ... }
}
```

`depends` declares which modules this one may reference; the dependency graph
must be a DAG. `core` provides `core.Entity.User`.

Every unit is addressable as `module.Kind.name` — e.g. `orders.Query.recent`,
`deals.Action.win`. Addresses are how specs reference each other (refresh
lists, trigger targets, page bindings) and how refusals and traces name
things.

### Entities

```tron
"Deal": {
  "owner": "owner",
  "fields": {
    "owner":     { "type": "ref", "ref": "core.Entity.User" },
    "title":     "text",
    "amount":    { "type": "money" },
    "closeDate": { "type": "date", "optional": true }
  },
  "status": { "open": ["won", "lost"], "won": [], "lost": [] }
}
```

- Field shorthand: `"title": "text"` ≡ `{ "type": "text" }`.
- Field types: `text`, `number`, `int`, `money` (integer cents), `bool`,
  `date` / `datetime` (timestamp integers), `email`, `url`, `json`, `file`
  (adds an R2 bucket to the wrangler config), `ref` (requires `ref:` naming an
  entity; other types must not have `ref`).
- Field options: `optional`, `unique`, `default`.
- `owner` names the field policies use for ownership rules.
- `status` defines a state machine: key = state, value = allowed next states.
  Every reachable state must be declared (closed machine). Generation emits
  the enum, a transition guard, and per-transition hooks; the column defaults
  to the machine's initial state.

### Queries

```tron
"pipeline": { "from": "Deal", "live": true, "groupBy": "status" },
"recent":   { "from": "Deal", "filter": "status == open", "sort": "title", "limit": 50 }
```

Options: `from` (entity), `filter` (expression), `sort` (string or array),
`limit`, `live`, `groupBy`. A query with no `limit` that is neither `live` nor
grouped is refused (`UNPAGINATED_QUERY`) — unbounded reads don't ship.

The generated query applies the entity's **read policy** to every select; a
request with no user sees only what the policy allows.

### Actions

Actions are id-row based: input names a row (`"id": "Deal.id"`) plus any extra
fields, guards run, then steps execute against that row.

```tron
"win": {
  "input": { "id": "Deal.id" },
  "requires": "status == open",
  "steps": [
    { "set": { "status": "won", "entity": "Deal" } },
    { "emit": "deal.won" }
  ],
  "refresh": ["deals.Query.pipeline"],
  "examples": [{ "input": { "id": "$open" }, "expect": { "status": "won" } }]
}
```

- `requires`: expression guard evaluated against the row (and user).
- Steps: `set` (update fields — status changes are validated against the
  machine), `emit` (publish an event to the bus / queue), `call` (invoke a
  container-bound function).
- `refresh`: query addresses to re-run after the action (page invalidation).
- `transport`: `form` (default). `remote` is refused until spiked
  (`UNSPIKED_TRANSPORT`).
- Any action that writes an entity with no Policy is refused
  (`UNGUARDED_ACTION`).
- `examples` seed rows and assert outcomes; `"$open"` means "a row currently
  in state `open`". `norns trace` executes them all.

**Custom actions** — `"impl": "custom"` (requires at least one example):

```tron
"reprice": {
  "input": { "amount": "Deal.amount", "id": "Deal.id" },
  "examples": [{ "input": { "amount": 1000, "id": "$open" }, "expect": { "amount": 900 } }],
  "impl": "custom"
}
```

The generated shell still runs policies and guards, then calls your body at
`src/<module>/actions/<name>.c`:

```civet
import { eq } from 'drizzle-orm'
import { Deal } from '$lib/deals/schema.c'

export default async ({ row, input, container, user }) => {
	const db = container.resolve('db')
	const amount = Math.round(input.amount * 0.9)
	await db.update(Deal).set({ amount }).where(eq(Deal.id, input.id))
	return { amount }
}
```

### Policies

```tron
"Deal": { "read": "owner or role:admin", "write": "owner" }
```

- `read` / `write`: expressions over ownership (`owner` — row's owner field
  equals `user.id`) and roles (`role:admin` — `user.roles` contains `admin`),
  combinable with `and` / `or` / `not`.
- `run`: per-action rules (`"run": { "win": "role:manager" }`).
- Read policies compile into SQL `WHERE` clauses on every generated query;
  write/run policies are checked in the action shell before any step runs.

### Pages

```tron
"index": {
  "route": "/",
  "components": [{ "table": "tasks.Query.open", "pageSize": 10 }]
}
```

Each component entry's **first key** selects the component (capitalized:
`table` → `Table`) and its value binds the primary prop — a Query address
binds `data`, an Action address binds `action` (the form target). Remaining
keys are literal props.

Bindings are validated at generate time against the valibot contracts
exported by `@human-synthesis/norns-ui/contracts` (strict objects — unknown
props, missing required bindings, or a Query where an Action belongs are all
refused with `INVALID_BINDING`). Tags without a published contract are passed
through, so custom components remain possible.

Other page fields: `params` (route params), `state`, `layout`, `slots`,
`impl: custom` (with examples) for hand-written pages.

### Triggers

```tron
"onWon":   { "action": "billing.Action.invoice", "source": "deal.won" },
"nightly": { "action": "reports.Action.rollup", "schedule": "0 3 * * *" }
```

Event triggers subscribe the target action to bus events; `schedule` triggers
become Cloudflare cron entries in `wrangler.json` (and run on a local
minute-shim under `norns dev`).

## Expressions

Guards, filters, and policies use a small CEL-subset grammar: comparisons
(`==`, `!=`, `<`, `<=`, `>`, `>=`), `and` / `or` / `not`, field names, status
literals, `owner`, `role:<name>`. Expressions are parsed at validation time —
a string that doesn't parse is an `INVALID_SPEC` error, never runtime glue.

## Refusal codes

| Code | Meaning | Fix |
| --- | --- | --- |
| `INVALID_SPEC` | Shape/reference/expression errors from validation | follow the per-issue message |
| `UNGUARDED_ACTION` | Action writes an entity that has no Policy | add read/write rules for the entity |
| `UNPAGINATED_QUERY` | Query without `limit`, `live`, or `groupBy` | add one |
| `UNSPIKED_TRANSPORT` | `transport: remote` requested | use `form` or drop it |
| `INVALID_BINDING` | Page component props violate the UI contract | match the contract from `@human-synthesis/norns-ui/contracts` |
| `DESTRUCTIVE_MIGRATION` | Generated SQL drops tables/columns | deprecate first, or review and re-run with `--force` |
| `SELFCHECK_FAILED` | Emitted Civet failed pre-compile | report — this is a generator bug, not a spec bug |

## Custom code and aliases

In spec-first mode SvelteKit's `routes`/`lib` point into `.norns/generated/`;
`$lib/...` therefore resolves to *generated* modules (e.g.
`$lib/<module>/schema.c`), while `$custom/...` resolves to `src/`. Generated
shells import your bodies via `$custom`; your bodies import generated schema
via `$lib`. A hand-written `src/hooks.server.c` wins over the generated one —
see the `norns-app` starter for the canonical wiring (db, triggers,
serializer, optional better-auth).

The emitted code stays inside a **vetted Civet/Pug subset**
(see `vetted-subset.md`) — constructs proven safe under the preprocessor
pipeline, pinned by regression suites in both `norns` and `norns-core`.
