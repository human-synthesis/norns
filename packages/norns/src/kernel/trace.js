/**
 * Trace runner (K-18): execute Action `examples` against a sandboxed
 * in-memory SQLite and report per-case pass/fail with step values.
 *
 * The traced artifact is the *generated* code, not a re-interpretation of
 * the spec: the generated tree is compiled (Civet → JS) into a scratch
 * dir with imports rewritten to resolvable paths, then imported and run.
 *
 * Conventions:
 *   - `$name` input values are fixture handles: a row with that id is
 *     seeded in the action's entity table; if `name` is one of the
 *     entity's states, the row starts in that state. Owner/ref fields
 *     are seeded to the trace user so `owner` policies pass.
 *   - `expect` keys are checked against the entity row after the run,
 *     falling back to the action's return value.
 *   - external calls (`container.resolve(...)`) hit `opts.fixtures` when
 *     provided, otherwise a recording stub — every call is reported.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { actionEntity } from './emit-units.js';
import { normalizeField } from './emit-schema.js';
import { generateApp } from './generate.js';
import { loadSpecs } from './validate.js';

const require = createRequire(import.meta.url);

export const TRACE_USER = { id: 'trace-user', roles: ['admin'] };

/* ------------------------------------------------------------------ */
/* Scratch tree: compile generated Civet to importable JS              */
/* ------------------------------------------------------------------ */

const BARE = {
	'@human-synthesis/norns/server': new URL('../server/index.js', import.meta.url).href,
	'@human-synthesis/norns/kernel': new URL('./index.js', import.meta.url).href
};

function resolveBare(spec) {
	if (BARE[spec]) return BARE[spec];
	return import.meta.resolve(spec);
}

function rewriteImports(js, { scratch, appRoot, compileCivet }) {
	return js.replace(/(from\s+)(['"])([^'"]+)\2/g, (whole, from, q, spec) => {
		if (spec.startsWith('.')) return `${from}${q}${spec.replace(/\.c$/, '.js')}${q}`;
		if (spec.startsWith('$lib/')) {
			const target = join(scratch, 'lib', spec.slice('$lib/'.length).replace(/\.c$/, '.js'));
			return `${from}${q}${pathToFileURL(target).href}${q}`;
		}
		if (spec.startsWith('$custom/')) {
			const rel = spec.slice('$custom/'.length);
			const target = join(scratch, 'custom', rel.replace(/\.c$/, '.js'));
			if (!existsSync(target)) {
				const src = join(appRoot, 'src', rel);
				mkdirSync(dirname(target), { recursive: true });
				if (existsSync(src)) {
					writeFileSync(
						target,
						rewriteImports(compileCivet(readFileSync(src, 'utf-8')), { scratch, appRoot, compileCivet })
					);
				} else {
					writeFileSync(
						target,
						`export default () => { throw new Error(${JSON.stringify(`missing custom body: src/${rel}`)}) }\n`
					);
				}
			}
			return `${from}${q}${pathToFileURL(target).href}${q}`;
		}
		return `${from}${q}${resolveBare(spec)}${q}`;
	});
}

/** Compile `lib/**` of the generated tree into `<scratch>/lib` as JS. */
function buildScratch(genRoot, scratch, appRoot) {
	const { compile } = require('@danielx/civet');
	const compileCivet = (src) => compile(src, { sync: true, js: true });
	const libRoot = join(genRoot, 'lib');
	if (!existsSync(libRoot)) return;
	for (const moduleName of readdirSync(libRoot)) {
		const dir = join(libRoot, moduleName);
		for (const file of readdirSync(dir)) {
			if (!file.endsWith('.c')) continue;
			const js = rewriteImports(compileCivet(readFileSync(join(dir, file), 'utf-8')), {
				scratch,
				appRoot,
				compileCivet
			});
			const out = join(scratch, 'lib', moduleName, file.replace(/\.c$/, '.js'));
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, js);
		}
	}
}

/* ------------------------------------------------------------------ */
/* Sandbox database                                                    */
/* ------------------------------------------------------------------ */

const sqlLit = (v) =>
	typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? '1' : '0') : `'${String(v).replaceAll("'", "''")}'`;

async function tableDDL(tables) {
	const { getTableConfig } = await import('drizzle-orm/sqlite-core');
	return tables.map((table) => {
		const cfg = getTableConfig(table);
		const cols = cfg.columns.map((c) => {
			let s = `"${c.name}" ${c.getSQLType()}`;
			if (c.primary) s += ' PRIMARY KEY';
			else if (c.notNull) s += ' NOT NULL';
			if (c.hasDefault && c.default !== undefined) s += ` DEFAULT ${sqlLit(c.default)}`;
			return s;
		});
		return `CREATE TABLE "${cfg.name}" (${cols.join(', ')})`;
	});
}

/** Collect every sqliteTable export across the compiled schema modules. */
async function loadTables(scratch, specs) {
	const tables = {};
	for (const moduleName of Object.keys(specs.modules)) {
		const file = join(scratch, 'lib', moduleName, 'schema.js');
		if (!existsSync(file)) continue;
		const mod = await import(pathToFileURL(file).href);
		for (const [entity] of Object.entries(specs.modules[moduleName].entities ?? {})) {
			if (mod[entity]) tables[`${moduleName}.${entity}`] = mod[entity];
		}
	}
	return tables;
}

