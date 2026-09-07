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
export function listQuery(opts?: ListQueryOptions): (raw: any) => ListQuery;
/**
 * The response envelope for a list endpoint.
 *
 * @template T
 * @param {ListQuery} query the parsed query (for `page` / `pageSize` echo)
 * @param {T[]} data the page of rows
 * @param {number} total total rows matching the query, across all pages
 * @returns {{ data: T[], total: number, page: number, pageSize: number }}
 */
export function listResult<T>(query: ListQuery, data: T[], total: number): {
    data: T[];
    total: number;
    page: number;
    pageSize: number;
};
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
 */
export type ListQuery = {
    /**
     * 1-based page number
     */
    page: number;
    /**
     * rows per page (capped at `maxPageSize`)
     */
    pageSize: number;
    /**
     * `(page - 1) * pageSize`, ready for SQL
     */
    offset: number;
    /**
     * validated sort key, or null when the route has no sortable columns
     */
    sort: string | null;
    dir: "asc" | "desc";
    /**
     * trimmed free-text search, '' when absent
     */
    q: string;
};
export type ListQueryOptions = {
    /**
     * keys a client may sort by; anything else is a 400
     */
    sort?: string[];
    /**
     * default `sort[0]`
     */
    defaultSort?: string;
    /**
     * default 'asc'
     */
    defaultDir?: "asc" | "desc";
    /**
     * default 20
     */
    pageSize?: number;
    /**
     * default 200; larger requests are rejected, not clamped
     */
    maxPageSize?: number;
    /**
     * default 200 characters for `q`
     */
    maxQueryLength?: number;
};
