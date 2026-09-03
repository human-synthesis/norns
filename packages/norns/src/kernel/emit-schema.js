/**
 * Entity emitter (K-10): every entity in a module becomes a Drizzle table,
 * a valibot schema, and (if it has one) a status-machine map, emitted as
 * Civet into `lib/<module>/schema.c`. Dialect comes from `specs/app.t`:
 * sqlite/d1 emit sqliteTable, postgres emits pgTable (K-16).
 *
 * Conventions:
 *   - implicit `id` text primary key on every entity
 *   - `money` is integer cents; `date`/`datetime` are timestamp integers
 *   - `optional: true` → nullable column + v.optional in the schema
 *   - the initial status state is the one no transition targets; output is
 *     sorted, so emission is independent of spec key order
 *   - `<Entity>Input` = schema minus `id` (for action/form input)
 */

const SQLITE_COLUMNS = {
	text: (col) => `text('${col}')`,
	email: (col) => `text('${col}')`,
	url: (col) => `text('${col}')`,
	file: (col) => `text('${col}')`,
	ref: (col) => `text('${col}')`,
	int: (col) => `integer('${col}')`,
	money: (col) => `integer('${col}')`,
	number: (col) => `real('${col}')`,
	bool: (col) => `integer('${col}', { mode: 'boolean' })`,
	date: (col) => `integer('${col}', { mode: 'timestamp' })`,
	datetime: (col) => `integer('${col}', { mode: 'timestamp' })`,
	json: (col) => `text('${col}', { mode: 'json' })`
};

const SQLITE_IMPORT = {
	text: 'text',
	email: 'text',
	url: 'text',
	file: 'text',
	ref: 'text',
	int: 'integer',
	money: 'integer',
	number: 'real',
	bool: 'integer',
	date: 'integer',
	datetime: 'integer',
	json: 'text'
};

const PG_COLUMNS = {
	text: (col) => `text('${col}')`,
	email: (col) => `text('${col}')`,
	url: (col) => `text('${col}')`,
	file: (col) => `text('${col}')`,
	ref: (col) => `text('${col}')`,
	int: (col) => `integer('${col}')`,
	money: (col) => `integer('${col}')`,
	number: (col) => `doublePrecision('${col}')`,
	bool: (col) => `boolean('${col}')`,
	// mode 'date' matches the sqlite timestamp columns, so runtime code sees
	// Date objects under either dialect
	date: (col) => `timestamp('${col}', { mode: 'date' })`,
	datetime: (col) => `timestamp('${col}', { mode: 'date' })`,
	json: (col) => `jsonb('${col}')`
};

const PG_IMPORT = {
	text: 'text',
	email: 'text',
	url: 'text',
	file: 'text',
	ref: 'text',
	int: 'integer',
	money: 'integer',
	number: 'doublePrecision',
	bool: 'boolean',
	date: 'timestamp',
	datetime: 'timestamp',
	json: 'jsonb'
};

const DIALECT_TABLES = {
	d1: { table: 'sqliteTable', from: 'drizzle-orm/sqlite-core', columns: SQLITE_COLUMNS, imports: SQLITE_IMPORT },
	sqlite: { table: 'sqliteTable', from: 'drizzle-orm/sqlite-core', columns: SQLITE_COLUMNS, imports: SQLITE_IMPORT },
	postgres: { table: 'pgTable', from: 'drizzle-orm/pg-core', columns: PG_COLUMNS, imports: PG_IMPORT }
};

export const VALIBOT = {
	text: 'v.string()',
	file: 'v.string()',
	ref: 'v.string()',
	email: 'v.pipe(v.string(), v.email())',
	url: 'v.pipe(v.string(), v.url())',
	int: 'v.pipe(v.number(), v.integer())',
	money: 'v.pipe(v.number(), v.integer())',
	number: 'v.number()',
	bool: 'v.boolean()',
	date: 'v.pipe(v.string(), v.isoDate())',
	// K-52: a native <input type="datetime-local"> submits local time with NO
	// timezone suffix (2026-09-04T09:00[:00]) — by spec it cannot send one, so
	// isoTimestamp alone made every browser-submitted datetime invalid. Accept
	// local forms and full instants alike; K-51 coerces through new Date().
	datetime:
		"v.pipe(v.string(), v.regex(/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:?\\d{2})?$/, 'expected an ISO datetime, e.g. 2026-09-04T09:00 (seconds/offset optional)'))",
	json: 'v.unknown()'
};

const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export const normalizeField = (f) => (typeof f === 'string' ? { type: f } : f);

// D30: unbounded text is a DoS/abuse vector — text/file inputs get a default
// cap unless the field declares its own `max`. Everything else keeps VALIBOT.
export const DEFAULT_TEXT_MAX = 10_000;

