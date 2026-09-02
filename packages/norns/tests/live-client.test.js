import { describe, test, expect } from 'bun:test';
import { liveQueries, remoteCall, dependsKey, streamSource, roomChannel } from '../src/live-client.js';

class FakeEventSource {
	static instances = [];
	constructor(path) {
		this.path = path;
		this.closed = false;
		this.onmessage = null;
		FakeEventSource.instances.push(this);
	}
	close() {
		this.closed = true;
	}
	push(data) {
		this.onmessage?.({ data });
	}
}

describe('liveQueries', () => {
	test('invalidates matching addresses from refresh signals', () => {
		const invalidated = [];
		const stop = liveQueries(['orders.Query.board'], (key) => invalidated.push(key), {
			EventSource: FakeEventSource
		});
		const source = FakeEventSource.instances.at(-1);
		expect(source.path).toBe('/_norns/live');

		source.push(JSON.stringify({ queries: ['orders.Query.board', 'crm.Query.pipeline'] }));
		source.push(JSON.stringify({ queries: ['crm.Query.pipeline'] }));
		source.push('not json');
		expect(invalidated).toEqual(['norns:orders.Query.board']);

		stop();
		expect(source.closed).toBe(true);
	});

	test('no-ops without an EventSource implementation', () => {
		const stop = liveQueries(['a.Query.b'], () => {}, { EventSource: undefined });
		expect(typeof stop).toBe('function');
		stop();
	});

	test('honors a custom stream path', () => {
		liveQueries(['a.Query.b'], () => {}, { EventSource: FakeEventSource, path: '/custom' });
		expect(FakeEventSource.instances.at(-1).path).toBe('/custom');
	});

	test('dependsKey mirrors the server-side key', () => {
		expect(dependsKey('orders.Query.board')).toBe('norns:orders.Query.board');
	});
});

describe('remoteCall', () => {
	test('POSTs JSON to the action endpoint and returns the parsed body', async () => {
		const calls = [];
		const result = await remoteCall(
			'orders.Action.submit',
			{ id: 'o1' },
			{
				fetch: async (path, init) => {
					calls.push({ path, init });
					return Response.json({ ok: true });
				}
			}
		);
		expect(result).toEqual({ ok: true });
		expect(calls[0].path).toBe('/api/orders/submit');
		expect(calls[0].init.method).toBe('POST');
		expect(JSON.parse(calls[0].init.body)).toEqual({ id: 'o1' });
	});

	test('rejects non-Action addresses', async () => {
		await expect(remoteCall('orders.Query.board', {})).rejects.toThrow('not an Action address');
	});

	test('throws with status and message detail on error responses', async () => {
		const failing = async () => Response.json({ message: 'nope' }, { status: 403 });
		await expect(
			remoteCall('orders.Action.submit', {}, { fetch: failing })
		).rejects.toThrow('403 — nope');
	});
});

/** SSE Response from raw chunks, capturing the request for assertions. */
function sseFetch(chunks, seen = {}) {
	return async (url, init) => {
		seen.url = url;
		seen.init = init;
		const body = new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			}
		});
		return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
	};
}

describe('streamSource (R-16)', () => {
	test('POSTs the input and yields parsed frames across chunk boundaries', async () => {
		const seen = {};
		const frames = [];
		const source = streamSource('/api/chat', {
			input: { prompt: 'hi' },
			fetch: sseFetch(['data: {"delta":"he', 'llo"}\n\ndata: {"delta":" world"}\n\n'], seen)
		});
		for await (const frame of source) frames.push(frame);
		expect(frames).toEqual([{ delta: 'hello' }, { delta: ' world' }]);
		expect(seen.url).toBe('/api/chat');
		expect(seen.init.method).toBe('POST');
		expect(JSON.parse(seen.init.body)).toEqual({ prompt: 'hi' });
		expect(seen.init.headers.accept).toBe('text/event-stream');
	});

	test('skips comment frames, GETs without input, aborts when the consumer breaks', async () => {
		const seen = {};
		const frames = [];
		for await (const frame of streamSource('/api/feed', {
			fetch: sseFetch([': connected\n\ndata: {"n":1}\n\ndata: {"n":2}\n\n'], seen)
		})) {
			frames.push(frame);
			break;
		}
		expect(frames).toEqual([{ n: 1 }]);
		expect(seen.init.method).toBe('GET');
		expect(seen.init.body).toBeUndefined();
		expect(seen.init.signal.aborted).toBe(true);
	});

	test('throws on error responses', async () => {
		const failing = async () => new Response('nope', { status: 500 });
		await expect(streamSource('/api/chat', { fetch: failing }).next()).rejects.toThrow(
			'streamSource /api/chat: 500'
		);
	});
});

class FakeWebSocket {
	static instances = [];
	constructor(path) {
		this.path = path;
		this.readyState = 0;
		this.sent = [];
		FakeWebSocket.instances.push(this);
	}
	send(payload) {
		this.sent.push(payload);
	}
	close() {
		this.readyState = 3;
		this.onclose?.();
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	push(data) {
		this.onmessage?.({ data });
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('roomChannel (R-16)', () => {
	test('connects to the room path, queues sends until open, routes typed frames', () => {
		const channel = roomChannel('games.Worker.matchRoom', { WebSocket: FakeWebSocket });
		const socket = FakeWebSocket.instances.at(-1);
		expect(socket.path).toBe('/_norns/room/games.Worker.matchRoom/ws');

		channel.send('chat', { text: 'hi' });
		expect(socket.sent).toEqual([]);
		socket.open();
		expect(socket.sent).toEqual(['{"type":"chat","text":"hi"}']);
		channel.send('move', { square: 'e4' });
		expect(socket.sent).toHaveLength(2);

		const chats = [];
		const all = [];
		const offChat = channel.on('chat', (f) => chats.push(f));
		channel.on('*', (f) => all.push(f));
		socket.push('{"type":"chat","text":"yo","from":"ada"}');
		socket.push('{"type":"presence","clients":2}');
		socket.push('not json');
		expect(chats).toEqual([{ type: 'chat', text: 'yo', from: 'ada' }]);
		expect(all).toHaveLength(2);

		offChat();
		socket.push('{"type":"chat","text":"again"}');
		expect(chats).toHaveLength(1);
		channel.close();
	});

	test('reconnects with backoff after a drop and stops after close()', async () => {
		const channel = roomChannel('games.Worker.matchRoom', {
			WebSocket: FakeWebSocket,
			backoffMs: 1,
			maxBackoffMs: 2
		});
		const first = FakeWebSocket.instances.at(-1);
		first.open();
		first.close(); // dropped by the server
		await sleep(10);
		const second = FakeWebSocket.instances.at(-1);
		expect(second).not.toBe(first);

		second.open();
		channel.send('chat', { text: 'back' });
		expect(second.sent).toEqual(['{"type":"chat","text":"back"}']);

		const count = FakeWebSocket.instances.length;
		channel.close();
		await sleep(10);
		expect(FakeWebSocket.instances.length).toBe(count);
	});
});