const SEED_VALUES = {
	text: 'trace',
	email: 'trace@example.com',
	url: 'https://example.com',
	file: 'trace.bin',
	int: 0,
	money: 0,
	number: 0,
	bool: false,
	json: {}
};

function seedRow(id, entitySpec) {
	const row = { id };
	const owner = entitySpec.owner;
	for (const [field, def0] of Object.entries(entitySpec.fields ?? {})) {
		const def = normalizeField(def0);
		if (def.optional) continue;
		if (field === owner || def.type === 'ref') row[field] = TRACE_USER.id;
		else if (def.type === 'date' || def.type === 'datetime') row[field] = new Date(0);
		else row[field] = def.default ?? SEED_VALUES[def.type] ?? 'trace';
	}
	const states = Object.keys(entitySpec.status ?? {});
	const name = id.startsWith('$') ? id.slice(1) : null;
	if (name && states.includes(name)) row.status = name;
	return row;
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

function recordingContainer(db, { fixtures = {}, events, calls }) {
	return {
		resolve(name) {
			if (name === 'db') return db;
			if (name === 'events') {
				return {
					emit: async (evt, payload) => {
						events.push({ name: evt, payload });
					}
				};
			}
			if (name in fixtures) return fixtures[name];
			return async (...args) => {
				calls.push({ name, args });
			};
		}
	};
}

const looseEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Run every Action example in the app's specs.
 *
 * @param {string} [dir] specs directory, defaults to `<cwd>/specs`
 * @param {{ out?: string, fixtures?: Record<string, *>, user?: * }} [opts]
 * @returns {Promise<{ version: string, pass: number, fail: number, cases: * }>}
 */
export async function traceApp(dir, opts = {}) {
	const specs = loadSpecs(dir);
	const appRoot = dirname(specs.dir);
	const genRoot = opts.out ?? join(appRoot, '.norns', 'generated');
	generateApp(dir, { out: opts.out });

	const scratch = join(appRoot, '.norns', 'cache', 'trace', `${specs.version.slice(0, 8)}-${Date.now()}`);
	const user = opts.user ?? TRACE_USER;
	const cases = [];

	try {
		buildScratch(genRoot, scratch, appRoot);
		const tables = await loadTables(scratch, specs);
		const ddl = await tableDDL(Object.values(tables));
		const { betterSqlite } = await import('../server/db.js');
		const { sql, eq } = await import('drizzle-orm');

		for (const [moduleName, moduleSpec] of Object.entries(specs.modules)) {
			const actionsFile = join(scratch, 'lib', moduleName, 'actions.js');
			const actionNames = Object.entries(moduleSpec.actions ?? {})
				.filter(([, a]) => (a.examples ?? []).length > 0)
				.map(([n]) => n)
				.sort();
			if (actionNames.length === 0 || !existsSync(actionsFile)) continue;
			const mod = await import(pathToFileURL(actionsFile).href);

			for (const name of actionNames) {
				const actionSpec = moduleSpec.actions[name];
				const address = `${moduleName}.Action.${name}`;
				const target = actionEntity(moduleName, actionSpec, specs);

				for (const [index, example] of (actionSpec.examples ?? []).entries()) {
					const events = [];
					const calls = [];
					const record = { address, index, input: example.input ?? {}, expect: example.expect ?? {}, events, calls };
					cases.push(record);
					try {
						const db = await betterSqlite(':memory:');
						for (const stmt of ddl) await db.run(sql.raw(stmt));

						// seed every `$handle` input value into its entity table
						let seededId = null;
						for (const [key, value] of Object.entries(example.input ?? {})) {
							if (typeof value !== 'string' || !value.startsWith('$')) continue;
							const ref = actionSpec.input?.[key];
							const entity = typeof ref === 'string' ? ref.replace(/\?$/, '').split('.')[0] : target?.entity;
							const entityModule = target && target.entity === entity ? target.module : moduleName;
							const table = tables[`${entityModule}.${entity}`];
							const entitySpec = specs.modules[entityModule]?.entities?.[entity];
							if (!table || !entitySpec) continue;
							await db.insert(table).values(seedRow(value, entitySpec));
							if (ref?.endsWith('.id')) seededId = { table, value };
						}

						const container = recordingContainer(db, { fixtures: opts.fixtures, events, calls });
						record.result = await mod[name].run({ input: example.input ?? {}, container, user });

						if (seededId && target) {
							record.row = (
								await db.select().from(seededId.table).where(eq(seededId.table.id, seededId.value)).limit(1)
							)[0];
						}

						record.pass = Object.entries(record.expect).every(
							([k, want]) => looseEq(record.row?.[k], want) || looseEq(record.result?.[k], want)
						);
					} catch (e) {
						record.pass = false;
						record.error = e?.body?.message ?? e?.message ?? String(e);
						record.status = e?.status;
					}
				}
			}
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}

	const pass = cases.filter((c) => c.pass).length;
	return { version: specs.version, pass, fail: cases.length - pass, cases };
}
