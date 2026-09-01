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
function migrateModule({ moduleName, schemaFile, migrationsDir, workDir, dialect, name, force }) {
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

	const refusals = [];
	if (!force) {
		for (const file of created) {
			const sql = readFileSync(join(out, file), 'utf-8');
			if (DESTRUCTIVE_SQL.test(sql)) {
				refusals.push({
					address: moduleName,
					path: `migrations/${moduleName}/${file}`,
					code: 'DESTRUCTIVE_MIGRATION',
					message: `migration drops tables or columns (${file})`,
					fix: 'deprecate the field/entity first, or re-run with --force after reviewing the SQL'
				});
			}
		}
	}
	if (refusals.length > 0) return { created: [], refusals };

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
			force: opts.force === true
		});
		refusals.push(...result.refusals);
		if (result.created.length > 0) created[moduleName] = result.created;
		else unchanged.push(moduleName);
	}
	if (refusals.length > 0) throw new GenerateError(refusals);

	return { version: specs.version, created, unchanged };
}
