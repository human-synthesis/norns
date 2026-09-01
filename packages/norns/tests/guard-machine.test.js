import { describe, expect, test } from 'bun:test';

import { guard, guardRun } from '../src/server/guard.js';
import { machine } from '../src/server/machine.js';

const POLICY = {
	read: { check: (row, user) => row?.owner === user?.id || !!user?.roles?.includes('admin') },
	write: { check: (row, user) => row?.owner === user?.id },
	run: { submit: (row) => row?.status === 'draft' }
};

const row = { owner: 'u1', status: 'draft' };

describe('guard', () => {
	test('passing check returns true', () => {
		expect(guard(POLICY, 'write', { row, user: { id: 'u1' } })).toBe(true);
	});

	test('failing check throws 403', () => {
		expect(() => guard(POLICY, 'write', { row, user: { id: 'u2' } })).toThrow();
	});

	test('read rule honors role predicate', () => {
		expect(guard(POLICY, 'read', { row, user: { id: 'u9', roles: ['admin'] } })).toBe(true);
	});

	test('deny-by-default: missing policy throws', () => {
		expect(() => guard(undefined, 'write', { row, user: { id: 'u1' } })).toThrow();
	});

	test('deny-by-default: missing rule throws', () => {
		expect(() => guard({}, 'write', { row, user: { id: 'u1' } })).toThrow();
	});

	test('a throwing check denies instead of bypassing', () => {
		const p = { write: { check: () => { throw new Error('boom'); } } };
		try {
			guard(p, 'write', { row, user: { id: 'u1' } });
			expect.unreachable();
		} catch (e) {
			expect(e.status).toBe(403);
		}
	});

	test('truthy-but-not-true check results deny', () => {
		const p = { write: { check: () => 1 } };
		expect(() => guard(p, 'write', {})).toThrow();
	});
});

describe('guardRun', () => {
	test('run rule passes when predicate holds', () => {
		expect(guardRun(POLICY, 'submit', { row })).toBe(true);
	});

	test('run rule denies when predicate fails', () => {
		expect(() => guardRun(POLICY, 'submit', { row: { status: 'paid' } })).toThrow();
	});

	test('actions without a run rule pass', () => {
		expect(guardRun(POLICY, 'open', { row })).toBe(true);
		expect(guardRun({}, 'open', { row })).toBe(true);
	});
});

describe('machine', () => {
	const m = machine({ draft: ['submitted'], submitted: ['paid', 'cancelled'], paid: [], cancelled: [] });

	test('initial is the untargeted state', () => {
		expect(m.initial).toBe('draft');
	});

	test('can/next report declared transitions only', () => {
		expect(m.can('draft', 'submitted')).toBe(true);
		expect(m.can('draft', 'paid')).toBe(false);
		expect(m.can('nope', 'paid')).toBe(false);
		expect(m.next('submitted')).toEqual(['paid', 'cancelled']);
		expect(m.next('nope')).toEqual([]);
	});

	test('assert returns the target on legal transitions', () => {
		expect(m.assert('draft', 'submitted')).toBe('submitted');
	});

	test('assert throws 409 on undeclared transitions', () => {
		try {
			m.assert('paid', 'draft');
			expect.unreachable();
		} catch (e) {
			expect(e.status).toBe(409);
			expect(e.body.message).toMatch(/invalid transition paid -> draft/);
		}
	});

	test('cyclic maps fall back to sorted-first initial', () => {
		const cyc = machine({ on: ['off'], off: ['on'] });
		expect(cyc.initial).toBe('off');
	});

	test('states are sorted', () => {
		expect(m.states).toEqual(['cancelled', 'draft', 'paid', 'submitted']);
	});
});
