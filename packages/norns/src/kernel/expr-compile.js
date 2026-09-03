/**
 * Expression compilers (K-04) — one AST, three consumers:
 *
 *   evalExpr      reference evaluator (app.trace, tests, runtime interp)
 *   compileGuard  AST → Civet/JS guard expression over `row` and `user`
 *   compileWhere  AST → Drizzle where fragment via an operator namespace
 *
 * The guard compiler and the evaluator agree exactly — the fuzz suite
 * checks compiled output against evalExpr on random rows. compileWhere is
 * dialect-agnostic: the caller passes the drizzle operators (`and`, `or`,
 * `eq`, `inArray`, ...) so the kernel has no drizzle dependency.
 *
 * Evaluation context: `row` (the entity row or action input), `user`
 * ({ id, roles }), and `ownerField` (which row field owns the row —
 * required to compile `owner`).
 */

import { CMP_OPS } from './expr.js';

/**
 * @param {*} ast
 * @param {{ row?: *, user?: { id?: *, roles?: string[] }, ownerField?: string }} ctx
 * @returns {*}
 */
export function evalExpr(ast, ctx = {}) {
	const { row = {}, user = {}, ownerField } = ctx;
	function ev(node) {
		if ('lit' in node) return node.lit;
		if ('path' in node) {
			let v = row;
			for (const seg of node.path) v = v == null ? undefined : v[seg];
			return v;
		}
		if (node.owner === true) {
			if (!ownerField) throw new Error('cannot evaluate `owner` without ownerField');
			return row?.[ownerField] === user?.id;
		}
		if ('role' in node) return !!user?.roles?.includes(node.role);
		switch (node.op) {
			case 'or':
				return node.args.reduce((acc, a) => acc || !!ev(a), false);
			case 'and':
				return node.args.reduce((acc, a) => acc && !!ev(a), true);
			case 'not':
				return !ev(node.args[0]);
			case '==':
				return ev(node.args[0]) === ev(node.args[1]);
			case '!=':
				return ev(node.args[0]) !== ev(node.args[1]);
			case '<':
				return ev(node.args[0]) < ev(node.args[1]);
			case '<=':
				return ev(node.args[0]) <= ev(node.args[1]);
			case '>':
				return ev(node.args[0]) > ev(node.args[1]);
			case '>=':
				return ev(node.args[0]) >= ev(node.args[1]);
			case 'in': {
				const r = ev(node.args[1]);
				return !!(r?.includes?.(ev(node.args[0])));
			}
			default:
				throw new Error(`cannot evaluate node: ${JSON.stringify(node)}`);
		}
	}
	return ev(ast);
}

const JS_CMP = { '==': '===', '!=': '!==', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };

/**
 * Compile to a Civet/JS boolean expression over `row` and `user`.
 * Semantics match evalExpr exactly.
 *
 * @param {*} ast
 * @param {{ ownerField?: string }} [opts]
 * @returns {string}
 */
export function compileGuard(ast, opts = {}) {
	function emit(node) {
		if ('lit' in node) return JSON.stringify(node.lit);
		if ('path' in node) {
			const [head, ...rest] = node.path;
			return `row${rest.length ? '?' : ''}.${head}${rest.map((s) => `?.${s}`).join('')}`;
		}
		if (node.owner === true) {
			if (!opts.ownerField) throw new Error('cannot compile `owner` without ownerField');
			return `(row?.${opts.ownerField} === user?.id)`;
		}
		if ('role' in node) return `!!user?.roles?.includes(${JSON.stringify(node.role)})`;
		switch (node.op) {
			case 'or':
				return `(${node.args.map((a) => `!!${emit(a)}`).join(' || ')})`;
			case 'and':
				return `(${node.args.map((a) => `!!${emit(a)}`).join(' && ')})`;
			case 'not':
				return `!(${emit(node.args[0])})`;
			case 'in':
				return `!!((${emit(node.args[1])})?.includes?.(${emit(node.args[0])}))`;
			default: {
				const op = JS_CMP[node.op];
				if (!op) throw new Error(`cannot compile node: ${JSON.stringify(node)}`);
				return `((${emit(node.args[0])}) ${op} (${emit(node.args[1])}))`;
			}
		}
	}
	return emit(ast);
}

