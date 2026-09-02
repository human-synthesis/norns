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
 * Read a streaming Endpoint (K-23 typed SSE frames) as an async iterator
 * (R-16). Backpressure-aware — the response body is only pulled when the
 * consumer asks for the next frame — and abortable: breaking out of the
 * loop (or firing `opts.signal`) aborts the underlying request.
 *
 *   for await (const frame of streamSource('/api/chat', { input: { prompt } }))
 *     text += frame.delta
 *
 * @param {string} url the Endpoint's declared route
 * @param {{ input?: *, method?: string, signal?: AbortSignal, fetch?: typeof fetch }} [opts]
 *   `input` is sent as a JSON POST body (streaming endpoints take their
 *   input up front); omit it for GET-style streams.
 * @returns {AsyncGenerator<*>} parsed `data:` frames (JSON when possible)
 */
export async function* streamSource(url, opts = {}) {
	const f = opts.fetch ?? globalThis.fetch;
	const controller = new AbortController();
	const abort = () => controller.abort();
	opts.signal?.addEventListener('abort', abort, { once: true });

	const hasInput = opts.input !== undefined;
	const res = await f(url, {
		method: opts.method ?? (hasInput ? 'POST' : 'GET'),
		headers: {
			accept: 'text/event-stream',
			...(hasInput ? { 'content-type': 'application/json' } : {})
		},
		body: hasInput ? JSON.stringify(opts.input) : undefined,
		signal: controller.signal
	});
	if (!res.ok || !res.body) {
		throw new Error(`streamSource ${url}: ${res.status}${res.body ? '' : ' — no body'}`);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let cut;
			while ((cut = buffer.indexOf('\n\n')) !== -1) {
				const event = buffer.slice(0, cut);
				buffer = buffer.slice(cut + 2);
				const data = event
					.split('\n')
					.filter((line) => line.startsWith('data:'))
					.map((line) => line.slice(5).replace(/^ /, ''))
					.join('\n');
				if (data === '') continue;
				try {
					yield JSON.parse(data);
				} catch {
					yield data;
				}
			}
		}
	} finally {
		opts.signal?.removeEventListener('abort', abort);
		controller.abort();
	}
}

/**
 * Connect to a Room over WebSocket with reconnect/backoff (R-16). Frames
 * are the `{ type, ...payload }` envelope the Room contract declares in
 * `messages`; `send(type, payload)` queues while disconnected and flushes
 * on (re)connect. Reconnects use exponential backoff with jitter and stop
 * after `close()`.
 *
 * @param {string} name room address (`module.Worker.name`), used to build
 *   the default path `/_norns/room/<name>/ws`
 * @param {{ path?: string, WebSocket?: typeof WebSocket, backoffMs?: number,
 *   maxBackoffMs?: number }} [opts]
 * @returns {{ send(type: string, payload?: object): void,
 *   on(type: string, fn: (frame: *) => void): () => void, close(): void }}
 *   `on('*', fn)` receives every frame; other types match `frame.type`.
 */
export function roomChannel(name, opts = {}) {
	const WS = opts.WebSocket ?? globalThis.WebSocket;
	const path = opts.path ?? `/_norns/room/${encodeURIComponent(name)}/ws`;
	const handlers = new Map();
	const queue = [];
	let socket = null;
	let timer = null;
	let attempts = 0;
	let closed = typeof WS !== 'function'; // SSR-safe: stay inert without a WebSocket

	const backoff = () => {
		const capped = Math.min(opts.maxBackoffMs ?? 15_000, (opts.backoffMs ?? 500) * 2 ** attempts);
		return capped / 2 + Math.random() * (capped / 2);
	};

	const connect = () => {
		if (closed) return;
		socket = new WS(path);
		socket.onopen = () => {
			attempts = 0;
			while (queue.length > 0) socket.send(queue.shift());
		};
		socket.onmessage = (e) => {
			let frame;
			try {
				frame = JSON.parse(e.data);
			} catch {
				return;
			}
			for (const fn of handlers.get(frame?.type) ?? []) fn(frame);
			for (const fn of handlers.get('*') ?? []) fn(frame);
		};
		socket.onclose = () => {
			socket = null;
			if (closed) return;
			timer = setTimeout(connect, backoff());
			attempts += 1;
		};
		socket.onerror = () => socket?.close?.();
	};
	connect();

	return {
		send(type, payload) {
			const message = JSON.stringify({ type, ...(payload ?? {}) });
			if (socket?.readyState === 1) socket.send(message);
			else queue.push(message);
		},
		on(type, fn) {
			const set = handlers.get(type) ?? new Set();
			set.add(fn);
			handlers.set(type, set);
			return () => set.delete(fn);
		},
		close() {
			closed = true;
			clearTimeout(timer);
			socket?.close?.();
			socket = null;
		}
	};
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
