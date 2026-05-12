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
	const { drizzle } = await importDynamic('drizzle-orm/d1');
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
