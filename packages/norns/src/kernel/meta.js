/**
 * Valibot meta-schemas — one per resource kind. These make invalid specs
 * unrepresentable at the shape level: unknown keys are rejected
 * (strictObject), expressions must parse, references must look like
 * addresses. Cross-unit refinements (refs resolve, depends DAG, closed
 * status machines) live in refine.js (K-06), not here.
 */

import * as v from 'valibot';

import { isAddress } from './address.js';
import { isExpr } from './expr.js';

export const FIELD_TYPES = [
	'text',
	'number',
	'int',
	'money',
	'bool',
	'date',
	'datetime',
	'email',
	'url',
	'json',
	'file',
	'ref'
];

export const DIALECTS = ['d1', 'sqlite', 'postgres'];

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ident = v.pipe(v.string(), v.regex(IDENT_RE, 'must be an identifier'));
const uid = v.optional(
	v.pipe(v.string(), v.regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a 26-char ULID'))
);
const expr = v.pipe(
	v.string(),
	v.check(isExpr, 'must be a valid expression (see the CEL-subset grammar)')
);
const address = v.pipe(
	v.string(),
	v.check(isAddress, 'must be a unit address (module.Kind.name)')
);
/** Full address or a bare/dotted local name like `Order` or `Order.id`. */
const unitRef = v.pipe(
	v.string(),
	v.check(
		(s) => isAddress(s) || s.split('.').every((seg) => IDENT_RE.test(seg)),
		'must be a unit reference'
	)
);

const fieldObject = v.pipe(
	v.strictObject({
		type: v.picklist(FIELD_TYPES),
		ref: v.optional(unitRef),
		optional: v.optional(v.boolean()),
		unique: v.optional(v.boolean()),
		default: v.optional(v.unknown())
	}),
	v.check((f) => (f.type === 'ref') === (f.ref !== undefined), 'ref fields need `ref`, others must not have it')
);
const field = v.union([v.picklist(FIELD_TYPES), fieldObject]);

const example = v.strictObject({
	input: v.optional(v.unknown()),
	expect: v.optional(v.unknown())
});

const requiresExamplesWhenCustom = (unit) =>
	unit.impl !== 'custom' || (Array.isArray(unit.examples) && unit.examples.length > 0);
const CUSTOM_NEEDS_EXAMPLES = '`impl: custom` requires at least one example';

const Entity = v.strictObject({
	uid,
	owner: v.optional(ident),
	fields: v.record(ident, field),
	status: v.optional(v.record(ident, v.array(ident)))
});

const Query = v.strictObject({
	uid,
	from: unitRef,
	live: v.optional(v.boolean()),
	groupBy: v.optional(v.string()),
	filter: v.optional(expr),
	sort: v.optional(v.union([v.string(), v.array(v.string())])),
	limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)))
});

const Action = v.pipe(
	v.strictObject({
		uid,
		input: v.optional(v.record(ident, v.union([v.string(), v.record(v.string(), v.unknown())]))),
		requires: v.optional(expr),
		steps: v.optional(v.array(v.record(v.string(), v.unknown()))),
		emits: v.optional(v.array(v.string())),
		refresh: v.optional(v.array(address)),
		examples: v.optional(v.array(example)),
		impl: v.optional(v.picklist(['generated', 'custom'])),
		transport: v.optional(v.picklist(['form', 'remote']))
	}),
	v.check(requiresExamplesWhenCustom, CUSTOM_NEEDS_EXAMPLES)
);

const Policy = v.strictObject({
	uid,
	roles: v.optional(v.array(ident)),
	read: v.optional(expr),
	write: v.optional(expr),
	run: v.optional(v.record(ident, expr))
});

const Page = v.pipe(
	v.strictObject({
		uid,
		route: v.pipe(v.string(), v.regex(/^\//, 'route must start with "/"')),
		params: v.optional(v.record(ident, v.string())),
		layout: v.optional(v.string()),
		state: v.optional(v.record(ident, v.string())),
		components: v.optional(v.array(v.record(v.string(), v.unknown()))),
		slots: v.optional(v.array(ident)),
		examples: v.optional(v.array(example)),
		impl: v.optional(v.picklist(['generated', 'custom']))
	}),
	v.check(requiresExamplesWhenCustom, CUSTOM_NEEDS_EXAMPLES)
);

const Trigger = v.union([
	address,
	v.strictObject({
		uid,
		action: address,
		schedule: v.optional(v.string()),
		source: v.optional(v.string())
	})
]);

const Function = v.strictObject({
	uid,
	input: v.optional(v.record(ident, v.union([v.string(), v.record(v.string(), v.unknown())]))),
	output: v.optional(v.unknown()),
	examples: v.pipe(v.array(example), v.minLength(1, 'functions require at least one example'))
});

const Component = v.strictObject({
	uid,
	props: v.optional(v.record(ident, v.unknown())),
	events: v.optional(v.record(ident, address)),
	slots: v.optional(v.array(ident))
});

// L3 kinds: whole Civet files with declared auth + capabilities.
// `validate` refuses them without an auth declaration (PLAN §6).
const level3 = (extra = {}) =>
	v.strictObject({
		uid,
		source: v.string(),
		auth: v.union([v.string(), v.record(v.string(), v.unknown())]),
		capabilities: v.optional(v.array(v.string())),
		...extra
	});

const Plugin = v.strictObject({
	uid,
	kind: v.picklist(['field', 'step', 'component', 'trigger']),
	source: v.string(),
	contract: v.optional(v.record(v.string(), v.unknown()))
});

/** Kind → valibot schema for one unit's spec value. */
export const UNIT_SCHEMAS = {
	Entity,
	Query,
	Action,
	Policy,
	Page,
	Trigger,
	Function,
	Component,
	Route: level3(),
	Worker: level3({ room: v.optional(v.boolean()) }),
	Adapter: level3(),
	Middleware: level3(),
	Plugin
};

const collection = v.optional(v.record(v.string(), v.unknown()));

/** Module spec shape — collection contents are validated per unit. */
export const MODULE_SCHEMA = v.strictObject({
	module: ident,
	depends: v.optional(v.array(ident)),
	settings: v.optional(v.record(v.string(), v.unknown())),
	entities: collection,
	queries: collection,
	actions: collection,
	policies: collection,
	pages: collection,
	triggers: collection,
	functions: collection,
	components: collection,
	routes: collection,
	workers: collection,
	adapters: collection,
	middleware: collection,
	plugins: collection
});

export const APP_SCHEMA = v.strictObject({
	name: v.optional(v.string()),
	modules: v.optional(v.array(ident)),
	dialect: v.optional(v.picklist(DIALECTS)),
	settings: v.optional(v.record(v.string(), v.unknown()))
});

/**
 * Run a valibot schema and convert its issues to kernel Issues.
 *
 * @param {*} schema
 * @param {*} value
 * @param {string} addr issue address (unit address or module name)
 * @returns {{ level: 'error', address: string, message: string }[]}
 */
export function schemaIssues(schema, value, addr) {
	const result = v.safeParse(schema, value);
	if (result.success) return [];
	return result.issues.map((issue) => {
		const path = v.getDotPath(issue);
		return {
			level: 'error',
			address: addr,
			message: path ? `${path}: ${issue.message}` : issue.message
		};
	});
}
