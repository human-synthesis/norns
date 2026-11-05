/** @typedef {import('@sveltejs/kit/hooks').HandleServerError} HandleServerError */

/**
 * Default `handleError` implementation: logs unexpected errors with request
 * context and lets SvelteKit build the safe client payload.
 *
 * SvelteKit 3 calls `handleError` for every error, not just unexpected ones.
 * Only `kind: 'unknown'` errors (thrown by app code or code it calls) are
 * logged; `error(...)` throws, framework errors such as 404s and validation
 * errors pass through untouched. Returning nothing keeps SvelteKit's
 * defaults: the `error(...)` body, the framework status and message, or
 * `500` / `'Internal Error'` for unknown errors.
 *
 * Apps can wrap this or replace it via `boot({ handleError: custom })`.
 *
 * @param {{ logger?: { error: (msg: string, err: unknown) => void } }} [opts]
 * @returns {HandleServerError}
 */
export function errorHandle(opts = {}) {
	const log = opts.logger ?? { error: (msg, err) => console.error(msg, err) };
	return (input) => {
		if (input.kind !== 'unknown') return;
		const { error, event } = input;
		log.error(`[norns] ${event.request.method} ${event.url.pathname} 500`, error);
	};
}
