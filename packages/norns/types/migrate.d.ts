/**
 * List feature folder names under `src/lib/`. A folder is a feature iff it
 * contains `server/module.c`.
 *
 * @param {string} libDir
 * @returns {string[]}
 */
export function listFeatures(libDir: string): string[];
/** @typedef {{ feature: string, file: string, path: string, id: string }} Migration */
/** @param {string} cwd */
export function migrationsRoot(cwd: string): string;
/**
 * Scan `<cwd>/migrations/<feature>/*.sql` across all features. Sorted by
 * filename first (so timestamp-prefixed files apply chronologically across
 * features) and feature name as a tiebreaker.
 *
 * @param {string} cwd
 * @returns {Migration[]}
 */
export function listMigrations(cwd: string): Migration[];
/**
 * Resolve `DATABASE_URL` to a connection. v1: only `file:` (SQLite via
 * better-sqlite3). Defaults to `file:./data/app.db` if unset.
 *
 * @param {string} cwd
 * @returns {{ kind: 'sqlite', path: string }}
 */
export function resolveDatabaseUrl(cwd: string): {
    kind: "sqlite";
    path: string;
};
/**
 * Open a SQLite db at `path` and ensure the migration tracking table exists.
 *
 * Backend is runtime-selected: `bun:sqlite` under Bun (no native build,
 * works on Alpine where `better-sqlite3`'s N-API binding fails to load
 * against Bun's V8 compat layer), `better-sqlite3` under Node.
 *
 * The returned object exposes the better-sqlite3 surface used by the
 * migration code (`pragma`, `exec`, `prepare(...).all/get/run`,
 * `transaction`, `close`). Under Bun a minimal `pragma()` shim is grafted
 * on — bun:sqlite has no built-in `pragma` method, but `exec('PRAGMA …')`
 * is equivalent for the writes the migrate code performs.
 *
 * @param {string} cwd directory whose `package.json` is used to resolve
 *                     better-sqlite3 from the consumer's node_modules
 *                     (only relevant under Node)
 * @param {string} path SQLite file path
 * @param {{ requireFrom?: string | URL }} [opts] override the require base
 *                                                (used by tests)
 * @returns {any}
 */
export function openSqliteDb(cwd: string, path: string, opts?: {
    requireFrom?: string | URL;
}): any;
/**
 * @param {any} db
 * @returns {Set<string>}
 */
export function getApplied(db: any): Set<string>;
/**
 * Apply pending migrations to `db`. Returns the list of ids applied.
 *
 * @param {any} db
 * @param {Migration[]} pending
 * @returns {string[]}
 */
export function applyMigrations(db: any, pending: Migration[]): string[];
/**
 * Scaffold a new migration file at `<cwd>/migrations/<feature>/<ts>_<slug>.sql`.
 *
 * No filesystem check on the feature name — both `src/lib/<feature>/` (the
 * default convention) and nested layouts like `src/lib/<group>/<feature>/`
 * (used by demos that mirror multiple variants side by side) are valid.
 * Typo'd feature names produce orphan folders that are easy to spot under
 * `migrations/`.
 *
 * @param {string} cwd
 * @param {string} arg `<feature>/<name>` form
 * @returns {string} the path of the created file
 */
export function createMigration(cwd: string, arg: string): string;
/**
 * Reserved names under `src/lib/`. These are treated as utility folders, not
 * features. Anything starting with `_` is also reserved.
 */
export const RESERVED_LIB_DIRS: Set<string>;
export const MIGRATION_TABLE: "norns_migrations";
export type Migration = {
    feature: string;
    file: string;
    path: string;
    id: string;
};
