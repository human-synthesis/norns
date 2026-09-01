/**
 * Drizzle driver factories + a portable transaction helper.
 *
 * Drivers are imported lazily so consumers only need to install the ones they
 * actually use. Drizzle and its driver packages are user-installed (not
 * bundled in norns) — the framework just provides the assembly recipe.
 *
 * The dynamic `import()` paths are routed through a variable + `@vite-ignore`
 * so Rollup doesn't try to resolve them at build time when the consumer
 * hasn't installed the corresponding driver.
 *
 * Bind the result as `db` in your feature's `module.c`:
 *
 *   import { betterSqlite } from '@human-synthesis/norns/server';
 *   module.exports = (app) ->
 *     dbInstance = await betterSqlite('data/notes.db', pragma: ['journal_mode = WAL'])
 *     app.single 'db', -> dbInstance
 *
 * For Cloudflare Workers, switch to `d1(env.DB)`. Same module.c shape.
 */

/**
 * Pass-through dynamic import that hides the path from Rollup's static
 * analyzer. Without this, building an app that doesn't have (say)
 * `drizzle-orm/d1` installed fails even if the app never calls `d1()`.
 *
 * @param {string} mod
 * @returns {Promise<any>}
 */
function importDynamic(mod) {
	return import(/* @vite-ignore */ mod);
}

/**
 * @typedef {Object} BetterSqliteOptions
 * @property {Object} [connection] passed to `new Database(path, opts)`
 * @property {string[]} [pragma] PRAGMA statements to run after open
 * @property {Object} [drizzle] passed to `drizzle(sqlite, opts)`
 */

/**
 * @typedef {Object} D1Options
 * @property {Object} [drizzle] passed to `drizzle(binding, opts)`
 */

/**
 * @typedef {Object} LibsqlOptions
 * @property {Object} [client] passed to `createClient({ url, ...client })`
 * @property {Object} [drizzle] passed to `drizzle(client, opts)`
 */

/**
 * @typedef {Object} PostgresOptions
 * @property {Object} [pool] passed to `new Pool({ connectionString: url, ...pool })`
 * @property {Object} [drizzle] passed to `drizzle(pool, opts)`
 */

/**
 * Open a Drizzle instance backed by SQLite.
 *
 * Backend is runtime-selected: `bun:sqlite` + `drizzle-orm/bun-sqlite` under
 * Bun (built-in, no native build, works on Alpine), `better-sqlite3` +
 * `drizzle-orm/better-sqlite3` under Node. The function name keeps the
 * `betterSqlite` alias for backward compatibility — what actually gets
 * loaded depends on the runtime.
 *
 * @param {string} path SQLite file path (e.g. `data/notes.db`)
 * @param {BetterSqliteOptions} [opts]
 * @returns {Promise<any>}
 */
export async function betterSqlite(path, opts = {}) {
	if (typeof Bun !== 'undefined') {
		const [{ Database }, { drizzle }] = await Promise.all([
			importDynamic('bun:sqlite'),
			importDynamic('drizzle-orm/bun-sqlite')
		]);
		const sqlite = new Database(path, opts.connection);
		if (opts.pragma) {
			// bun:sqlite has no `pragma()` method — use `exec('PRAGMA …')`.
			for (const p of opts.pragma) sqlite.exec('PRAGMA ' + p);
		}
		return drizzle(sqlite, opts.drizzle);
	}
	const [{ default: Database }, { drizzle }] = await Promise.all([
		importDynamic('better-sqlite3'),
		importDynamic('drizzle-orm/better-sqlite3')
	]);
	const sqlite = new Database(path, opts.connection);
	if (opts.pragma) {
		for (const p of opts.pragma) sqlite.pragma(p);
	}
	return drizzle(sqlite, opts.drizzle);
}

/**
 * Open a Drizzle instance backed by Cloudflare D1.
 *
 * @param {any} binding D1 binding from `event.platform.env`
 * @param {D1Options} [opts]
 * @returns {Promise<any>}
 */
