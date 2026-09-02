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
import { isAddress, parseAddress } from './address.js';
import { shapeIssues } from '../server/service.js';
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
			const target = ensureCustom(spec.slice('$custom/'.length), { scratch, appRoot, compileCivet });
			return `${from}${q}${pathToFileURL(target).href}${q}`;
		}
		return `${from}${q}${resolveBare(spec)}${q}`;
	});
}

/** Compile a custom body `src/<rel>` into the scratch tree; missing bodies throw when invoked. */
function ensureCustom(rel, { scratch, appRoot, compileCivet }) {
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
	return target;
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

function recordingContainer(db, { fixtures = {}, auto = {}, events, calls }) {
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
			if (name === 'jobs') {
				return {
					enqueue: async (address, input) => {
						calls.push({ name: 'jobs.enqueue', args: [address, input] });
					}
				};
			}
			if (name in fixtures) return fixtures[name];
			if (name in auto) {
				return async (...args) => {
					calls.push({ name, args });
					return auto[name];
				};
			}
			return async (...args) => {
				calls.push({ name, args });
			};
		},
		// `has` makes serviceClient's op-level fixture hook fire for every
		// declared service operation — traced flows never touch the network.
		has: (name) => name in fixtures || name in auto
	};
}

/** Service op address → response fabricated from the op's declared output shape. */
function serviceAutoFixtures(specs) {
	const auto = {};
	for (const [moduleName, moduleSpec] of Object.entries(specs.modules)) {
		for (const [serviceName, svc] of Object.entries(moduleSpec.services ?? {})) {
			for (const [opName, op] of Object.entries(svc.operations ?? {})) {
				const out = {};
				for (const [key, t] of Object.entries(op.output && typeof op.output === 'object' ? op.output : {})) {
					const type = (typeof t === 'string' ? t : (t?.type ?? 'json')).replace(/\?$/, '');
					out[key] = SEED_VALUES[type] ?? 'trace';
				}
				auto[`${moduleName}.Service.${serviceName}.${opName}`] = out;
			}
		}
	}
	return auto;
}

const looseEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const subsetEq = (row, want) =>
	row !== undefined && Object.entries(want ?? {}).every(([k, v2]) => looseEq(row[k], v2));

/** K-29: synthesize the principal an example runs as. Seeded rows are owned
 * by the trace user, so any other principal exercises the ownership guard. */
function principalFor(as) {
	if (as === undefined || as === 'owner') return TRACE_USER;
	if (as === 'anonymous') return null;
	if (as.startsWith('role:')) return { id: 'other-user', roles: [as.slice(5)] };
	return { id: 'other-user', roles: [] };
}

const DERIVED_CAP = 10;

/**
 * K-28: derived status cases — for an action whose generated steps set a
 * literal `status` on a machined entity, every state WITHOUT a declared
 * edge to that target is a refusal case: seed `$state`, run, and the
 * action must throw (requires guard or the runtime 409 — either refusal
 * counts; the write landing is the failure). Runs against the generated
 * shells, never a re-interpretation, so sandbox and runtime cannot drift.
 */
function derivedStatusCases(moduleName, actionSpec, specs) {
	if (actionSpec.impl === 'custom') return [];
	const target = actionEntity(moduleName, actionSpec, specs);
	const entitySpec = target && specs.modules[target.module]?.entities?.[target.entity];
	const machine = entitySpec?.status;
	if (!machine) return [];
	const setStep = (actionSpec.steps ?? []).find((s) => typeof s.set?.status === 'string');
	if (!setStep) return [];
	const to = setStep.set.status;
	const idKey = idInputKey(actionSpec);
	if (!idKey) return [];
	const edgesOf = (from) => (Array.isArray(machine[from]) ? machine[from] : Object.keys(machine[from] ?? {}));
	return Object.keys(machine)
		.filter((from) => !edgesOf(from).includes(to))
		.slice(0, DERIVED_CAP)
		.map((from) => ({ input: { [idKey]: `$${from}` }, derived: `illegal-transition ${from} -> ${to}` }));
}

const idInputKey = (actionSpec) =>
	Object.entries(actionSpec.input ?? {}).find(
		([, ref]) => typeof ref === 'string' && ref.replace(/\?$/, '').endsWith('.id')
	)?.[0];

