/** @typedef {import('@sveltejs/kit').HandleServerError} HandleServerError */
/**
 * Default `handleError` implementation: logs the error with request context
 * and returns a safe payload for the client.
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
export type HandleServerError = import("@sveltejs/kit").HandleServerError;
