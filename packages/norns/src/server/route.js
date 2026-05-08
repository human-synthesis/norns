import { json, error } from '@sveltejs/kit';
import { validate, ValidationError } from './validate.js';

/** @typedef {import('@sveltejs/kit').RequestEvent} RequestEvent */
/** @typedef {import('./container.js').Container} Container */

/**
 * @typedef {Object} RouteContext
 * @property {any} input parsed body (after validation)
 * @property {any} query parsed query (after validation)
 * @property {Container} container request-scoped container
 * @property {RequestEvent} event raw SvelteKit event
 * @property {any} user shortcut for `event.locals.user`
 */

/**
 * @typedef {Object} RouteOptions
 * @property {any} [input] body schema (Standard Schema or function)
 * @property {any} [query] query schema (Standard Schema or function)
 * @property {(ctx: RouteContext) => any | Promise<any>} handler
 */

/**
 * Wrap a `+server.c` handler. Bakes in:
 *   1. body parsing (JSON / urlencoded / multipart) + validation
 *   2. query validation
 *   3. container resolution from `event.locals.container`
 *   4. JSON serialization of the return value (or pass-through if it's a Response)
 *   5. 400 errors on validation failure (via SvelteKit `error()`)
 *
 * Use `throw error(...)` / `throw redirect(...)` from inside the handler for
 * non-success outcomes; SvelteKit will surface them.
 *
 * @param {RouteOptions} opts
 * @returns {(event: RequestEvent) => Promise<Response>}
 */
export function route(opts) {
	const { input: inputSchema, query: querySchema, handler } = opts;
	if (typeof handler !== 'function') {
		throw new Error('route(): `handler` is required');
	}

	return async (event) => {
		const container = event.locals.container;

		let input;
		if (inputSchema !== undefined) {
			const raw = await readBody(event.request);
			try {
				input = validate(inputSchema, raw);
			} catch (e) {
				if (e instanceof ValidationError) {
					throw error(400, { message: e.message, issues: e.issues });
				}
				throw e;
			}
		}

		let query;
		if (querySchema !== undefined) {
			const raw = Object.fromEntries(event.url.searchParams);
			try {
				query = validate(querySchema, raw);
			} catch (e) {
				if (e instanceof ValidationError) {
					throw error(400, { message: e.message, issues: e.issues });
				}
				throw e;
			}
		}

		const result = await handler({
			input,
			query,
			container,
			event,
			user: event.locals.user
		});

		if (result instanceof Response) return result;
		return json(result ?? null);
	};
}

/**
 * Read and decode the request body based on its content-type. Returns `null`
 * for empty bodies or unsupported types — the schema is then free to reject
 * (or accept `null`).
 *
 * @param {Request} request
 * @returns {Promise<any>}
 */
async function readBody(request) {
	const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
	if (contentType === 'application/json') {
		try {
			return await request.json();
		} catch {
			return null;
		}
	}
	if (
		contentType === 'application/x-www-form-urlencoded' ||
		contentType === 'multipart/form-data'
	) {
		try {
			const data = await request.formData();
			return Object.fromEntries(data);
		} catch {
			return null;
		}
	}
	return null;
}
