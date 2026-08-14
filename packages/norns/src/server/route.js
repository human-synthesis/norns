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
 * @typedef {Object} Serializer
 * @property {(result: any, event: RequestEvent) => Response | null} serialize
 *   turn the handler's return value into a Response, or return null to fall
 *   through to the default JSON serialization
 * @property {(request: Request, contentType: string) => Promise<any> | undefined} [parseBody]
 *   read a request body for a content type route() doesn't handle natively;
 *   return undefined to fall through to the built-in JSON/form readers
 */

/**
 * @typedef {Object} RouteOptions
 * @property {any} [input] body schema (Standard Schema or function)
 * @property {any} [query] query schema (Standard Schema or function)
 * @property {Serializer | null} [serializer] per-route serializer; null forces
 *   plain JSON even when an app-wide serializer is set
 * @property {(ctx: RouteContext) => any | Promise<any>} handler
 */

/** @type {Serializer | null} */
let defaultSerializer = null;

/**
 * Set the app-wide response serializer used by every route() that doesn't
 * declare its own (e.g. tronSerializer() from @human-synthesis/norns-tron).
 * Pass null to go back to plain JSON. Usually wired via boot({ serializer }).
 *
 * @param {Serializer | null} serializer
 */
export function setSerializer(serializer) {
	defaultSerializer = serializer ?? null;
}

/** @returns {Serializer | null} */
export function getSerializer() {
	return defaultSerializer;
}

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
	const hasOwnSerializer = 'serializer' in opts;

	return async (event) => {
		const container = event.locals.container;
		// Resolved per request so boot({ serializer }) applies regardless of
		// module evaluation order.
		const serializer = hasOwnSerializer ? opts.serializer : defaultSerializer;

		let input;
		if (inputSchema !== undefined) {
			const raw = await readBody(event.request, serializer);
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
		if (serializer?.serialize) {
			const response = serializer.serialize(result ?? null, event);
			if (response instanceof Response) return response;
		}
		return json(result ?? null);
	};
}

/**
 * Read and decode the request body based on its content-type. Returns `null`
 * for empty bodies or unsupported types — the schema is then free to reject
 * (or accept `null`).
 *
 * @param {Request} request
 * @param {Serializer | null} [serializer]
 * @returns {Promise<any>}
 */
async function readBody(request, serializer) {
	const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
	if (serializer?.parseBody) {
		const parsed = serializer.parseBody(request, contentType);
		if (parsed !== undefined) return await parsed;
	}
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
