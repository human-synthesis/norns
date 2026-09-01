import { describe, expect, test } from 'bun:test';

import { parseExpr } from '../src/kernel/expr.js';
import { compileGuard, compileWhere, evalExpr } from '../src/kernel/expr-compile.js';

const USER = { id: 'u1', roles: ['admin', 'editor'] };

describe('evalExpr', () => {
	test('the PLAN examples evaluate', () => {
		// `draft` is a path — row.draft is compared, not the string "draft"
		expect(evalExpr(parseExpr('status == draft'), { row: { status: 'draft' } })).toBe(false);
		expect(
			evalExpr(parseExpr('status == draft'), { row: { status: 'draft', draft: 'draft' } })
		).toBe(true);
		expect(evalExpr(parseExpr('status == "draft"'), { row: { status: 'draft' } })).toBe(true);
		expect(
			evalExpr(parseExpr('owner or role:admin'), {
				row: { customer: 'u2' },
				user: USER,
				ownerField: 'customer'
			})
		).toBe(true);
		expect(
			evalExpr(parseExpr('total > 100 and status in ["submitted", "paid"]'), {
				row: { total: 150, status: 'paid' }
			})
		).toBe(true);
	});

	test('nested paths are null-safe', () => {
		expect(evalExpr(parseExpr('order.customer.id == null'), { row: {} })).toBe(false);
		expect(evalExpr(parseExpr('order.customer.id != "u1"'), { row: {} })).toBe(true);
	});

	test('owner without ownerField throws', () => {
		expect(() => evalExpr(parseExpr('owner'), { row: {}, user: USER })).toThrow(/ownerField/);
	});
});

describe('compileGuard', () => {
	test('emits plain JS/Civet', () => {
		expect(compileGuard(parseExpr('status == "draft"'))).toBe('((row.status) === ("draft"))');
		expect(compileGuard(parseExpr('owner or role:admin'), { ownerField: 'customer' })).toBe(
			'(!!(row?.customer === user?.id) || !!!!user?.roles?.includes("admin"))'
		);
	});

	test('owner without ownerField throws at compile time', () => {
		expect(() => compileGuard(parseExpr('owner'))).toThrow(/ownerField/);
	});

	test('fuzz: compiled guard agrees with evalExpr on random rows', () => {
		let s = 0xc0ffee >>> 0;
		const r = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
		const FIELDS = ['status', 'total', 'flag', 'name', 'customer'];
		const scalar = () => {
			const k = Math.floor(r() * 5);
			if (k === 0) return Math.floor(r() * 20) - 10;
			if (k === 1) return ['draft', 'paid', 'x'][Math.floor(r() * 3)];
			if (k === 2) return r() < 0.5;
			if (k === 3) return null;
			return undefined;
		};
		const atom = () => {
			const k = Math.floor(r() * 6);
			if (k === 0) return { lit: scalar() ?? null };
			if (k === 1) return { lit: [scalar() ?? null, scalar() ?? null] };
			if (k === 2) return { path: [FIELDS[Math.floor(r() * FIELDS.length)]] };
			if (k === 3) return { owner: true };
			if (k === 4) return { role: ['admin', 'ghost'][Math.floor(r() * 2)] };
			return { path: ['nested', FIELDS[Math.floor(r() * FIELDS.length)]] };
		};
		const gen = (depth) => {
			if (depth <= 0) return atom();
			const k = Math.floor(r() * 7);
			if (k <= 1) {
				return {
					op: k === 0 ? 'or' : 'and',
					args: Array.from({ length: 2 + Math.floor(r() * 2) }, () => gen(depth - 1))
				};
			}
			if (k === 2) return { op: 'not', args: [gen(depth - 1)] };
			if (k <= 5) {
				const ops = ['==', '!=', '<', '<=', '>', '>=', 'in'];
				return { op: ops[Math.floor(r() * ops.length)], args: [gen(0), gen(0)] };
			}
			return atom();
		};
		for (let i = 0; i < 500; i++) {
			const ast = gen(1 + Math.floor(r() * 2));
			const row = Object.fromEntries(FIELDS.map((f) => [f, scalar()]));
			row.nested = r() < 0.5 ? Object.fromEntries(FIELDS.map((f) => [f, scalar()])) : null;
			const user = r() < 0.3 ? {} : USER;
			const code = compileGuard(ast, { ownerField: 'customer' });
			const fn = new Function('row', 'user', `return (${code});`);
			const expected = evalExpr(ast, { row, user, ownerField: 'customer' });
			expect(!!fn(row, user)).toBe(!!expected);
		}
	});
});

