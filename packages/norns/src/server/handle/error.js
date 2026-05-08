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
export function errorHandle(opts = {}) {
	const log = opts.logger ?? { error: (msg, err) => console.error(msg, err) };
	return ({ error, event, status, message }) => {
		log.error(`[norns] ${event.request.method} ${event.url.pathname} ${status}`, error);
		return { message: message || 'Internal error' };
	};
}