export function valibotFor(def0) {
	const def = normalizeField(def0);
	if (def.type === 'text' || def.type === 'file') {
		return `v.pipe(v.string(), v.maxLength(${def.max ?? DEFAULT_TEXT_MAX}))`;
	}
	return VALIBOT[def.type];
}

/**
 * The entity's declared `initial` state, else the one state no transition
 * targets. A machine where neither identifies a single state (cyclic, or
 * several untargeted states) has no derivable answer — refine reports
 * INITIAL_AMBIGUOUS before generation, and this throws as a backstop:
 * an alphabetical default is never meaningfully correct.
 */
export function initialState(status, initial) {
	if (initial !== undefined) {
		if (!(initial in status)) throw new Error(`initial state "${initial}" is not a declared status state`);
		return initial;
	}
	const states = Object.keys(status).sort();
	const targeted = new Set(Object.values(status).flat());
	const sources = states.filter((s) => !targeted.has(s));
	if (sources.length !== 1) {
		throw new Error(
			`INITIAL_AMBIGUOUS: no single untargeted status state (${states.join(', ')}) — declare \`initial\` on the entity`
		);
	}
	return sources[0];
}

/**
 * Emit `lib/<module>/schema.c` for one module, or null when it has no
 * entities.
 *
 * @param {string} moduleName
 * @param {*} moduleSpec
 * @returns {{ path: string, text: string } | null}
 */
export function emitModuleSchema(moduleName, moduleSpec, dialect = 'd1') {
	const entities = Object.entries(moduleSpec?.entities ?? {});
	if (entities.length === 0) return null;
	const { table, from, columns: COLUMNS, imports: IMPORTS } = DIALECT_TABLES[dialect] ?? DIALECT_TABLES.d1;

	const columnFns = new Set(['text']); // id column is always text
	const blocks = [];

	for (const [name, entity] of entities.sort(([a], [b]) => (a < b ? -1 : 1))) {
		const fields = Object.entries(entity.fields ?? {})
			.map(([f, def]) => [f, normalizeField(def)])
			.sort(([a], [b]) => (a < b ? -1 : 1));
		const states = Object.keys(entity.status ?? {}).sort();

		const columns = [`\tid: text('id').primaryKey()`];
		for (const [fieldName, def] of fields) {
			columnFns.add(IMPORTS[def.type]);
			let col = `\t${fieldName}: ${COLUMNS[def.type](snake(fieldName))}`;
			if (!def.optional) col += '.notNull()';
			if (def.unique) col += '.unique()';
			if (def.default !== undefined) col += `.default(${JSON.stringify(def.default)})`;
			columns.push(col);
		}
		if (states.length > 0) {
			columns.push(
				`\tstatus: text('status').notNull().default(${JSON.stringify(initialState(entity.status, entity.initial))})`
			);
		}

		const schemaFields = [`\tid: v.string()`];
		for (const [fieldName, def] of fields) {
			const base = valibotFor(def);
			schemaFields.push(`\t${fieldName}: ${def.optional ? `v.optional(${base})` : base}`);
		}
		if (states.length > 0) {
			schemaFields.push(`\tstatus: v.picklist(${JSON.stringify(states)})`);
		}

		const lines = [
			`export ${name} := ${table}('${snake(moduleName)}_${snake(name)}', {`,
			columns.join(',\n'),
			`})`,
			``
		];
		if (states.length > 0) {
			const rows = states.map(
				(s) => `\t${s}: [${entity.status[s].map((t) => JSON.stringify(t)).join(', ')}]`
			);
			lines.push(`export ${name}Status := {`, rows.join(',\n'), `}`, ``);
		}
		lines.push(
			`export ${name}Schema := v.strictObject({`,
			schemaFields.join(',\n'),
			`})`,
			``,
			`export ${name}Input := v.omit(${name}Schema, ['id'])`
		);
		blocks.push(lines.join('\n'));
	}

	const imports = [...columnFns].sort().join(', ');
	const text = [
		`// GENERATED by \`norns generate\` from specs/${moduleName}.t — do not edit.`,
		`import { ${table}, ${imports} } from '${from}'`,
		`import * as v from 'valibot'`,
		``,
		blocks.join('\n\n'),
		``
	].join('\n');

	return { path: `lib/${moduleName}/schema.c`, text };
}

/** @type {{ name: string, emit: (ctx: *) => { path: string, text: string }[] }} */
export const schemaEmitter = {
	name: 'schema',
	emit({ moduleName, moduleSpec, specs }) {
		const file = emitModuleSchema(moduleName, moduleSpec, specs?.app?.dialect ?? 'd1');
		return file ? [file] : [];
	}
};
