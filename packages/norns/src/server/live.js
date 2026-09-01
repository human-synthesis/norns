/**
 * Live-query bridge (R-11) — publishes "these queries changed" signals to
 * connected clients so pages with `live: true` queries can re-run their
 * loads.
 *
 * Dev/local (single process): refresh signals ride the in-process event bus
 * and stream out of `/_norns/live` as SSE directly.
 *
 * Workers prod (many isolates): pass the `ROOM` Durable Object namespace as
 * `room` — publishes are forwarded to the Room instance (R-08) and the SSE
 * endpoint proxies to it, so every isolate's clients share one fanout point.
 *
 * The payload is only ever a list of query addresses — no row data crosses
 * the live channel; clients re-run their loads through the normal
 * policy-guarded path.
 */

import { route } from './route.js';

export const REFRESH_EVENT = 'norns:refresh';

/** SvelteKit `depends`/`invalidate` key for a query address. */
export const dependsKey = (address) => `norns:${address}`;

const ENC = new TextEncoder();

/**
 * @param {{
 *   events: { emit(name: string, payload: *): *, on(name: string, fn: (payload: *) => *): () => void },
 *   room?: { idFromName(name: string): *, get(id: *): { fetch(input: *, init?: *): Promise<Response> } },
 *   roomName?: string,
 *   heartbeatMs?: number
 * }} opts
 */
export function createLive({ events, room, roomName = 'live', heartbeatMs = 15000 }) {
	const stub = () => room.get(room.idFromName(roomName));

	return {
		/** Announce that these query addresses have (potentially) new data. */
		async publish(queries) {
			if (!Array.isArray(queries) || queries.length === 0) return;
			await events.emit(REFRESH_EVENT, { queries });
			if (room) {
				await stub().fetch('https://room/publish', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ queries })
				});
			}
		},

		/** @param {(payload: { queries: string[] }) => *} fn */
		subscribe(fn) {
			return events.on(REFRESH_EVENT, fn);
		},

		/** SSE handler for the `/_norns/live` endpoint. */
		handler(event) {
			if (room) {
				return stub().fetch('https://room/sse', { headers: event.request.headers });
			}
			let off = () => {};
			let timer;
			let open = true;
			const stream = new ReadableStream({
				start(controller) {
					const send = (text) => {
						if (!open) return;
						try {
							controller.enqueue(ENC.encode(text));
						} catch {
							open = false;
						}
					};
					send(': connected\n\n');
					off = events.on(REFRESH_EVENT, (payload) => send(`data: ${JSON.stringify(payload)}\n\n`));
					timer = setInterval(() => send(': ping\n\n'), heartbeatMs);
				},
				cancel() {
					open = false;
					off();
					clearInterval(timer);
				}
			});
			return new Response(stream, {
				headers: {
					'content-type': 'text/event-stream',
					'cache-control': 'no-cache',
					connection: 'keep-alive'
				}
			});
		}
	};
}

/**
 * Publish an action's refresh list through the container's live bridge, if
 * one is bound. Shared by form actions, remote actions, and triggers.
 */
export async function publishRefresh(container, refresh) {
	if (!Array.isArray(refresh) || refresh.length === 0) return;
	if (!container?.has?.('live')) return;
	await container.resolve('live').publish(refresh);
}

/**
 * Generated `/_norns/live/+server.c` GET handler — streams refresh signals
 * for the app booted into `event.locals.container`.
 */
export function liveHandler(event) {
	const container = event.locals?.container;
	if (!container?.has?.('live')) {
		return new Response('live bridge not enabled', { status: 404 });
	}
	return container.resolve('live').handler(event);
}

/**
 * Wrap a generated action unit as a `transport: remote` POST endpoint:
 * same schema validation and guarded `run` as the form-action path, plus
 * refresh publication, returned as JSON (or the app serializer).
 *
 * @param {{ input?: *, run(ctx: *): *, refresh?: string[] }} action
 */
export function remoteAction(action) {
	return route({
		input: action.input,
		handler: async ({ input, container, event, user }) => {
			const result = await action.run({ input, container, event, user });
			await publishRefresh(container, action.refresh);
			return result;
		}
	});
}
