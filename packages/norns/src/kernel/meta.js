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
		default: v.optional(v.unknown()),
		// D30/D31: explicit bound (text/file get a generated default cap when
		// omitted), upload MIME allowlist, and the sensitive-data contract.
		max: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
		mime: v.optional(v.array(v.string())),
		sensitive: v.optional(v.boolean())
	}),
	v.check((f) => (f.type === 'ref') === (f.ref !== undefined), 'ref fields need `ref`, others must not have it')
);
// A failed union only answers "Expected (…) | Object" — no signal about
// which key or value is wrong (a field session burned 5 probes on the ref
// shape). Dispatch on the runtime shape instead so object fields surface
// fieldObject's own issues, which name the offending key.
const field = v.pipe(
	v.union([v.string(), v.record(v.string(), v.unknown())]),
	v.rawTransform(({ dataset, addIssue, NEVER }) => {
		const schema = typeof dataset.value === 'string' ? v.picklist(FIELD_TYPES) : fieldObject;
		const result = v.safeParse(schema, dataset.value);
		if (result.success) return result.output;
		for (const issue of result.issues) {
			const path = v.getDotPath(issue);
			addIssue({ message: path ? `${path}: ${issue.message}` : issue.message });
		}
		return NEVER;
	})
);

// `as` (K-29): the principal a case runs under — omitted/'owner' = the trace
// user, 'anonymous' = no user, 'role:<name>' = a non-owner with that role,
// anything else = a plain non-owner. `expect: "denied"` asserts refusal.
const example = v.strictObject({
	input: v.optional(v.unknown()),
	as: v.optional(v.string()),
	expect: v.optional(v.unknown())
});

// Query examples (K-30): `given` seeds the sandbox store per entity; expects
// speak rows — count / first (subset of the first row) / rows (exact).
const queryExample = v.strictObject({
	given: v.optional(v.record(ident, v.array(v.record(v.string(), v.unknown())))),
	as: v.optional(v.string()),
	expect: v.optional(v.unknown())
});

const requiresExamplesWhenCustom = (unit) =>
	unit.impl !== 'custom' || (Array.isArray(unit.examples) && unit.examples.length > 0);
const CUSTOM_NEEDS_EXAMPLES = '`impl: custom` requires at least one example';

const Entity = v.strictObject({
	uid,
	owner: v.optional(ident),
	fields: v.record(ident, field),
	status: v.optional(v.record(ident, v.array(ident))),
	// The state new rows start in. Required (by refine) when the machine is
	// cyclic — i.e. no single untargeted state identifies it (v6 K-42).
	initial: v.optional(ident)
});

