import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';

import { Container } from '../src/server/container.js';
import { createEvents } from '../src/server/events.js';
import { registerTriggers } from '../src/server/events.js';
import { boot } from '../src/server/boot.js';
import { page } from '../src/server/page.js';
import {
	REFRESH_EVENT,
	dependsKey,
	createLive,
	publishRefresh,
	liveHandler,
	remoteAction
} from '../src/server/live.js';

const BOARD = 'orders.Query.board';

function withLive(events = createEvents(), room) {
	const container = new Container();
	container.single('events', () => events);
	container.single('live', () => createLive({ events, room }));
	return { container, events };
}

function fakeRoom() {
	const calls = [];
	return {
		calls,
		idFromName: (name) => `id:${name}`,
		get: (id) => ({
			fetch: async (input, init) => {
				calls.push({ id, input, init });
				return Response.json({ ok: true, clients: 2 });
			}
		})
	};
}

async function readUntil(response, count) {
	const reader = response.body.getReader();
	const dec = new TextDecoder();
	let text = '';
	while (text.split('\n\n').filter(Boolean).length < count) {
		const { value, done } = await reader.read();
		if (done) break;
		text += dec.decode(value);
	}
	return { frames: text.split('\n\n').filter(Boolean), reader };
}

describe('createLive (R-11)', () => {
	test('publish emits the refresh event on the bus', async () => {
		const events = createEvents();
		const got = [];
		events.on(REFRESH_EVENT, (payload) => got.push(payload));
		const live = createLive({ events });
		await live.publish([BOARD]);
		expect(got).toEqual([{ queries: [BOARD] }]);
	});

	test('publish is a no-op for empty or missing lists', async () => {
		const events = createEvents();
		const got = [];
		events.on(REFRESH_EVENT, (p) => got.push(p));
		const live = createLive({ events });
		await live.publish([]);
		await live.publish(undefined);
		expect(got).toEqual([]);
	});

	test('publish forwards to the Room DO when a namespace is bound', async () => {
		const room = fakeRoom();
		const live = createLive({ events: createEvents(), room });
		await live.publish([BOARD]);
		expect(room.calls).toHaveLength(1);
		expect(room.calls[0].id).toBe('id:live');
		expect(room.calls[0].input).toBe('https://room/publish');
		expect(JSON.parse(room.calls[0].init.body)).toEqual({ queries: [BOARD] });
	});

	test('handler streams refresh signals as SSE in dev mode', async () => {
		const events = createEvents();
		const live = createLive({ events, heartbeatMs: 60_000 });
		const res = live.handler({ request: new Request('https://app/_norns/live') });
		expect(res.headers.get('content-type')).toBe('text/event-stream');

		await live.publish([BOARD]);
		const { frames, reader } = await readUntil(res, 2);
		expect(frames[0]).toBe(': connected');
		expect(frames[1]).toBe(`data: ${JSON.stringify({ queries: [BOARD] })}`);
		await reader.cancel();
	});

	test('handler proxies to the Room DO when a namespace is bound', async () => {
		const room = fakeRoom();
		const live = createLive({ events: createEvents(), room });
		await live.handler({ request: new Request('https://app/_norns/live') });
		expect(room.calls[0].input).toBe('https://room/sse');
	});
});

describe('publishRefresh + liveHandler', () => {
	test('publishRefresh publishes through the bound live bridge', async () => {
		const { container, events } = withLive();
		const got = [];
		events.on(REFRESH_EVENT, (p) => got.push(p));
		await publishRefresh(container, [BOARD]);
		expect(got).toEqual([{ queries: [BOARD] }]);
	});

	test('publishRefresh no-ops without a live binding or refresh list', async () => {
		await publishRefresh(new Container(), [BOARD]);
		const { container, events } = withLive();
		const got = [];
		events.on(REFRESH_EVENT, (p) => got.push(p));
		await publishRefresh(container, []);
		expect(got).toEqual([]);
	});

	test('liveHandler 404s without a live bridge, streams with one', async () => {
		const bare = liveHandler({ locals: { container: new Container() } });
		expect(bare.status).toBe(404);

		const { container } = withLive();
		const res = liveHandler({
			locals: { container },
			request: new Request('https://app/_norns/live')
		});
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		await res.body.cancel();
	});

	test('dependsKey matches the generated depends()/invalidate() key', () => {
		expect(dependsKey(BOARD)).toBe('norns:orders.Query.board');
	});
});

describe('refresh publication from action surfaces', () => {
	const makeAction = (refresh) => ({
		input: v.strictObject({ id: v.string() }),
		refresh,
		run: async ({ input }) => ({ ok: true, id: input.id })
	});

	test('page.actions publishes the refresh list after a successful run', async () => {
		const { container, events } = withLive();
		const got = [];
		events.on(REFRESH_EVENT, (p) => got.push(p));

		const actions = page.actions({ submit: makeAction([BOARD]) });
		const form = new FormData();
		form.set('id', 'o1');
		const result = await actions.submit({
			request: new Request('https://app/orders', { method: 'POST', body: form }),
			locals: { container, user: null }
		});
		expect(result).toEqual({ ok: true, id: 'o1' });
		expect(got).toEqual([{ queries: [BOARD] }]);
	});

	test('page.actions does not publish when validation fails', async () => {
		const { container, events } = withLive();
		const got = [];
		events.on(REFRESH_EVENT, (p) => got.push(p));

		const actions = page.actions({ submit: makeAction([BOARD]) });
		const result = await actions.submit({
			request: new Request('https://app/orders', { method: 'POST', body: new FormData() }),
			locals: { container, user: null }
		});
		expect(result.status).toBe(400);
		expect(got).toEqual([]);
	});

	test('registerTriggers publishes an action refresh list after the trigger runs', async () => {
		const { container, events } = withLive();
		const got = [];
		events.on(REFRESH_EVENT, (p) => got.push(p));

		registerTriggers(container, [
			{ on: 'order.created', action: { refresh: [BOARD], run: async () => ({}) } }
		]);
		await events.emit('order.created', { row: { id: 'o1' } });
		expect(got).toEqual([{ queries: [BOARD] }]);
	});

	test('remoteAction serves POST JSON with validation and publishes refresh', async () => {
		const { container, events } = withLive();
		const got = [];
		events.on(REFRESH_EVENT, (p) => got.push(p));

		const POST = remoteAction(makeAction([BOARD]));
		const res = await POST({
			request: new Request('https://app/api/orders/submit', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: 'o2' })
			}),
			locals: { container, user: null },
			url: new URL('https://app/api/orders/submit')
		});
		expect(await res.json()).toEqual({ ok: true, id: 'o2' });
		expect(got).toEqual([{ queries: [BOARD] }]);
	});

	test('remoteAction rejects invalid input with 400 and no publish', async () => {
		const { container, events } = withLive();
		const got = [];
		events.on(REFRESH_EVENT, (p) => got.push(p));

		const POST = remoteAction(makeAction([BOARD]));
		let status = null;
		try {
			await POST({
				request: new Request('https://app/api/orders/submit', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ id: 42 })
				}),
				locals: { container, user: null },
				url: new URL('https://app/api/orders/submit')
			});
		} catch (e) {
			status = e.status;
		}
		expect(status).toBe(400);
		expect(got).toEqual([]);
	});
});

describe('boot wiring', () => {
	test('boot binds a live bridge singleton next to the event bus', async () => {
		const app = await boot({});
		expect(app.container.has('live')).toBe(true);
		const live = app.container.resolve('live');
		expect(typeof live.publish).toBe('function');
		expect(typeof live.handler).toBe('function');
	});
});
