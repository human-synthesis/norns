/**
 * Set the app-wide response serializer used by every route() that doesn't
 * declare its own (e.g. tronSerializer() from @human-synthesis/norns-tron).
 * Pass null to go back to plain JSON. Usually wired via boot({ serializer }).
 *
 * @param {Serializer | null} serializer
 */
export function setSerializer(serializer: Serializer | null): void;
/** @returns {Serializer | null} */
export function getSerializer(): Serializer | null;
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
export function route(opts: RouteOptions): (event: RequestEvent) => Promise<Response>;
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
export function readBody(request: Request, serializer?: Serializer | null): Promise<any>;
export type RequestEvent = import("@sveltejs/kit").RequestEvent;
export type Container = import("./container.js").Container;
export type RouteContext = {
    /**
     * parsed body (after validation)
     */
    input: any;
    /**
     * parsed query (after validation)
     */
    query: any;
    /**
     * request-scoped container
     */
    container: Container;
    /**
     * raw SvelteKit event
     */
    event: RequestEvent;
    /**
     * shortcut for `event.locals.user`
     */
    user: any;
};
export type Serializer = {
    /**
     *   turn the handler's return value into a Response, or return null to fall
     *   through to the default JSON serialization
     */
    serialize: (result: any, event: RequestEvent) => Response | null;
    /**
     * read a request body for a content type route() doesn't handle natively;
     * return undefined to fall through to the built-in JSON/form readers
     */
    parseBody?: (request: Request, contentType: string) => Promise<any> | undefined;
};
export type RouteCache = {
    /**
     * seconds a GET response may be reused
     */
    ttl: number;
    /**
     * emit `Cache-Control: private` (per-user data)
     * instead of `public`; also skips the shared edge cache
     */
    private?: boolean;
    /**
     * request headers the cached body depends on;
     * default `['accept']` so JSON and TRON variants never mix
     */
    vary?: string[];
};
export type RouteOptions = {
    /**
     * body schema (Standard Schema or function)
     */
    input?: any;
    /**
     * query schema (Standard Schema or function)
     */
    query?: any;
    /**
     * per-route serializer; null forces
     * plain JSON even when an app-wide serializer is set
     */
    serializer?: Serializer | null;
    /**
     * GET/HEAD response caching: sets
     * `Cache-Control` + `ETag`, answers `If-None-Match` with 304, and on
     * Cloudflare Workers (`event.platform.caches`) also stores the encoded body
     * in the edge cache so the handler and the serializer run once per TTL
     */
    cache?: RouteCache;
    handler: (ctx: RouteContext) => any | Promise<any>;
};