/**
 * @typedef {{
 *   and: (...args: *) => *, or: (...args: *) => *, not: (arg: *) => *,
 *   eq: (col: *, v: *) => *, ne: (col: *, v: *) => *,
 *   lt: (col: *, v: *) => *, lte: (col: *, v: *) => *,
 *   gt: (col: *, v: *) => *, gte: (col: *, v: *) => *,
 *   inArray: (col: *, v: *[]) => *, bool: (v: boolean) => *,
 *   isNull: (col: *) => *, isNotNull: (col: *) => *
 * }} WhereOps
 */

const FLIP = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };
const OP_FN = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' };

/**
 * Compile to a Drizzle where fragment. Supports the SQL-able subset:
 * single-segment column paths compared against literals, `owner`, `role:`
 * (resolved against `user` at build time) and boolean combinators. Anything
 * beyond that (nested paths, path-vs-path comparison) throws — such rules
 * belong in a guard, not a where clause.
 *
 * @param {*} ast
 * @param {{ table: *, ops: WhereOps, user?: *, ownerField?: string }} ctx
 */
export function compileWhere(ast, ctx) {
	const { table, ops, user = {}, ownerField } = ctx;

	function column(path) {
		if (path.length !== 1) {
			throw new Error(`cannot compile nested path "${path.join('.')}" to a where clause`);
		}
		const col = table[path[0]];
		if (col === undefined) throw new Error(`unknown column "${path[0]}"`);
		return col;
	}

	function build(node) {
		if ('lit' in node) return ops.bool(!!node.lit);
		if ('path' in node) return ops.eq(column(node.path), true);
		if (node.owner === true) {
			if (!ownerField) throw new Error('cannot compile `owner` without ownerField');
			// Anonymous user → deny, matching evalExpr. Binding undefined into
			// `owner = ?` is a driver error on D1 rather than an empty result.
			if (user?.id == null) return ops.bool(false);
			return ops.eq(column([ownerField]), user.id);
		}
		if ('role' in node) return ops.bool(!!user?.roles?.includes(node.role));
		switch (node.op) {
			case 'or':
				return ops.or(...node.args.map(build));
			case 'and':
				return ops.and(...node.args.map(build));
			case 'not':
				return ops.not(build(node.args[0]));
			default:
				if (!CMP_OPS.includes(node.op)) {
					throw new Error(`cannot compile node: ${JSON.stringify(node)}`);
				}
				return buildCmp(node);
		}
	}

	function buildCmp({ op, args }) {
		let [l, r] = args;
		let effOp = op;
		if ('lit' in l && 'path' in r && op !== 'in') {
			[l, r] = [r, l];
			effOp = FLIP[op];
		}
		if (!('path' in l) || !('lit' in r)) {
			throw new Error(
				`where clauses support column-vs-literal comparisons only, got ${op} over ${JSON.stringify(args)}`
			);
		}
		if (r.lit === null) {
			// K-57/D78: SQL `col <> NULL` matches nothing — null comparisons
			// are IS [NOT] NULL, and nothing else is defined against null.
			if (effOp === '==') return ops.isNull(column(l.path));
			if (effOp === '!=') return ops.isNotNull(column(l.path));
			throw new Error(`null only supports == and != in a where clause, got ${op}`);
		}
		if (effOp === 'in') {
			if (!Array.isArray(r.lit)) throw new Error('`in` in a where clause needs a list literal');
			return ops.inArray(column(l.path), r.lit);
		}
		return ops[OP_FN[effOp]](column(l.path), r.lit);
	}

	return build(ast);
}
