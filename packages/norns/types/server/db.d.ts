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
export function betterSqlite(path: string, opts?: BetterSqliteOptions): Promise<any>;
/**
 * Open a Drizzle instance backed by Cloudflare D1.
 *
 * @param {any} binding D1 binding from `event.platform.env`
 * @param {D1Options} [opts]
 * @returns {Promise<any>}
 */
export function d1(binding: any, opts?: D1Options): Promise<any>;
/**
 * Open a Drizzle instance backed by libSQL (Turso, sqld).
 *
 * @param {string} url
 * @param {LibsqlOptions} [opts]
 * @returns {Promise<any>}
 */
export function libsql(url: string, opts?: LibsqlOptions): Promise<any>;
/**
 * Open a Drizzle instance backed by node-postgres.
 *
 * @param {string} url
 * @param {PostgresOptions} [opts]
 * @returns {Promise<any>}
 */
export function postgres(url: string, opts?: PostgresOptions): Promise<any>;
/**
 * Run `fn` inside a Drizzle transaction. Uniform across drivers.
 *
 * @template T
 * @param {any} db Drizzle instance
 * @param {(tx: any) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withTransaction<T>(db: any, fn: (tx: any) => T | Promise<T>): Promise<T>;
export type BetterSqliteOptions = {
    /**
     * passed to `new Database(path, opts)`
     */
    connection?: any;
    /**
     * PRAGMA statements to run after open
     */
    pragma?: string[];
    /**
     * passed to `drizzle(sqlite, opts)`
     */
    drizzle?: any;
};
export type D1Options = {
    /**
     * passed to `drizzle(binding, opts)`
     */
    drizzle?: any;
};
export type LibsqlOptions = {
    /**
     * passed to `createClient({ url, ...client })`
     */
    client?: any;
    /**
     * passed to `drizzle(client, opts)`
     */
    drizzle?: any;
};
export type PostgresOptions = {
    /**
     * passed to `new Pool({ connectionString: url, ...pool })`
     */
    pool?: any;
    /**
     * passed to `drizzle(pool, opts)`
     */
    drizzle?: any;
};
