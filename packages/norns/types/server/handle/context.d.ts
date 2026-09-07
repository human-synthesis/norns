/** @typedef {import('../container.js').Container} Container */
/** @typedef {import('@sveltejs/kit').Handle} Handle */
/**
 * Per-request middleware: creates a child scope of the root container and
 * attaches it to `event.locals.container`. Anything resolved through
 * `event.locals.container` for the lifetime of the request hits this scope —
 * overrides and request-scoped singletons (like `db`) live here.
 *
 * Also runs the rest of the pipeline inside `withScope()` so AsyncLocalStorage
 * makes the scope available to callees that don't get `event` directly.
 *
 * @param {Container} app the root container produced by `createApp()`/`boot()`
 * @returns {Handle}
 */
export function contextHandle(app: Container): Handle;
export type Container = import("../container.js").Container;
export type Handle = import("@sveltejs/kit").Handle;
