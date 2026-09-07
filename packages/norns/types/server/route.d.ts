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
export function route(opts: RouteOptions): (event: RequestEvent) => Promise<Response>;
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
    handler: (ctx: RouteContext) => any | Promise<any>;
};
