import { describe, expect, test } from 'bun:test';

import { isExpr, parseExpr, printExpr } from '../src/kernel/expr.js';

describe('parseExpr', () => {
	test('the PLAN examples', () => {
		expect(parseExpr('status == draft')).toEqual({
			op: '==',
			args: [{ path: ['status'] }, { path: ['draft'] }]
		});
		expect(parseExpr('owner or role:admin')).toEqual({
			op: 'or',
			args: [{ owner: true }, { role: 'admin' }]
		});
		expect(parseExpr('total > 100 and status in ["submitted", "paid"]')).toEqual({
			op: 'and',
			args: [
				{ op: '>', args: [{ path: ['total'] }, { lit: 100 }] },
				{ op: 'in', args: [{ path: ['status'] }, { lit: ['submitted', 'paid'] }] }
			]
		});
	});

	test('n-ary or/and are flattened; mixed precedence nests', () => {
		expect(parseExpr('a or b or c').args).toHaveLength(3);
		expect(parseExpr('a and b and c').args).toHaveLength(3);
		expect(parseExpr('a or b and c')).toEqual({
			op: 'or',
			args: [{ path: ['a'] }, { op: 'and', args: [{ path: ['b'] }, { path: ['c'] }] }]
		});
	});

	test('parens override precedence', () => {
		expect(parseExpr('(a or b) and c')).toEqual({
			op: 'and',
			args: [{ op: 'or', args: [{ path: ['a'] }, { path: ['b'] }] }, { path: ['c'] }]
		});
	});

	test('not binds tighter than and', () => {
		expect(parseExpr('not a and b')).toEqual({
			op: 'and',
			args: [{ op: 'not', args: [{ path: ['a'] }] }, { path: ['b'] }]
		});
	});

	test('dotted paths, literals, negative numbers, escapes', () => {
		expect(parseExpr('order.customer.id != null')).toEqual({
			op: '!=',
			args: [{ path: ['order', 'customer', 'id'] }, { lit: null }]
		});
		expect(parseExpr('x >= -1.5e3')).toEqual({
			op: '>=',
			args: [{ path: ['x'] }, { lit: -1500 }]
		});
		expect(parseExpr('name == "he said \\"hi\\""')).toEqual({
			op: '==',
			args: [{ path: ['name'] }, { lit: 'he said "hi"' }]
		});
		expect(parseExpr('flag == true')).toEqual({
			op: '==',
			args: [{ path: ['flag'] }, { lit: true }]
		});
		expect(parseExpr('[]')).toEqual({ lit: [] });
	});

	test('a parenthesized boolean can be a cmp operand', () => {
		expect(parseExpr('(a or b) == true')).toEqual({
			op: '==',
			args: [{ op: 'or', args: [{ path: ['a'] }, { path: ['b'] }] }, { lit: true }]
		});
	});

	test('rejects invalid input with positions', () => {
		expect(() => parseExpr('')).toThrow(/unexpected "eof"/);
		expect(() => parseExpr('a ==')).toThrow(/unexpected "eof"/);
		expect(() => parseExpr('a == b == c')).toThrow(/trailing/);
		expect(() => parseExpr('not not a')).toThrow(/unexpected "not"/);
		expect(() => parseExpr('a or')).toThrow();
		expect(() => parseExpr('role:')).toThrow(/role name/);
		expect(() => parseExpr('role:"admin"')).toThrow(/role name/);
		expect(() => parseExpr('a.')).toThrow(/path segment/);
		expect(() => parseExpr('a.or')).toThrow(/path segment/);
		expect(() => parseExpr('[a]')).toThrow(/expected literal/);
		expect(() => parseExpr('[1, [2]]')).toThrow(/expected literal/);
		expect(() => parseExpr('"unterminated')).toThrow(/unterminated string/);
		expect(() => parseExpr('a @ b')).toThrow(/unexpected "@"/);
		expect(() => parseExpr('a = b')).toThrow(/unexpected "="/);
		expect(isExpr('owner or role:admin')).toBe(true);
		expect(isExpr('a ==')).toBe(false);
	});
});