/**
 * K-34/D33: derived permission matrix — for an ownership-guarded action,
 * a non-owner and an anonymous caller addressing someone else's row (the
 * IDOR shape) must both be refused by the generated shell. Derived only
 * when the write policy is ownership-based, so a deliberately open policy
 * never yields false alarms.
 */
function derivedPermissionCases(moduleName, actionSpec, specs) {
	if (actionSpec.impl === 'custom') return [];
	const target = actionEntity(moduleName, actionSpec, specs);
	const write = target && specs.modules[target.module]?.policies?.[target.entity]?.write;
	if (typeof write !== 'string' || !write.includes('owner') || write.includes('any')) return [];
	const idKey = idInputKey(actionSpec);
	if (!idKey) {
		// K-39/D44: a create action derives its denied-create case — an anonymous
		// caller must be refused by the candidate-row write check.
		const createStep = (actionSpec.steps ?? []).find((s) => s?.create);
		if (!createStep) return [];
		return [
			{
				as: 'anonymous',
				input: actionSpec.examples?.[0]?.input ?? {},
				expect: 'denied',
				derived: 'permission: anonymous create refused'
			}
		];
	}
	const handle = actionSpec.examples?.[0]?.input?.[idKey] ?? '$seed';
	if (typeof handle !== 'string' || !handle.startsWith('$')) return [];
	return [
		{ as: 'other', input: { [idKey]: handle }, expect: 'denied', derived: 'permission: non-owner refused' },
		{ as: 'anonymous', input: { [idKey]: handle }, expect: 'denied', derived: 'permission: anonymous refused' }
	];
}

function matchCalls(calls, want) {
	return (Array.isArray(want) ? want : []).every((w) => {
		const name = typeof w === 'string' ? w : w?.name;
		return (calls ?? []).some(
			(c) => c.name === name && (typeof w === 'string' || w.with === undefined || looseEq(c.args[0], w.with))
		);
	});
}

/**
 * `expect` semantics shared by every traced kind: plain keys check the
 * entity row then the return value; `calls` checks recorded external
 * calls (by name, optionally `with` args); `frames` the collected SSE
 * frames; `state`/`broadcasts` the Room script outcome.
 */
function checkExpect(record) {
	record.pass = Object.entries(record.expect).every(([key, want]) => {
		if (key === 'calls') return matchCalls(record.calls, want);
		if (key === 'frames') return looseEq(record.frames, want);
		if (record.rows !== undefined) {
			if (key === 'count') return record.rows.length === want;
			if (key === 'first') return subsetEq(record.rows[0], want);
			if (key === 'rows') return looseEq(record.rows, want);
		}
		if (key === 'state') {
			return Object.entries(want ?? {}).every(([field, v2]) => looseEq(record.state?.[field], v2));
		}
		if (key === 'broadcasts') {
			return (Array.isArray(want) ? want : []).every((n) => (record.broadcasts ?? []).some((b) => b?.type === n));
		}
		return looseEq(record.row?.[key], want) || looseEq(record.result?.[key], want);
	});
}

