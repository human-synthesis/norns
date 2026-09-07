import { describe, test, expect } from 'bun:test';
import { listQuery, listResult } from '../src/server/list.js';
import { ValidationError, validate } from '../src/server/validate.js';

describe('listQuery', () => {
	const schema = listQuery({ sort: ['title', 'updated_at'], defaultSort: 'updated_at', defaultDir: 'desc' });

	test('defaults when nothing is given', () => {
		expect(schema({})).toEqual({ page: 1, pageSize: 20, offset: 0, sort: 'updated_at', dir: 'desc', q: '' });
		expect(schema(null)).toEqual({ page: 1, pageSize: 20, offset: 0, sort: 'updated_at', dir: 'desc', q: '' });
	});

	test('parses query-string values and computes the offset', () => {
		expect(schema({ page: '3', pageSize: '50', sort: 'title', dir: 'asc', q: '  hello ' })).toEqual({
			page: 3,
			pageSize: 50,
			offset: 100,
			sort: 'title',
			dir: 'asc',
			q: 'hello'
		});
	});

	test('rejects unknown sort keys, bad directions and non-integer pages', () => {
		const issues = (raw) => {
			try {
				schema(raw);
			} catch (e) {
				expect(e).toBeInstanceOf(ValidationError);
				return e.issues.map((i) => i.path[0].key);
			}
			throw new Error('expected a ValidationError');
		};
		expect(issues({ sort: 'password' })).toEqual(['sort']);
		expect(issues({ dir: 'sideways' })).toEqual(['dir']);
		expect(issues({ page: '1.5' })).toEqual(['page']);
		expect(issues({ page: '0', pageSize: 'x' })).toEqual(['page', 'pageSize']);
		expect(issues({ pageSize: '201' })).toEqual(['pageSize']);
		expect(issues({ q: 'x'.repeat(201) })).toEqual(['q']);
	});

	test('routes with no sortable columns still accept page/q but reject sort', () => {
		const plain = listQuery({ pageSize: 5, maxPageSize: 10 });
		expect(plain({ q: 'a' })).toMatchObject({ page: 1, pageSize: 5, sort: null, dir: 'asc', q: 'a' });
		expect(() => plain({ sort: 'title' })).toThrow(/sorting is not supported/);
		expect(() => plain({ pageSize: '11' })).toThrow(/at most 10/);
	});

	test('defaultSort must be sortable', () => {
		expect(() => listQuery({ sort: ['a'], defaultSort: 'b' })).toThrow(/defaultSort/);
	});

	test('is a plain function schema usable through validate()', () => {
		expect(validate(schema, { page: '2' }).offset).toBe(20);
	});
});

describe('listResult', () => {
	test('builds the envelope from the parsed query', () => {
		const q = listQuery()({ page: '2', pageSize: '10' });
		expect(listResult(q, [{ id: 1 }], 42)).toEqual({ data: [{ id: 1 }], total: 42, page: 2, pageSize: 10 });
	});
});
