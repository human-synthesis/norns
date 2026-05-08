/**
 * Migration discovery + applier for the `norns migrate` CLI. Pure functions —
 * `bin/norns.js` is a thin shell over these.
 *
 * Layout convention:
 *   <project>/migrations/<feature>/<timestamp>_<slug>.sql
 *
 * Migrations live at the project root, OUTSIDE `src/lib/`, organised per
 * feature. They aren't application code — they're operational artifacts that
 * tooling (this CLI, wrangler for D1) reads. Keeping them out of `src/lib`
 * also keeps SvelteKit's bundler from ever trying to ship them.
 *
 * v1 supports SQLite via `better-sqlite3`. Postgres/libSQL come later;
 * Cloudflare D1 is intentionally out of scope here — use
 * `wrangler d1 migrations apply <db>` for D1 deploys.
 */

import { existsSync, readdirSync, statSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

/**
 * Reserved names under `src/lib/`. These are treated as utility folders, not
 * features. Anything starting with `_` is also reserved.
 */
export const RESERVED_LIB_DIRS = new Set(['server', 'components', 'utils']);

export const MIGRATION_TABLE = 'norns_migrations';

/**
 * List feature folder names under `src/lib/`. A folder is a feature iff it
 * contains `server/module.c`.
 *
 * @param {string} libDir
 * @returns {string[]}
 */
export function listFeatures(libDir) {
	if (!existsSync(libDir)) return [];
	const out = [];
	for (const name of readdirSync(libDir)) {
		if (name.startsWith('_')) continue;
		if (RESERVED_LIB_DIRS.has(name)) continue;
		const featureDir = join(libDir, name);
		try {
			if (!statSync(featureDir).isDirectory()) continue;
		} catch {
			continue;
		}
		const modulePath = join(featureDir, 'server', 'module.c');
		if (existsSync(modulePath)) out.push(name);
	}
	out.sort();
	return out;
}

/** @typedef {{ feature: string, file: string, path: string, id: string }} Migration */

/** @param {string} cwd */
export function migrationsRoot(cwd) {
	return join(cwd, 'migrations');
}

/**
 * Scan `<cwd>/migrations/<feature>/*.sql` across all features. Sorted by
 * filename first (so timestamp-prefixed files apply chronologically across
 * features) and feature name as a tiebreaker.
 *
 * @param {string} cwd
 * @returns {Migration[]}
 */
export function listMigrations(cwd) {
	const root = migrationsRoot(cwd);
	if (!existsSync(root)) return [];
	const out = [];
	for (const feature of readdirSync(root)) {
		const featDir = join(root, feature);
		try {
			if (!statSync(featDir).isDirectory()) continue;
		} catch {
			continue;
		}
		for (const file of readdirSync(featDir)) {
			if (!file.endsWith('.sql')) continue;
			out.push({
				feature,
				file,
				path: join(featDir, file),
				id: `${feature}/${file.replace(/\.sql$/, '')}`
			});
		}
	}
	out.sort((a, b) => {
		const c = a.file.localeCompare(b.file);
		return c !== 0 ? c : a.feature.localeCompare(b.feature);
	});
	return out;
}

/**
 * Resolve `DATABASE_URL` to a connection. v1: only `file:` (SQLite via
 * better-sqlite3). Defaults to `file:./data/app.db` if unset.
 *
 * @param {string} cwd
 * @returns {{ kind: 'sqlite', path: string }}
 */
export function resolveDatabaseUrl(cwd) {
	const url = process.env.DATABASE_URL || `file:${join(cwd, 'data', 'app.db')}`;
	if (url.startsWith('file:')) return { kind: 'sqlite', path: url.slice(5) };
	const scheme = url.split('://')[0];
	throw new Error(
		`norns migrate: only SQLite (file:...) is supported in v1; got "${scheme}://...".\n` +
			'  For Cloudflare D1, use `wrangler d1 migrations apply <db>`.\n' +
			'  Postgres/libSQL via the CLI are not yet wired.'
	);
}

/**
 * Open a better-sqlite3 db at `path` and ensure the migration tracking table
 * exists.
 *
 * @param {string} cwd directory whose `package.json` is used to resolve
 *                     better-sqlite3 from the consumer's node_modules
 * @param {string} path SQLite file path
 * @param {{ requireFrom?: string | URL }} [opts] override the require base
 *                                                (used by tests)
 * @returns {any}
 */
export function openSqliteDb(cwd, path, opts = {}) {
	mkdirSync(dirname(path), { recursive: true });
	const require = createRequire(opts.requireFrom ?? join(cwd, 'package.json'));
	let Database;
	try {
		Database = require('better-sqlite3');
	} catch {
		throw new Error(
			'norns migrate: `better-sqlite3` is not installed in this app. Run: bun add better-sqlite3'
		);
	}
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
		id TEXT PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`);
	return db;
}

/**
 * @param {any} db
 * @returns {Set<string>}
 */
export function getApplied(db) {
	const rows = db.prepare(`SELECT id FROM ${MIGRATION_TABLE}`).all();
	return new Set(rows.map((r) => r.id));
}

/**
 * Apply pending migrations to `db`. Returns the list of ids applied.
 *
 * @param {any} db
 * @param {Migration[]} pending
 * @returns {string[]}
 */
export function applyMigrations(db, pending) {
	const insert = db.prepare(`INSERT INTO ${MIGRATION_TABLE} (id, applied_at) VALUES (?, ?)`);
	const applied = [];
	for (const m of pending) {
		const sql = readFileSync(m.path, 'utf8');
		const tx = db.transaction(() => {
			db.exec(sql);
			insert.run(m.id, Date.now());
		});
		tx();
		applied.push(m.id);
	}
	return applied;
}

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
export function createMigration(cwd, arg) {
	if (!arg || !arg.includes('/')) {
		throw new Error(
			'Usage: norns migrate create <feature>/<name>\nExample: norns migrate create notes/add_pinned_column'
		);
	}
	const [feature, ...rest] = arg.split('/');
	const slug = rest.join('/').replace(/[^a-zA-Z0-9_]+/g, '_');
	const migDir = join(migrationsRoot(cwd), feature);
	mkdirSync(migDir, { recursive: true });
	const ts = new Date()
		.toISOString()
		.replace(/[-:T]/g, '')
		.replace(/\..+$/, '')
		.slice(0, 14);
	const file = join(migDir, `${ts}_${slug}.sql`);
	writeFileSync(file, `-- ${feature}: ${slug}\n-- Created: ${new Date().toISOString()}\n\n`, {
		flag: 'wx'
	});
	return file;
}
