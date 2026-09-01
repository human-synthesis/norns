/**
 * Durable Object Room host (R-08) — one instance per room, holding live
 * connections and in-memory state between requests (validated by the R-13
 * spike on local workerd).
 *
 * Deploy shape: the app exports a DO class extending Room and binds it as
 * `ROOM` (emit-wrangler adds the binding when specs need it):
 *
 *   export class NornsRoom extends Room {}
 *
 * Paths served by `fetch`:
 *   /ws       WebSocket upgrade; incoming messages go to `onMessage`
 *   /sse      text/event-stream; every `broadcast` becomes a `data:` frame
 *   /publish  POST (worker-internal) — body is broadcast to every client
 *   anything else → `{ clients, ticks }` snapshot
 *
 * Subclass hooks: `onMessage(data, ws)`, `onTick()`, `persist()`,
 * `snapshot()` (first SSE frame for a new client), and the knobs `tickMs`
 * (0 disables ticks) / `persistEvery` (persist() every N ticks; also runs
 * once when the last client leaves). Ticks only run while clients are
 * connected.
 */

const ENC = new TextEncoder();

export class Room {
	tickMs = 1000;
	persistEvery = 0;

	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.sockets = new Set();
		this.streams = new Set();
		this.ticks = 0;
		this.timer = null;
	}

	/* -- subclass hooks ------------------------------------------------ */

	async onMessage(_data, _ws) {}
	async onTick() {}
	async persist() {}
	snapshot() {
		return null;
	}

	/* -- connections --------------------------------------------------- */

	get clients() {
		return this.sockets.size + this.streams.size;
	}

	/** Send to every connected client (WS + SSE). Returns the client count. */
	broadcast(message) {
		const payload = typeof message === 'string' ? message : JSON.stringify(message);
		for (const ws of this.sockets) {
			try {
				ws.send(payload);
			} catch {
				this.#leave(this.sockets, ws);
			}
		}
		const frame = ENC.encode(`data: ${payload}\n\n`);
		for (const writer of this.streams) {
			writer.write(frame).catch(() => this.#leave(this.streams, writer));
		}
		return this.clients;
	}

	#join(set, item) {
		set.add(item);
		if (this.timer === null && this.tickMs > 0) {
			this.timer = setInterval(() => this.#tick(), this.tickMs);
		}
	}

	#leave(set, item) {
		if (!set.delete(item)) return;
		if (this.clients === 0) {
			if (this.timer !== null) {
				clearInterval(this.timer);
				this.timer = null;
			}
			Promise.resolve(this.persist()).catch(() => {});
		}
	}

	async #tick() {
		this.ticks += 1;
		await this.onTick();
		if (this.persistEvery > 0 && this.ticks % this.persistEvery === 0) {
			await this.persist();
		}
	}

	/* -- request surface ------------------------------------------------ */

	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === '/ws') {
			if (typeof WebSocketPair === 'undefined') {
				return new Response('WebSocket unsupported on this runtime', { status: 501 });
			}
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);
			server.accept();
			this.#join(this.sockets, server);
			server.addEventListener('message', (e) => {
				Promise.resolve(this.onMessage(e.data, server)).catch(() => {});
			});
			server.addEventListener('close', () => this.#leave(this.sockets, server));
			return new Response(null, { status: 101, webSocket: client });
		}

		if (url.pathname === '/sse') {
			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			writer.write(ENC.encode(': connected\n\n')).catch(() => {});
			const first = this.snapshot();
			if (first !== null && first !== undefined) {
				writer.write(ENC.encode(`data: ${JSON.stringify(first)}\n\n`)).catch(() => {});
			}
			this.#join(this.streams, writer);
			request.signal?.addEventListener('abort', () => {
				this.#leave(this.streams, writer);
				writer.close().catch(() => {});
			});
			return new Response(readable, {
				headers: {
					'content-type': 'text/event-stream',
					'cache-control': 'no-cache',
					connection: 'keep-alive'
				}
			});
		}

		if (url.pathname === '/publish' && request.method === 'POST') {
			let body = null;
			try {
				body = await request.json();
			} catch {
				return Response.json({ ok: false, error: 'body must be JSON' }, { status: 400 });
			}
			const clients = this.broadcast(body ?? {});
			return Response.json({ ok: true, clients });
		}

		return Response.json({ clients: this.clients, ticks: this.ticks });
	}
}

/**
 * Resolve the DO stub for a named room on a namespace binding (`env.ROOM`).
 *
 * @param {{ idFromName(name: string): *, get(id: *): * }} namespace
 * @param {string} [name]
 */
export function roomStub(namespace, name = 'default') {
	return namespace.get(namespace.idFromName(name));
}
