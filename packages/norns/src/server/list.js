import { ValidationError } from './validate.js';

/**
 * List-query convention for paged, sorted, searchable endpoints — the query
 * half of a `GET /api/things?page=2&pageSize=50&sort=title&dir=desc&q=foo`
 * route. Pair with `listResult()` for the `{ data, total, page, pageSize }`
 * envelope that norns-ui's `useList()` and the TRON `path: '$.data'` contracts
 * expect.
 *
 *   export GET := route
 *     query: listQuery({ sort: ['title', 'updated_at'], defaultSort: 'updated_at', defaultDir: 'desc' })
 *     handler: ({ query, container }) => notes(container).page(query)
 *
 * `listQuery()` returns a plain function schema (see `validate()`), so it
 * needs no schema library and can be composed: wrap it to add your own
 * filters, or read `query.q` for free-text search.
 *
 * @typedef {Object} ListQuery
 * @property {number} page 1-based page number
 * @property {number} pageSize rows per page (capped at `maxPageSize`)
 * @property {number} offset `(page - 1) * pageSize`, ready for SQL
 * @property {string | null} sort validated sort key, or null when the route has no sortable columns
 * @property {'asc' | 'desc'} dir
 * @property {string} q trimmed free-text search, '' when absent
 */

/**
 * @typedef {Object} ListQueryOptions
 * @property {string[]} [sort] keys a client may sort by; anything else is a 400
 * @property {string} [defaultSort] default `sort[0]`
 * @property {'asc' | 'desc'} [defaultDir] default 'asc'
 * @property {number} [pageSize] default 20
 * @property {number} [maxPageSize] default 200; larger requests are rejected, not clamped
 * @property {number} [maxQueryLength] default 200 characters for `q`
 */

/**
 * @param {ListQueryOptions} [opts]
 * @returns {(raw: any) => ListQuery}
 */
export function listQuery(opts = {}) {
	const sortable = opts.sort ?? [];
	const defaultSort = opts.defaultSort ?? sortable[0] ?? null;
	if (defaultSort !== null && !sortable.includes(defaultSort)) {
		throw new Error(`listQuery(): defaultSort "${defaultSort}" is not in sort [${sortable.join(', ')}]`);
	}
	const defaultDir = opts.defaultDir ?? 'asc';
	const defaultPageSize = opts.pageSize ?? 20;
	const maxPageSize = opts.maxPageSize ?? 200;
	const maxQueryLength = opts.maxQueryLength ?? 200;

	return (raw) => {
		const src = raw && typeof raw === 'object' ? raw : {};
		/** @type {Array<{kind: 'validation', path: Array<{key: string}>, message: string}>} */
		const issues = [];
		const issue = (key, message) => issues.push({ kind: 'validation', path: [{ key }], message });

		const page = intParam(src.page, 1);
		if (page === null || page < 1) issue('page', 'must be a positive integer');

		const pageSize = intParam(src.pageSize, defaultPageSize);
		if (pageSize === null || pageSize < 1) issue('pageSize', 'must be a positive integer');
		else if (pageSize > maxPageSize) issue('pageSize', `must be at most ${maxPageSize}`);

		let sort = defaultSort;
		if (src.sort !== undefined && src.sort !== '') {
			if (typeof src.sort === 'string' && sortable.includes(src.sort)) sort = src.sort;
			else issue('sort', sortable.length ? `must be one of ${sortable.join(', ')}` : 'sorting is not supported');
		}

		let dir = defaultDir;
		if (src.dir !== undefined && src.dir !== '') {
			if (src.dir === 'asc' || src.dir === 'desc') dir = src.dir;
			else issue('dir', 'must be asc or desc');
		}

		let q = '';
		if (src.q !== undefined && src.q !== null) {
			if (typeof src.q !== 'string') issue('q', 'must be a string');
			else if (src.q.length > maxQueryLength) issue('q', `must be at most ${maxQueryLength} characters`);
			else q = src.q.trim();
		}

		if (issues.length) throw new ValidationError(issues);
		return {
			page: /** @type {number} */ (page),
			pageSize: /** @type {number} */ (pageSize),
			offset: (/** @type {number} */ (page) - 1) * /** @type {number} */ (pageSize),
			sort,
			dir,
			q
		};
	};
}

/**
 * The response envelope for a list endpoint.
 *
 * @template T
 * @param {ListQuery} query the parsed query (for `page` / `pageSize` echo)
 * @param {T[]} data the page of rows
 * @param {number} total total rows matching the query, across all pages
 * @returns {{ data: T[], total: number, page: number, pageSize: number }}
 */
export function listResult(query, data, total) {
	return { data, total, page: query.page, pageSize: query.pageSize };
}

/**
 * Query-string values arrive as strings; accept integers only (no floats, no
 * exponent forms), returning null on anything unparsable.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number | null}
 */
function intParam(value, fallback) {
	if (value === undefined || value === null || value === '') return fallback;
	if (typeof value === 'number') return Number.isInteger(value) ? value : null;
	if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null;
	return Number(value);
}
