import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Room, roomStub } from '../src/server/room.js';

/* Minimal workerd-shaped WebSocketPair: two linked fake sockets. */
class FakeSocket {
	constructor() {
		this.sent = [];
		this.listeners = new Map();
		this.peer = null;
	}
	accept() {}
	send(payload) {
		this.sent.push(payload);
	}
	addEventListener(name, fn) {
		if (!this.listeners.has(name)) this.listeners.set(name, []);
		this.listeners.get(name).push(fn);
	}
	fire(name, event) {
		for (const fn of this.listeners.get(name) ?? []) fn(event);
	}
}

function fakePair() {
	const a = new FakeSocket();
	const b = new FakeSocket();
	a.peer = b;
	b.peer = a;
	return { 0: a, 1: b };
}

const hadPair = 'WebSocketPair' in globalThis;
beforeAll(() => {
	if (!hadPair) globalThis.WebSocketPair = function () { return fakePair(); };
});
afterAll(() => {
	if (!hadPair) delete globalThis.WebSocketPair;
});

const req = (path, init) => new Request(`https://room.local${path}`, init);

async function readFrames(response, count) {
	const reader = response.body.getReader();
	const dec = new TextDecoder();
	let text = '';
	while (text.split('\n\n').filter(Boolean).length < count) {
		const { value, done } = await reader.read();
		if (done) break;
		text += dec.decode(value);
	}
	reader.releaseLock();
	return text.split('\n\n').filter(Boolean);
}

describe('Room (R-08)', () => {
	test('ws connect + broadcast reaches the socket', async () => {
		const room = new Room({}, {});
		room.tickMs = 0;
		const res = await room.fetch(req('/ws'));
		expect(res.status).toBe(101);
		expect(room.clients).toBe(1);
		const server = [...room.sockets][0];

		room.broadcast({ hello: true });
		expect(server.sent).toEqual([JSON.stringify({ hello: true })]);

		server.fire('close');
		expect(room.clients).toBe(0);
	});

	test('incoming ws messages go to onMessage', async () => {
		const got = [];
		class Echo extends Room {
			async onMessage(data) {
				got.push(data);
				this.broadcast({ echo: data });
			}
		}
		const room = new Echo({}, {});
		room.tickMs = 0;
		await room.fetch(req('/ws'));
		const server = [...room.sockets][0];
		server.fire('message', { data: 'hi' });
		await Bun.sleep(0);
		expect(got).toEqual(['hi']);
		expect(server.sent).toEqual([JSON.stringify({ echo: 'hi' })]);
	});

	test('sse stream gets connected comment, snapshot, and broadcasts', async () => {
		class Snap extends Room {
			snapshot() {
				return { state: 'initial' };
			}
		}
		const room = new Snap({}, {});
		room.tickMs = 0;
		const res = await room.fetch(req('/sse'));
		expect(res.headers.get('content-type')).toBe('text/event-stream');

		room.broadcast({ n: 1 });
		const frames = await readFrames(res, 3);
		expect(frames[0]).toBe(': connected');
		expect(frames[1]).toBe(`data: ${JSON.stringify({ state: 'initial' })}`);
		expect(frames[2]).toBe(`data: ${JSON.stringify({ n: 1 })}`);
	});

	test('POST /publish broadcasts the body and reports client count', async () => {
		const room = new Room({}, {});
		room.tickMs = 0;
		await room.fetch(req('/ws'));
		const server = [...room.sockets][0];

		const res = await room.fetch(
			req('/publish', {
				method: 'POST',
				body: JSON.stringify({ queries: ['orders.Query.board'] }),
				headers: { 'content-type': 'application/json' }
			})
		);
		expect(await res.json()).toEqual({ ok: true, clients: 1 });
		expect(JSON.parse(server.sent[0])).toEqual({ queries: ['orders.Query.board'] });
	});

	test('POST /publish with a non-JSON body is a 400', async () => {
		const room = new Room({}, {});
		room.tickMs = 0;
		const res = await room.fetch(req('/publish', { method: 'POST', body: 'not json' }));
		expect(res.status).toBe(400);
	});

	test('ticks run only while clients are connected; persistEvery fires persist', async () => {
		let persisted = 0;
		let ticked = 0;
		class Game extends Room {
			tickMs = 5;
			persistEvery = 2;
			async onTick() {
				ticked += 1;
			}
			async persist() {
				persisted += 1;
			}
		}
		const room = new Game({}, {});
		expect(room.timer).toBe(null);

		await room.fetch(req('/ws'));
		expect(room.timer).not.toBe(null);
		await Bun.sleep(30);
		expect(ticked).toBeGreaterThanOrEqual(2);
		expect(persisted).toBeGreaterThanOrEqual(1);

		const before = persisted;
		const server = [...room.sockets][0];
		server.fire('close');
		expect(room.timer).toBe(null);
		await Bun.sleep(0);
		// one final persist on last-client leave
		expect(persisted).toBe(before + 1);
		const settled = ticked;
		await Bun.sleep(20);
		expect(ticked).toBe(settled);
	});

	test('default route reports clients and ticks', async () => {
		const room = new Room({}, {});
		room.tickMs = 0;
		const res = await room.fetch(req('/anything'));
		expect(await res.json()).toEqual({ clients: 0, ticks: 0 });
	});

	test('presence joins/leaves broadcast debounced { type: presence } frames (R-16)', async () => {
		const room = new Room({}, {});
		room.tickMs = 0;
		room.presenceMs = 5;
		const frames = [];
		room.broadcast = (message) => {
			frames.push(message);
			return room.clients;
		};

		await room.fetch(req('/ws'));
		await room.fetch(req('/ws'));
		await Bun.sleep(15);
		// two joins inside one debounce window collapse into one frame
		expect(frames).toEqual([{ type: 'presence', clients: 2 }]);

		[...room.sockets][0].fire('close');
		await Bun.sleep(15);
		expect(frames).toEqual([
			{ type: 'presence', clients: 2 },
			{ type: 'presence', clients: 1 }
		]);
	});

	test('presence stays silent when presenceMs is 0', async () => {
		const room = new Room({}, {});
		room.tickMs = 0;
		const frames = [];
		room.broadcast = (message) => {
			frames.push(message);
			return room.clients;
		};
		await room.fetch(req('/ws'));
		await Bun.sleep(10);
		expect(frames).toEqual([]);
	});

	test('roomStub resolves idFromName through the namespace', () => {
		const calls = [];
		const ns = {
			idFromName: (name) => {
				calls.push(name);
				return `id:${name}`;
			},
			get: (id) => ({ id })
		};
		expect(roomStub(ns, 'live')).toEqual({ id: 'id:live' });
		expect(roomStub(ns)).toEqual({ id: 'id:default' });
		expect(calls).toEqual(['live', 'default']);
	});
});
