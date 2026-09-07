/**
 * Run `fn` with `scope` as the current request scope.
 *
 * @template T
 * @param {RequestScope} scope
 * @param {() => T | Promise<T>} fn
 * @returns {T | Promise<T>}
 */
export function withScope<T_1>(scope: RequestScope, fn: () => T_1 | Promise<T_1>): T_1 | Promise<T_1>;
/**
 * Get the current request scope. Returns `undefined` outside a request.
 *
 * @returns {RequestScope | undefined}
 */
export function getScope(): RequestScope | undefined;
/**
 * Get the current request-scoped container, or throw if called outside a
 * request.
 *
 * @returns {import('./container.js').Container}
 */
export function getContainer(): import("./container.js").Container;
export type RequestScope = {
    container: import("./container.js").Container;
    [key: string]: any;
};
