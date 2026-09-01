import { publishRefresh } from './live.js';

/**
 * Event bus behind `container.resolve('events')` — the target of generated
 * `emit` steps and spec triggers.
 *
 * Local mode (default): `emit` dispatches in-process, awaiting every matching
 * handler. Queue mode (`{ queue }` — a Cloudflare Queues producer binding):
 * `emit` enqueues `{ name, payload }` and delivery happens in the consumer
 * Worker, whose queue handler calls `events.consumer()` on an instance with
 * the same handlers registered.
 *
 * `on(name)` matches exact names; `on('*')` sees everything.
 *
 * @param {{ queue?: { send(body: *): Promise<void> | void } }} [opts]
 */
export function createEvents({ queue } = {}) {
	/** @type {Map<string, Set<(payload: *, name: string) => *>>} */
	const handlers = new Map();

	async function dispatch(name, payload) {
		const matched = [...(handlers.get(name) ?? []), ...(handlers.get('*') ?? [])];
		for (const fn of matched) await fn(payload, name);
		return matched.length;
	}

	return {
		on(name, fn) {
			if (!handlers.has(name)) handlers.set(name, new Set());
			handlers.get(name).add(fn);
			return () => handlers.get(name)?.delete(fn);
		},

		async emit(name, payload) {
			if (queue) return queue.send({ name, payload });
			return dispatch(name, payload);
		},

		/** Consumer-side delivery, bypassing the queue. */
		dispatch,

		/**
		 * Cloudflare Queues batch handler: `queue(batch) { return events.consumer()(batch) }`.
		 * Acks per message; a throwing handler retries that message only.
		 */
		consumer() {
			return async (batch) => {
				for (const msg of batch.messages) {
					try {
						await dispatch(msg.body.name, msg.body.payload);
						msg.ack?.();
					} catch {
						msg.retry?.();
					}
				}
			};
		}
	};
}

/**
 * Wire generated trigger tables (`[{ on, action }]`) into the bus. The
 * payload convention matches emitted `emit` steps: `{ row, input, user }`;
 * actions fall back to `{ id: row.id }` input when the event carries none.
 *
 * @param {*} container
 * @param {{ on: string, action: { run(ctx: *): * } }[]} triggers
 * @returns {() => void} unsubscribe-all
 */
export function registerTriggers(container, triggers) {
	const events = container.resolve('events');
	const offs = triggers.map(({ on, action }) =>
		events.on(on, async (payload = {}) => {
			const result = await action.run({
				input: payload.input ?? (payload.row ? { id: payload.row.id } : {}),
				container,
				user: payload.user
			});
			await publishRefresh(container, action.refresh);
			return result;
		})
	);
	return () => {
		for (const off of offs) off();
	};
}
