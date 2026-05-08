import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request async context. Used to make `event.locals.container` (and the
 * scoped `db`, `user`) implicitly available to callees that don't get the
 * SvelteKit `event` passed in.
 *
 * On Cloudflare Workers, requires the `nodejs_als` + `nodejs_compat` compat
 * flags in `wrangler.toml`.
 *
 * @template T
 */

/** @typedef {{ container: import('./container.js').Container, [key: string]: any }} RequestScope */

/** @type {AsyncLocalStorage<RequestScope>} */
const storage = new AsyncLocalStorage();

/**
 * Run `fn` with `scope` as the current request scope.
 *
 * @template T
 * @param {RequestScope} scope
 * @param {() => T | Promise<T>} fn
 * @returns {T | Promise<T>}
 */
export function withScope(scope, fn) {
	return storage.run(scope, fn);
}

/**
 * Get the current request scope. Returns `undefined` outside a request.
 *
 * @returns {RequestScope | undefined}
 */
export function getScope() {
	return storage.getStore();
}

/**
 * Get the current request-scoped container, or throw if called outside a
 * request.
 *
 * @returns {import('./container.js').Container}
 */
export function getContainer() {
	const scope = storage.getStore();
	if (!scope) throw new Error('getContainer() called outside a request scope');
	return scope.container;
}
