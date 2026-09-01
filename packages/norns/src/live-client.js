/**
 * Browser side of the live-query bridge (R-11). Generated pages with
 * `live: true` queries call `liveQueries` from an `$effect`; the server
 * counterpart streams refresh signals from `/_norns/live` (see
 * `src/server/live.js`).
 *
 * No SvelteKit import here — the caller passes `invalidate` from
 * `$app/navigation` so this module stays framework-neutral and testable.
 */

/** SvelteKit `depends`/`invalidate` key for a query address. */
export const dependsKey = (address) => `norns:${address}`;

/**
 * Subscribe to refresh signals and invalidate the given query addresses
 * when they change. Returns a cleanup function (safe for `$effect`).
 *
 * @param {string[]} addresses query addresses this page depends on
 * @param {(key: string) => *} invalidate `invalidate` from `$app/navigation`
 * @param {{ path?: string, EventSource?: typeof EventSource }} [opts]
 * @returns {() => void}
 */
export function liveQueries(addresses, invalidate, opts = {}) {
	const ES = opts.EventSource ?? globalThis.EventSource;
	if (typeof ES !== 'function') return () => {};

	const wanted = new Set(addresses);
	const source = new ES(opts.path ?? '/_norns/live');
	source.onmessage = (e) => {
		let payload;
		try {
			payload = JSON.parse(e.data);
		} catch {
			return;
		}
		for (const address of Array.isArray(payload?.queries) ? payload.queries : []) {
			if (wanted.has(address)) invalidate(dependsKey(address));
		}
	};
	return () => source.close();
}

/**
 * Call a `transport: remote` action endpoint
 * (`module.Action.name` → POST `/api/<module>/<name>`).
 *
 * @param {string} address action address
 * @param {*} [input]
 * @param {{ fetch?: typeof fetch }} [opts]
 */
export async function remoteCall(address, input, opts = {}) {
	const parts = String(address).split('.');
	if (parts.length !== 3 || parts[1] !== 'Action') {
		throw new Error(`remoteCall: "${address}" is not an Action address`);
	}
	const f = opts.fetch ?? globalThis.fetch;
	const res = await f(`/api/${parts[0]}/${parts[2]}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input ?? {})
	});
	if (!res.ok) {
		let detail = '';
		try {
			detail = (await res.json())?.message ?? '';
		} catch {
			/* body may not be JSON */
		}
		throw new Error(`remoteCall ${address}: ${res.status}${detail ? ` — ${detail}` : ''}`);
	}
	return res.json();
}
