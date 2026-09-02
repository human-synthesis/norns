/**
 * Migration pipeline (K-11): generate → compile schema → drizzle-kit diff.
 *
 * Migrations are committed SQL under `migrations/<module>/`, produced by
 * drizzle-kit (pinned) diffing the emitted Drizzle schema against its own
 * snapshot journal. Additive by default: a diff that drops tables or
 * columns is refused unless `force` — spec `remove` should go through a
 * deprecation step first.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { GenerateError, generateApp } from './generate.js';
import { loadSpecs } from './validate.js';

const require = createRequire(import.meta.url);

const DRIZZLE_DIALECTS = { d1: 'sqlite', sqlite: 'sqlite', postgres: 'postgresql' };

const DESTRUCTIVE_SQL = /\bDROP TABLE\b|\bDROP COLUMN\b|__new_/i;

/**
 * v6 K-45: drizzle-kit's SQLite table rebuild reads the *new* column list
 * out of the *old* table (`INSERT INTO __new_t(a,b,new) SELECT a,b,new
 * FROM t`), which can never apply when columns were added. The emitted SQL
 * is verified against the previous snapshot's columns and corrected to the
 * intersection — omitted new columns land on their CREATE TABLE defaults.
 * A rebuild that drops no old column is not destructive, whatever tokens
 * it uses; one that does still is.
 */