/**
 * Run every example in the app's specs: Actions against the sandbox DB,
 * plus L3 units (K-25) — Jobs and custom Functions/Endpoints run with the
 * same recording container (Service calls auto-fixtured from their output
 * schemas), Room workers run their script examples headless.
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
		const { compile } = require('@danielx/civet');
		const ctxc = { scratch, appRoot, compileCivet: (src) => compile(src, { sync: true, js: true }) };
		const auto = serviceAutoFixtures(specs);

		const runL3 = async (address, index, example, invoke) => {
			const events = [];
			const calls = [];
			const record = { address, index, input: example.input ?? {}, expect: example.expect ?? {}, events, calls };
			try {
				const db = await betterSqlite(':memory:');
				for (const stmt of ddl) await db.run(sql.raw(stmt));
				const container = recordingContainer(db, { fixtures: opts.fixtures, auto, events, calls });
				record.result = await invoke({ input: record.input, container, user, event: null });
				checkExpect(record);
			} catch (e) {
				record.pass = false;
				record.error = e?.body?.message ?? e?.message ?? String(e);
				record.status = e?.status;
			}
			return record;
		};

		for (const [moduleName, moduleSpec] of Object.entries(specs.modules)) {
			const actionsFile = join(scratch, 'lib', moduleName, 'actions.js');
			const actionNames = Object.entries(moduleSpec.actions ?? {})
				.filter(([, a]) => (a.examples ?? []).length > 0)
				.map(([n]) => n)
				.sort();
			const mod =
				actionNames.length > 0 && existsSync(actionsFile) ? await import(pathToFileURL(actionsFile).href) : null;

			for (const name of mod ? actionNames : []) {
				const actionSpec = moduleSpec.actions[name];
				const address = `${moduleName}.Action.${name}`;
				const target = actionEntity(moduleName, actionSpec, specs);

				const authored = actionSpec.examples ?? [];
				const derived =
					opts.derived === false
						? []
						: [
								...derivedStatusCases(moduleName, actionSpec, specs),
								...derivedPermissionCases(moduleName, actionSpec, specs)
							];
				for (const [index, example] of [...authored, ...derived].entries()) {
					const events = [];
					const calls = [];
					const expectDenied = example.expect === 'denied';
					const refusalCase = expectDenied || example.derived !== undefined;
					const record = {
						address,
						index,
						input: example.input ?? {},
						expect: refusalCase ? {} : (example.expect ?? {}),
						events,
						calls,
						...(example.derived !== undefined ? { src: 'derived', derived: example.derived } : {}),
						...(example.as !== undefined ? { as: example.as } : {})
					};
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

						const container = recordingContainer(db, { fixtures: opts.fixtures, auto, events, calls });
						record.result = await mod[name].run({
							input: example.input ?? {},
							container,
							user: example.as !== undefined ? principalFor(example.as) : user
						});

						if (refusalCase) {
							// the run was supposed to be refused — succeeding is the bug
							record.pass = false;
							record.error = expectDenied
								? `expected denial for as: ${example.as ?? 'owner'}, but the action succeeded`
								: `${record.derived} was allowed — the machine/requires guard did not refuse it`;
							continue;
						}

						if (seededId && target) {
							record.row = (
								await db.select().from(seededId.table).where(eq(seededId.table.id, seededId.value)).limit(1)
							)[0];
						} else if (target && typeof record.result?.id === 'string') {
							// K-39: create actions return the new id — read the row back so
							// plain expect keys assert what actually landed.
							const table = tables[`${target.module}.${target.entity}`];
							if (table) {
								record.row = (
									await db.select().from(table).where(eq(table.id, record.result.id)).limit(1)
								)[0];
							}
						}

						checkExpect(record);
					} catch (e) {
						if (refusalCase) {
							record.pass = true;
							record.status = e?.status;
							continue;
						}
						record.pass = false;
						record.error = e?.body?.message ?? e?.message ?? String(e);
						record.status = e?.status;
					}
				}
			}

			// Queries (K-30) — `given` rows seed the sandbox store, expects speak rows
			const queriesFile = join(scratch, 'lib', moduleName, 'queries.js');
			const queryNames = Object.entries(moduleSpec.queries ?? {})
				.filter(([, q]) => (q.examples ?? []).length > 0)
				.map(([n]) => n)
				.sort();
			if (queryNames.length > 0 && existsSync(queriesFile)) {
				const qMod = await import(pathToFileURL(queriesFile).href);
				for (const name of queryNames) {
					const q = moduleSpec.queries[name];
					const from = isAddress(q.from)
						? { module: parseAddress(q.from).module, entity: parseAddress(q.from).name }
						: { module: moduleName, entity: q.from };
					for (const [index, example] of q.examples.entries()) {
						const record = {
							address: `${moduleName}.Query.${name}`,
							index,
							expect: example.expect ?? {},
							...(example.as !== undefined ? { as: example.as } : {})
						};
						cases.push(record);
						try {
							const db = await betterSqlite(':memory:');
							for (const stmt of ddl) await db.run(sql.raw(stmt));
							for (const [entName, rows] of Object.entries(example.given ?? {})) {
								const entModule = specs.modules[moduleName]?.entities?.[entName] ? moduleName : from.module;
								const table = tables[`${entModule}.${entName}`];
								const entitySpec = specs.modules[entModule]?.entities?.[entName];
								if (!table || !entitySpec) throw new Error(`given: no entity "${entName}" to seed`);
								for (const [i, row] of rows.entries()) {
									await db.insert(table).values({ ...seedRow(row.id ?? `given-${i}`, entitySpec), ...row });
								}
							}
							const container = recordingContainer(db, { fixtures: opts.fixtures, auto, events: [], calls: [] });
							record.rows = await qMod[name]({
								container,
								user: example.as !== undefined ? principalFor(example.as) : user
							});
							checkExpect(record);
						} catch (e) {
							record.pass = false;
							record.error = e?.body?.message ?? e?.message ?? String(e);
						}
					}
				}
			}

			// Jobs — run the generated (or custom) `run` inline (K-25)
			const jobsFile = join(scratch, 'lib', moduleName, 'jobs.js');
			const jobNames = Object.entries(moduleSpec.jobs ?? {})
				.filter(([, j]) => (j.examples ?? []).length > 0)
				.map(([n]) => n)
				.sort();
			if (jobNames.length > 0 && existsSync(jobsFile)) {
				const jobsMod = await import(pathToFileURL(jobsFile).href);
				for (const name of jobNames) {
					for (const [index, example] of moduleSpec.jobs[name].examples.entries()) {
						cases.push(
							await runL3(`${moduleName}.Job.${name}`, index, example, (ctx) => jobsMod[name].run(ctx))
						);
					}
				}
			}

			// Functions — custom bodies with contract examples
			for (const name of Object.keys(moduleSpec.functions ?? {}).sort()) {
				const fnSpec = moduleSpec.functions[name];
				if ((fnSpec.examples ?? []).length === 0) continue;
				const target = ensureCustom(`${moduleName}/functions/${name}.c`, ctxc);
				const body = (await import(pathToFileURL(target).href)).default;
				for (const [index, example] of fnSpec.examples.entries()) {
					cases.push(await runL3(`${moduleName}.Function.${name}`, index, example, (ctx) => body(ctx)));
				}
			}

			// Endpoints — body-level trace with the declared IO contract enforced
			for (const name of Object.keys(moduleSpec.endpoints ?? {}).sort()) {
				const ep = moduleSpec.endpoints[name];
				if ((ep.examples ?? []).length === 0) continue;
				const target = ensureCustom(`${moduleName}/endpoints/${name}.c`, ctxc);
				const body = (await import(pathToFileURL(target).href)).default;
				for (const [index, example] of ep.examples.entries()) {
					const record = await runL3(`${moduleName}.Endpoint.${name}`, index, example, async (ctx) => {
						let result = body(ctx);
						if (ep.stream) {
							if (!result?.[Symbol.asyncIterator]) result = await result;
							const frames = [];
							for await (const frame of result) {
								const issues = shapeIssues(ep.stream.frame ?? {}, frame, 'frame');
								if (issues.length > 0) throw new Error(issues.join('; '));
								frames.push(frame);
							}
							return frames;
						}
						result = await result;
						if (ep.output) {
							const issues = shapeIssues(ep.output, result, 'output');
							if (issues.length > 0) throw new Error(`output contract: ${issues.join('; ')}`);
						}
						return result;
					});
					if (ep.stream && Array.isArray(record.result)) {
						record.frames = record.result;
						checkExpect(record);
					}
					cases.push(record);
				}
			}

			// Room workers — script examples driven headless against the class
			for (const name of Object.keys(moduleSpec.workers ?? {}).sort()) {
				const w = moduleSpec.workers[name];
				if (w?.room !== true || (w.examples ?? []).length === 0) continue;
				const rel = w.source.startsWith('src/') ? w.source.slice(4) : w.source;
				const target = ensureCustom(rel, ctxc);
				const RoomClass = (await import(pathToFileURL(target).href)).default;
				for (const [index, example] of w.examples.entries()) {
					const record = {
						address: `${moduleName}.Worker.${name}`,
						index,
						script: example.script ?? [],
						expect: example.expect ?? {},
						broadcasts: []
					};
					cases.push(record);
					try {
						const instance = new RoomClass({}, {});
						instance.tickMs = 0;
						instance.broadcast = (message) => {
							record.broadcasts.push(typeof message === 'string' ? JSON.parse(message) : message);
							return 0;
						};
						for (const step of example.script ?? []) {
							await instance.onMessage(JSON.stringify({ type: step.send, ...(step.with ?? {}) }), null);
						}
						record.state = Object.fromEntries(Object.keys(w.state ?? {}).map((f) => [f, instance[f]]));
						checkExpect(record);
					} catch (e) {
						record.pass = false;
						record.error = e?.message ?? String(e);
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