describe('printExpr', () => {
	test('minimal parens only', () => {
		const roundtrip = (s) => printExpr(parseExpr(s));
		expect(roundtrip('a or b and c')).toBe('a or b and c');
		expect(roundtrip('(a or b) and c')).toBe('(a or b) and c');
		expect(roundtrip('not (a or b)')).toBe('not (a or b)');
		expect(roundtrip('not a and b')).toBe('not a and b');
		expect(roundtrip('(a or b) == true')).toBe('(a or b) == true');
		expect(roundtrip('total > 100 and status in ["submitted","paid"]')).toBe(
			'total > 100 and status in ["submitted", "paid"]'
		);
	});

	test('rejects malformed AST nodes', () => {
		expect(() => printExpr({ op: 'xor', args: [] })).toThrow(/invalid expression node/);
		expect(() => printExpr(42)).toThrow(/invalid expression node/);
	});
});

describe('fuzz: parse ∘ print is the identity on generated ASTs', () => {
	function rng(seed) {
		let s = seed >>> 0;
		return () => {
			s = (s * 1664525 + 1013904223) >>> 0;
			return s / 2 ** 32;
		};
	}

	const IDENTS = ['a', 'b', 'status', 'total', 'order_id', 'x2', '_hidden'];
	const ROLES = ['admin', 'editor', 'support'];
	const CMPS = ['==', '!=', '<', '<=', '>', '>=', 'in'];

	function genScalar(r) {
		const k = Math.floor(r() * 5);
		if (k === 0) return Math.floor(r() * 2000) - 1000;
		if (k === 1) return Math.round(r() * 1e6) / 100;
		if (k === 2) return ['draft', 'paid', 'he said "hi"', 'a\\b', 'x\ny'][Math.floor(r() * 5)];
		if (k === 3) return r() < 0.5;
		return null;
	}

	function genAtom(r) {
		const k = Math.floor(r() * 5);
		if (k === 0) return { lit: genScalar(r) };
		if (k === 1) {
			return { lit: Array.from({ length: Math.floor(r() * 3) }, () => genScalar(r)) };
		}
		if (k === 2) {
			const len = 1 + Math.floor(r() * 3);
			return { path: Array.from({ length: len }, () => IDENTS[Math.floor(r() * IDENTS.length)]) };
		}
		if (k === 3) return { owner: true };
		return { role: ROLES[Math.floor(r() * ROLES.length)] };
	}

	function genNode(r, depth) {
		if (depth <= 0) return genAtom(r);
		const k = Math.floor(r() * 8);
		if (k === 0 || k === 1) {
			const len = 2 + Math.floor(r() * 2);
			return {
				op: k === 0 ? 'or' : 'and',
				args: Array.from({ length: len }, () => genNode(r, depth - 1))
			};
		}
		if (k === 2) return { op: 'not', args: [genNode(r, depth - 1)] };
		if (k <= 5) {
			return {
				op: CMPS[Math.floor(r() * CMPS.length)],
				args: [genNode(r, depth - 1), genNode(r, depth - 1)]
			};
		}
		return genAtom(r);
	}

	test('500 random ASTs round-trip exactly', () => {
		const r = rng(0x5eed);
		for (let i = 0; i < 500; i++) {
			const ast = genNode(r, 1 + Math.floor(r() * 3));
			const text = printExpr(ast);
			let parsed;
			try {
				parsed = parseExpr(text);
			} catch (err) {
				throw new Error(`failed to parse printed AST ${JSON.stringify(ast)} -> ${text}: ${err.message}`);
			}
			expect(parsed).toEqual(ast);
			expect(printExpr(parsed)).toBe(text);
		}
	});

	test('500 printed forms re-parse after whitespace mangling', () => {
		const r = rng(0xbeef);
		for (let i = 0; i < 500; i++) {
			const ast = genNode(r, 2);
			const text = printExpr(ast);
			const mangled = text.replace(/ (or|and|not|in) /g, '  $1\t');
			expect(parseExpr(mangled)).toEqual(ast);
		}
	});
});