describe('compileWhere', () => {
	const table = { status: 'status', total: 'total', flag: 'flag', customer: 'customer' };
	/** Predicate ops — where fragments become row predicates for testing. */
	const ops = {
		and: (...fs) => (row) => fs.every((f) => f(row)),
		or: (...fs) => (row) => fs.some((f) => f(row)),
		not: (f) => (row) => !f(row),
		eq: (c, v) => (row) => row[c] === v,
		ne: (c, v) => (row) => row[c] !== v,
		lt: (c, v) => (row) => row[c] < v,
		lte: (c, v) => (row) => row[c] <= v,
		gt: (c, v) => (row) => row[c] > v,
		gte: (c, v) => (row) => row[c] >= v,
		inArray: (c, vs) => (row) => vs.includes(row[c]),
		bool: (v) => () => v
	};
	const where = (src, extra = {}) =>
		compileWhere(parseExpr(src), { table, ops, user: USER, ownerField: 'customer', ...extra });

	test('column-vs-literal comparisons, flipped operands, in-lists', () => {
		expect(where('status == "draft"')({ status: 'draft' })).toBe(true);
		expect(where('100 < total')({ total: 150 })).toBe(true);
		expect(where('100 < total')({ total: 50 })).toBe(false);
		expect(where('status in ["a", "b"]')({ status: 'b' })).toBe(true);
		expect(where('owner or role:admin')({ customer: 'someone-else' })).toBe(true); // via role
		expect(where('owner', { user: { id: 'u9' } })({ customer: 'u9' })).toBe(true);
		expect(where('not status == "draft"')({ status: 'paid' })).toBe(true);
	});

	test('rejects what SQL cannot express', () => {
		expect(() => where('a.b == 1')).toThrow(/nested path/);
		expect(() => where('status == total')).toThrow(/column-vs-literal/);
		expect(() => where('ghost == 1')).toThrow(/unknown column/);
		expect(() => where('status in total')).toThrow(/column-vs-literal/);
		expect(() => where('owner', { ownerField: undefined })).toThrow(/ownerField/);
	});

	test('fuzz: where predicate agrees with evalExpr on the SQL-able subset', () => {
		let s = 0xfeed >>> 0;
		const r = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
		const COLS = Object.keys(table);
		const scalar = () => {
			const k = Math.floor(r() * 3);
			if (k === 0) return Math.floor(r() * 10) - 5;
			if (k === 1) return ['draft', 'paid'][Math.floor(r() * 2)];
			return r() < 0.5;
		};
		const leaf = () => {
			const k = Math.floor(r() * 4);
			if (k === 0) return { owner: true };
			if (k === 1) return { role: ['admin', 'ghost'][Math.floor(r() * 2)] };
			if (k === 2) {
				return {
					op: 'in',
					args: [{ path: [COLS[Math.floor(r() * COLS.length)]] }, { lit: [scalar(), scalar()] }]
				};
			}
			const cmp = ['==', '!=', '<', '<=', '>', '>='][Math.floor(r() * 6)];
			return { op: cmp, args: [{ path: [COLS[Math.floor(r() * COLS.length)]] }, { lit: scalar() }] };
		};
		const gen = (depth) => {
			if (depth <= 0) return leaf();
			const k = Math.floor(r() * 4);
			if (k <= 1) {
				return {
					op: k === 0 ? 'or' : 'and',
					args: Array.from({ length: 2 }, () => gen(depth - 1))
				};
			}
			if (k === 2) return { op: 'not', args: [gen(depth - 1)] };
			return leaf();
		};
		for (let i = 0; i < 500; i++) {
			const ast = gen(1 + Math.floor(r() * 2));
			const row = Object.fromEntries(COLS.map((c) => [c, scalar()]));
			row.customer = r() < 0.5 ? 'u1' : 'u2';
			const predicate = compileWhere(ast, { table, ops, user: USER, ownerField: 'customer' });
			const expected = evalExpr(ast, { row, user: USER, ownerField: 'customer' });
			expect(predicate(row)).toBe(!!expected);
		}
	});
});
