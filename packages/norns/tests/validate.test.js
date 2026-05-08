import { describe, test, expect } from 'bun:test';
import { validate, ValidationError } from '../src/server/validate.js';

describe('validate', () => {
	test('null/undefined schema is passthrough', () => {
		expect(validate(null, { a: 1 })).toEqual({ a: 1 });
		expect(validate(undefined, 'x')).toBe('x');
	});

	test('function schema runs as parser', () => {
		const schema = (v) => {
			if (typeof v !== 'number') throw new Error('not a number');
			return v * 2;
		};
		expect(validate(schema, 21)).toBe(42);
		expect(() => validate(schema, 'x')).toThrow('not a number');
	});

	test('Standard Schema success returns value', () => {
		const schema = standardSchema((input) => ({ value: { ok: true, input } }));
		expect(validate(schema, 'in')).toEqual({ ok: true, input: 'in' });
	});

	test('Standard Schema failure throws ValidationError with issues', () => {
		const schema = standardSchema(() => ({
			issues: [{ kind: 'validation', path: [{ key: 'name' }], message: 'required' }]
		}));
		try {
			validate(schema, {});
			expect(false).toBe(true);
		} catch (e) {
			expect(e).toBeInstanceOf(ValidationError);
			expect(e.issues.length).toBe(1);
			expect(e.message).toMatch(/name: required/);
		}
	});

	test('async Standard Schema is rejected with helpful error', () => {
		const schema = standardSchema(() => Promise.resolve({ value: 'x' }));
		expect(() => validate(schema, {})).toThrow(/Async schema validation is not supported/);
	});

	test('non-schema, non-function throws explanatory error', () => {
		expect(() => validate({ random: 'thing' }, 'x')).toThrow(
			/must implement Standard Schema or be a function/
		);
	});
});

function standardSchema(validateFn) {
	return { '~standard': { validate: validateFn } };
}
