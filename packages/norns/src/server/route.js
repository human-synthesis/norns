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
 * @typedef {Object} RouteCache
 * @property {number} ttl seconds a GET response may be reused
 * @property {boolean} [private] emit `Cache-Control: private` (per-user data)
 *   instead of `public`; also skips the shared edge cache
 * @property {string[]} [vary] request headers the cached body depends on;
 *   default `['accept']` so JSON and TRON variants never mix
 */

/**
 * @typedef {Object} RouteOptions
 * @property {any} [input] body schema (Standard Schema or function)
 * @property {any} [query] query schema (Standard Schema or function)
 * @property {Serializer | null} [serializer] per-route serializer; null forces
 *   plain JSON even when an app-wide serializer is set
 * @property {RouteCache} [cache] GET/HEAD response caching: sets
 *   `Cache-Control` + `ETag`, answers `If-None-Match` with 304, and on
 *   Cloudflare Workers (`event.platform.caches`) also stores the encoded body
 *   in the edge cache so the handler and the serializer run once per TTL
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
 *   1. body parsing (JSON / urlencoded / multipart / serializer-specific) + validation
 *   2. query validation
 *   3. container resolution from `event.locals.container`
 *   4. JSON serialization of the return value (or pass-through if it's a Response)
 *   5. 400 errors on validation failure (via SvelteKit `error()`)
 *   6. optional GET caching (`cache: { ttl }`)
 *
 * Use `throw error(...)` / `throw redirect(...)` from inside the handler for
 * non-success outcomes; SvelteKit will surface them.
 *
 * @param {RouteOptions} opts
 * @returns {(event: RequestEvent) => Promise<Response>}
 */
export function route(opts) {
	const { input: inputSchema, query: querySchema, handler, cache } = opts;
	if (typeof handler !== 'function') {
		throw new Error('route(): `handler` is required');
	}
	if (cache !== undefined && !(Number.isFinite(cache?.ttl) && cache.ttl > 0)) {
		throw new Error('route(): `cache.ttl` must be a positive number of seconds');
	}
	const hasOwnSerializer = 'serializer' in opts;

	return async (event) => {
		const container = event.locals.container;
		// Resolved per request so boot({ serializer }) applies regardless of
		// module evaluation order.
		const serializer = hasOwnSerializer ? opts.serializer : defaultSerializer;

		const cacheable = cache !== undefined && (event.request.method === 'GET' || event.request.method === 'HEAD');
		const edge = cacheable && !cache.private ? edgeCache(event) : null;
		const key = edge ? cacheKey(event, cache) : null;
		if (edge && key) {
			const hit = await edge.match(key).catch(() => undefined);
			if (hit) return conditional(withHeader(hit, 'x-norns-cache', 'hit'), event.request);
		}

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

		let response;
		if (result instanceof Response) response = result;
		else if (serializer?.serialize) {
			const r = serializer.serialize(result ?? null, event);
			response = r instanceof Response ? r : json(result ?? null);
		} else response = json(result ?? null);

		if (!cacheable || response.status !== 200) return response;

		response = await withCacheHeaders(response, cache);
		if (edge && key) {
			const put = edge.put(key, response.clone()).catch(() => {});
			const ctx = event.platform?.context;
			if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
			else await put;
		}
		return conditional(withHeader(response, 'x-norns-cache', 'miss'), event.request);
	};
}

/**
 * Read and decode the request body based on its content-type. Returns `null`
 * for empty bodies or unsupported types — the schema is then free to reject
 * (or accept `null`). Shared by `route()` and `page.actions()`, so a
 * serializer's `parseBody` (e.g. TRON) applies to both.
 *
 * @param {Request} request
 * @param {Serializer | null} [serializer]
 * @returns {Promise<any>}
 */
export async function readBody(request, serializer) {
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

// ---------------------------------------------------------------- caching

/**
 * The Workers edge cache when running on Cloudflare (`platform.caches` is
 * populated by adapter-cloudflare, in dev through the platform proxy). Null
 * elsewhere — the HTTP headers alone still give browser + CDN caching.
 *
 * @param {RequestEvent} event
 * @returns {{ match: (k: Request) => Promise<Response | undefined>, put: (k: Request, r: Response) => Promise<void> } | null}
 */
function edgeCache(event) {
	const store = /** @type {any} */ (event.platform)?.caches?.default;
	return store && typeof store.match === 'function' && typeof store.put === 'function' ? store : null;
}

/**
 * Cache API keys are GET Requests keyed by URL only, so the varying headers
 * are folded into a synthetic query parameter.
 *
 * @param {RequestEvent} event
 * @param {RouteCache} cache
 */
function cacheKey(event, cache) {
	const vary = cache.vary ?? ['accept'];
	const url = new URL(event.url);
	const parts = vary.map((h) => `${h.toLowerCase()}=${(event.request.headers.get(h) ?? '').trim().toLowerCase()}`);
	if (parts.length) url.searchParams.set('__norns_vary', parts.join('&'));
	try {
		return new Request(url.toString(), { method: 'GET' });
	} catch {
		return null;
	}
}

/**
 * Materialize the body once so both the ETag and the stored copy come from
 * the same bytes.
 *
 * @param {Response} response
 * @param {RouteCache} cache
 */
async function withCacheHeaders(response, cache) {
	const body = await response.text();
	const headers = new Headers(response.headers);
	headers.set('cache-control', `${cache.private ? 'private' : 'public'}, max-age=${Math.floor(cache.ttl)}`);
	headers.set('etag', `"${fnv1a(body)}"`);
	const vary = cache.vary ?? ['accept'];
	if (vary.length) headers.set('vary', vary.join(', '));
	return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * @param {Response} response
 * @param {string} name
 * @param {string} value
 */
function withHeader(response, name, value) {
	const headers = new Headers(response.headers);
	headers.set(name, value);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Answer `If-None-Match` with an empty 304 when the ETag still matches.
 *
 * @param {Response} response
 * @param {Request} request
 */
function conditional(response, request) {
	const etag = response.headers.get('etag');
	const inm = request.headers.get('if-none-match');
	if (!etag || !inm) return response;
	const tags = inm.split(',').map((t) => t.trim().replace(/^W\//, ''));
	if (!tags.includes(etag) && !tags.includes('*')) return response;
	const headers = new Headers();
	for (const h of ['etag', 'cache-control', 'vary', 'x-norns-cache']) {
		const v = response.headers.get(h);
		if (v) headers.set(h, v);
	}
	return new Response(null, { status: 304, headers });
}

/**
 * 32-bit FNV-1a over UTF-16 code units — cheap, dependency-free, good enough
 * for a validator (not for security).
 *
 * @param {string} s
 */
function fnv1a(s) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0') + s.length.toString(16);
}
