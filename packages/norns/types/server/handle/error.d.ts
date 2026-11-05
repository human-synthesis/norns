/** @typedef {import('@sveltejs/kit/hooks').HandleServerError} HandleServerError */
/**
 * Default `handleError` implementation: logs unexpected (`kind: 'unknown'`)
 * errors with request context and keeps SvelteKit's default client payload.
 * Expected `error(...)` throws, framework errors (404s) and validation errors
 * pass through unlogged.
 *
 * Apps can wrap this or replace it via `boot({ handleError: custom })`.
 *
 * @param {{ logger?: { error: (msg: string, err: unknown) => void } }} [opts]
 * @returns {HandleServerError}
 */
export function errorHandle(opts?: {
    logger?: {
        error: (msg: string, err: unknown) => void;
    };
}): HandleServerError;
export type HandleServerError = import("@sveltejs/kit/hooks").HandleServerError;