const Query = v.strictObject({
	uid,
	from: unitRef,
	live: v.optional(v.boolean()),
	groupBy: v.optional(v.string()),
	filter: v.optional(expr),
	sort: v.optional(v.union([v.string(), v.array(v.string())])),
	limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	// D31: sensitive fields are excluded from query output unless revealed here
	reveal: v.optional(v.array(ident)),
	examples: v.optional(v.array(queryExample))
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

// Page render checks (D27/K-31): the a11y vocabulary app.snapshot and the
// smoke matrix share — role/element, text, count (number or ">=N"-style).
const pageCheck = v.pipe(
	v.strictObject({
		role: v.optional(v.string()),
		text: v.optional(v.string()),
		count: v.optional(v.union([v.number(), v.string()]))
	}),
	v.check((c) => c.role !== undefined || c.text !== undefined, 'a page check needs role or text')
);

const Page = v.pipe(
	v.strictObject({
		uid,
		route: v.pipe(v.string(), v.regex(/^\//, 'route must start with "/"')),
		params: v.optional(v.record(ident, v.string())),
		layout: v.optional(v.string()),
		state: v.optional(v.record(ident, v.string())),
		components: v.optional(v.array(v.record(v.string(), v.unknown()))),
		slots: v.optional(v.array(ident)),
		// K-49: a spec-authored page heading, overriding the humanized unit
		// name. The one hook to localize or rename generated page chrome.
		title: v.optional(v.string()),
		expect: v.optional(v.array(pageCheck)),
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

// Snippet (U-07) — a typed render fragment for a palette slot (cell
// renderers, empty states). Declared args are the slot's calling
// convention; the body lives in `src/<m>/snippets/<name>.n` and the page
// emitter wraps it in a `+snippet` forwarding the args as props.
const Snippet = v.strictObject({
	uid,
	args: v.optional(v.array(ident)),
	description: v.optional(v.string())
});

// Service (D15) — an external system as a typed operation manifest.
// `auth.binding` is an env binding *name* (UPPER_SNAKE) the generated client
// reads the credential from at call time.
const bindingName = v.pipe(
	v.string(),
	v.regex(/^[A-Z][A-Z0-9_]*$/, 'must be an UPPER_SNAKE env binding name, never a secret value')
);

const ServiceAuth = v.pipe(
	v.strictObject({
		mode: v.picklist(['none', 'bearer', 'basic', 'hmac', 'header']),
		binding: v.optional(bindingName),
		header: v.optional(v.pipe(v.string(), v.regex(/^[A-Za-z][A-Za-z0-9-]*$/, 'must be a header name')))
	}),
	v.check(
		(a) => (a.mode === 'none' ? a.binding === undefined : a.binding !== undefined),
		"auth modes other than 'none' require a `binding` name; 'none' must not have one"
	),
	v.check((a) => a.mode === 'header' || a.header === undefined, "`header` is only valid with mode 'header'"),
	v.check((a) => a.mode !== 'header' || a.header !== undefined, "auth mode 'header' requires `header`")
);

const ServiceOperation = v.strictObject({
	method: v.optional(v.picklist(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])),
	path: v.optional(v.pipe(v.string(), v.regex(/^\//, 'path must start with "/"'))),
	input: v.optional(v.record(ident, v.union([v.string(), v.record(v.string(), v.unknown())]))),
	output: v.optional(v.unknown())
});

const Service = v.strictObject({
	uid,
	base: v.pipe(v.string(), v.url('base must be an absolute URL')),
	auth: ServiceAuth,
	operations: v.pipe(
		v.record(ident, ServiceOperation),
		v.check((ops) => Object.keys(ops).length > 0, 'services require at least one operation')
	)
});

// Job (D14/K-22) — durable work. Retry policy is required by guardrail:
// a job without declared failure behavior is refused at the shape level.
// Jobs run from `enqueue` steps via the events bus (`job:<address>`
// messages) — Cloudflare Queues in production, inline in dev.
const queueName = v.pipe(
	v.string(),
	v.regex(/^[a-z][a-z0-9-]*$/, 'must be a queue name (lowercase, digits, dashes)')
);

const Job = v.pipe(
	v.strictObject({
		uid,
		input: v.optional(v.record(ident, v.union([v.string(), v.record(v.string(), v.unknown())]))),
		retry: v.strictObject({
			attempts: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20)),
			backoff: v.picklist(['none', 'fixed', 'exponential']),
			baseMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)))
		}),
		dlq: v.optional(queueName),
		concurrency: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
		steps: v.optional(v.array(v.record(v.string(), v.unknown()))),
		emits: v.optional(v.array(v.string())),
		examples: v.optional(v.array(example)),
		impl: v.optional(v.picklist(['generated', 'custom']))
	}),
	v.check(requiresExamplesWhenCustom, CUSTOM_NEEDS_EXAMPLES),
	v.check(
		(j) => j.impl === 'custom' || (Array.isArray(j.steps) && j.steps.length > 0),
		'generated jobs need at least one step (or `impl: custom`)'
	)
);

// Endpoint (D14/K-23) — a Route grown up: declared route/method/auth and
// IO contract in spec, body in `src/<m>/endpoints/<name>.c`. `stream`
// declares an SSE output mode with typed frames (the chat/AI-token path).
// `auth` is required — public endpoints declare `{ mode: 'none' }` explicitly.
const Endpoint = v.pipe(
	v.strictObject({
		uid,
		route: v.pipe(v.string(), v.regex(/^\//, 'route must start with "/"')),
		method: v.optional(v.picklist(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])),
		auth: ServiceAuth,
		input: v.optional(v.record(ident, v.union([v.string(), v.record(v.string(), v.unknown())]))),
		output: v.optional(v.record(ident, v.unknown())),
		stream: v.optional(
			v.strictObject({
				frame: v.pipe(
					v.record(ident, v.unknown()),
					v.check((f) => Object.keys(f).length > 0, 'stream frames need at least one field')
				)
			})
		),
		// D30: public surface declares its own limits — rate + cross-origin policy
		rateLimit: v.optional(
			v.strictObject({
				per: v.picklist(['ip', 'user']),
				rpm: v.pipe(v.number(), v.integer(), v.minValue(1))
			})
		),
		cors: v.optional(v.picklist(['same-origin', 'any'])),
		capabilities: v.optional(v.array(v.string())),
		impl: v.optional(v.literal('custom')),
		examples: v.optional(v.array(example))
	}),
	v.check((e) => !(e.output && e.stream), 'declare either `output` or `stream`, not both'),
	v.check(requiresExamplesWhenCustom, CUSTOM_NEEDS_EXAMPLES)
);

// Room contract (D14) — Workers with `room: true` may declare state and
// message schemas plus script examples: message sequences driven against
// the Room class headless, checked as expected state + broadcasts (K-25).
const roomScriptStep = v.strictObject({
	send: ident,
	with: v.optional(v.record(v.string(), v.unknown()))
});

const roomExample = v.strictObject({
	script: v.pipe(v.array(roomScriptStep), v.minLength(1, 'room examples need at least one script step')),
	expect: v.optional(v.unknown())
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
	Snippet,
	Service,
	Job,
	Endpoint,
	Worker: level3({
		room: v.optional(v.boolean()),
		state: v.optional(v.record(ident, v.string())),
		messages: v.optional(
			v.record(
				ident,
				v.strictObject({
					in: v.optional(v.record(v.string(), v.unknown())),
					out: v.optional(v.record(v.string(), v.unknown()))
				})
			)
		),
		tickMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
		examples: v.optional(v.array(roomExample))
	}),
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
	snippets: collection,
	services: collection,
	jobs: collection,
	endpoints: collection,
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