const REBUILD_RE = /INSERT INTO ([`"])(__new_([A-Za-z0-9_]+))\1\s*\(([^)]*)\)\s*SELECT ([\s\S]*?) FROM ([`"])\3\6\s*;/g;

/** table name → Set(column names) from the newest snapshot in `<out>/meta`. */
function snapshotColumns(out) {
	const meta = join(out, 'meta');
	if (!existsSync(meta)) return new Map();
	const snaps = readdirSync(meta)
		.filter((f) => f.endsWith('_snapshot.json'))
		.sort();
	if (snaps.length === 0) return new Map();
	try {
		const snap = JSON.parse(readFileSync(join(meta, snaps[snaps.length - 1]), 'utf-8'));
		const tables = new Map();
		for (const [key, table] of Object.entries(snap.tables ?? {})) {
			const cols = new Set(Object.values(table.columns ?? {}).map((c) => c?.name ?? c));
			tables.set(table.name ?? key, cols);
		}
		return tables;
	} catch {
		return new Map();
	}
}

/**
 * Correct rebuild INSERT…SELECT column lists to columns the old table
 * actually has, and report which rebuilds are benign (drop nothing).
 */
function verifyRebuilds(sql, priorTables) {
	const benignTables = [];
	const fixed = sql.replace(REBUILD_RE, (whole, q, newTable, table, insertList) => {
		const oldCols = priorTables.get(table);
		if (!oldCols) return whole; // no prior table — not a rebuild of known state
		const cols = insertList
			.split(',')
			.map((s) => s.trim().replace(/^["'`]|["'`]$/g, ''))
			.filter(Boolean);
		const kept = cols.filter((c) => oldCols.has(c));
		const dropped = [...oldCols].filter((c) => !cols.includes(c));
		if (dropped.length > 0) return whole; // destructive rebuild — leave for the gate
		benignTables.push(table);
		if (kept.length === cols.length) return whole; // SELECT list already valid
		const list = kept.map((c) => `"${c}"`).join(', ');
		return `INSERT INTO \`${newTable}\`(${list}) SELECT ${list} FROM \`${table}\`;`;
	});
	return { sql: fixed, benignTables };
}

/** The SQL with benign rebuild statements removed, for the destructive test. */
function withoutBenignRebuilds(sql, tables) {
	let out = sql;
	for (const t of tables) {
		const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		out = out
			.replace(new RegExp(`[^;]*__new_${esc}[^;]*;`, 'g'), '')
			.replace(new RegExp('DROP TABLE [`"]' + esc + '[`"];?', 'g'), '');
	}
	return out;
}

function drizzleKitBin() {
	return join(dirname(require.resolve('drizzle-kit')), 'bin.cjs');
}

function sqlFiles(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Diff one module's emitted schema against its migration journal.
 * Runs drizzle-kit in a scratch copy of `migrations/<module>` and only
 * copies the result back when the new SQL is non-destructive (or forced).
 *
 * @returns {{ created: string[], refusals: import('./generate.js').Refusal[] }}
 */
function migrateModule({ moduleName, schemaFile, migrationsDir, workDir, dialect, name, force, pendingDir }) {
	const scratch = join(workDir, moduleName);
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(scratch, { recursive: true });

	const { compile } = require('@danielx/civet');
	const schemaJs = join(scratch, 'schema.js');
	writeFileSync(schemaJs, compile(readFileSync(schemaFile, 'utf-8'), { sync: true, js: true }));

	const out = join(scratch, 'out');
	if (existsSync(migrationsDir)) cpSync(migrationsDir, out, { recursive: true });

	// drizzle-kit prefixes paths with './' internally, so absolute paths
	// break snapshot reads — keep config paths relative to the scratch cwd.
	const config = join(scratch, 'drizzle.config.js');
	writeFileSync(
		config,
		`export default ${JSON.stringify({ dialect, schema: 'schema.js', out: 'out' }, null, '\t')}\n`
	);

	const priorTables = snapshotColumns(out);
	const before = new Set(sqlFiles(out));
	const run = spawnSync(process.execPath, [drizzleKitBin(), 'generate', '--config', config, '--name', name], {
		cwd: scratch,
		encoding: 'utf-8'
	});
	const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
	const created = sqlFiles(out).filter((f) => !before.has(f));
	// drizzle-kit exits 0 even on load errors, so judge by outcome.
	if (run.status !== 0 || (created.length === 0 && !/No schema changes/.test(output))) {
		throw new Error(`norns migrate: drizzle-kit failed for module "${moduleName}"\n${output}`);
	}
	if (created.length === 0) return { created: [], refusals: [] };

	// Verify (and correct) SQLite table rebuilds against the pre-generation
	// snapshot before anything is judged or copied back (v6 K-45).
	const benign = new Map();
	for (const file of created) {
		const raw = readFileSync(join(out, file), 'utf-8');
		const { sql, benignTables } = verifyRebuilds(raw, priorTables);
		if (sql !== raw) writeFileSync(join(out, file), sql);
		benign.set(file, benignTables);
	}

	const refusals = [];
	if (!force) {
		for (const file of created) {
			const sql = readFileSync(join(out, file), 'utf-8');
			if (DESTRUCTIVE_SQL.test(withoutBenignRebuilds(sql, benign.get(file) ?? []))) {
				const reviewAt = pendingDir ? `${pendingDir}/${file}` : `the scratch output`;
				refusals.push({
					address: moduleName,
					path: `migrations/${moduleName}/${file}`,
					code: 'DESTRUCTIVE_MIGRATION',
					message: `migration drops tables or columns (${file})`,
					fix: `deprecate the field/entity first, or review the candidate SQL at ${reviewAt} and re-run with --force`
				});
			}
		}
	}
	if (refusals.length > 0) {
		// "Review the SQL" must be actionable: write the refused candidate
		// files somewhere durable before the scratch dir is recycled.
		if (pendingDir) {
			rmSync(pendingDir, { recursive: true, force: true });
			mkdirSync(pendingDir, { recursive: true });
			for (const file of created) cpSync(join(out, file), join(pendingDir, file));
		}
		return { created: [], refusals };
	}

	cpSync(out, migrationsDir, { recursive: true });
	return { created, refusals: [] };
}

/**
 * Generate committed SQL migrations for every module with a schema.
 *
 * @param {string} [dir] specs directory, defaults to `<cwd>/specs`
 * @param {{ out?: string, migrations?: string, force?: boolean }} [opts]
 * @returns {{ version: string, created: Record<string, string[]>, unchanged: string[] }}
 */
export function migrateApp(dir, opts = {}) {
	const specs = loadSpecs(dir);
	const appRoot = dirname(specs.dir);
	const genRoot = opts.out ?? join(appRoot, '.norns', 'generated');
	const migrationsRoot = opts.migrations ?? join(appRoot, 'migrations');
	const workDir = join(appRoot, '.norns', 'cache', 'migrate');

	const dialect = DRIZZLE_DIALECTS[specs.app?.dialect ?? 'd1'];
	generateApp(dir, { out: opts.out, force: opts.force });

	const created = {};
	const unchanged = [];
	const refusals = [];
	for (const moduleName of Object.keys(specs.modules)) {
		const schemaFile = join(genRoot, 'lib', moduleName, 'schema.c');
		if (!existsSync(schemaFile)) continue;
		const result = migrateModule({
			moduleName,
			schemaFile,
			migrationsDir: join(migrationsRoot, moduleName),
			workDir,
			dialect,
			name: specs.hashes[moduleName].slice(0, 8),
			force: opts.force === true,
			pendingDir: join(appRoot, '.norns', 'cache', 'migrations-pending', moduleName)
		});
		refusals.push(...result.refusals);
		if (result.created.length > 0) created[moduleName] = result.created;
		else unchanged.push(moduleName);
	}
	if (refusals.length > 0) throw new GenerateError(refusals);

	return { version: specs.version, created, unchanged };
}