export async function d1(binding, opts = {}) {
	// Literal specifier on purpose: wrangler's esbuild must bundle the D1
	// driver into the worker (a runtime importDynamic() can never resolve
	// inside a workerd bundle). Safe to resolve statically — drizzle-orm is
	// a hard dependency of every generated app, unlike the native drivers.
	const { drizzle } = await import('drizzle-orm/d1');
	return drizzle(binding, opts.drizzle);
}

/**
 * Open a Drizzle instance backed by libSQL (Turso, sqld).
 *
 * @param {string} url
 * @param {LibsqlOptions} [opts]
 * @returns {Promise<any>}
 */
export async function libsql(url, opts = {}) {
	const [{ createClient }, { drizzle }] = await Promise.all([
		importDynamic('@libsql/client'),
		importDynamic('drizzle-orm/libsql')
	]);
	const client = createClient({ url, ...(opts.client ?? {}) });
	return drizzle(client, opts.drizzle);
}

/**
 * Open a Drizzle instance backed by node-postgres.
 *
 * @param {string} url
 * @param {PostgresOptions} [opts]
 * @returns {Promise<any>}
 */
export async function postgres(url, opts = {}) {
	const [{ default: pgModule }, { drizzle }] = await Promise.all([
		importDynamic('pg'),
		importDynamic('drizzle-orm/node-postgres')
	]);
	const pool = new pgModule.Pool({ connectionString: url, ...(opts.pool ?? {}) });
	return drizzle(pool, opts.drizzle);
}

/**
 * Apply committed SQL migrations to a SQLite-backed Drizzle instance.
 *
 * Walks `dirs` (a root like `migrations/` whose subdirectories are module
 * migration sets, or an explicit list of dirs), applies `*.sql` files in
 * name order, and records each in `_norns_migrations` so re-runs are
 * no-ops. Statements are split on drizzle-kit's `--> statement-breakpoint`
 * marker. Local/dev helper — production D1 migrates via
 * `wrangler d1 migrations apply`.
 *
 * @param {any} db Drizzle SQLite instance
 * @param {string | string[]} dirs
 * @returns {Promise<string[]>} ids of newly applied migration files
 */
export async function applyMigrations(db, dirs) {
	const [{ sql }, fs, path] = await Promise.all([
		importDynamic('drizzle-orm'),
		importDynamic('node:fs'),
		importDynamic('node:path')
	]);
	await db.run(sql.raw('CREATE TABLE IF NOT EXISTS "_norns_migrations" ("name" text PRIMARY KEY)'));
	const rows = await db.all(sql.raw('SELECT "name" FROM "_norns_migrations"'));
	const applied = new Set(rows.map((r) => r.name));

	const byName = (a, b) => a.localeCompare(b);
	const files = [];
	for (const root of Array.isArray(dirs) ? dirs : [dirs]) {
		if (!fs.existsSync(root)) continue;
		const entries = fs.readdirSync(root, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => byName(a.name, b.name))) {
			if (entry.isDirectory()) {
				const sqls = fs
					.readdirSync(path.join(root, entry.name))
					.filter((f) => f.endsWith('.sql'))
					.sort(byName);
				for (const f of sqls) {
					files.push({ id: `${entry.name}/${f}`, file: path.join(root, entry.name, f) });
				}
			} else if (entry.name.endsWith('.sql')) {
				files.push({ id: entry.name, file: path.join(root, entry.name) });
			}
		}
	}

	const ran = [];
	for (const { id, file } of files) {
		if (applied.has(id)) continue;
		const text = fs.readFileSync(file, 'utf-8');
		const stmts = text
			.split(/-->\s*statement-breakpoint/)
			.map((s) => s.trim())
			.filter(Boolean);
		for (const stmt of stmts) await db.run(sql.raw(stmt));
		await db.run(
			sql.raw(`INSERT INTO "_norns_migrations" ("name") VALUES ('${id.replaceAll("'", "''")}')`)
		);
		ran.push(id);
	}
	return ran;
}

/**
 * Run `fn` inside a Drizzle transaction. Uniform across drivers.
 *
 * @template T
 * @param {any} db Drizzle instance
 * @param {(tx: any) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withTransaction(db, fn) {
	return db.transaction(fn);
}
