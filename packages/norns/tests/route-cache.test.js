import { describe, test, expect } from 'bun:test';
import { route } from '../src/server/route.js';
import { createApp } from '../src/server/boot.js';

function makeEvent(path, { method = 'GET', headers = {}, platform } = {}) {
	const url = new URL(`http://localhost${path}`);
	return {
		request: new Request(url, { method, headers }),
		url,
		params: {},
		route: { id: path },
		locals: { container: createApp().scope() },
		cookies: { get: () => undefined, set: () => {}, delete: () => {}, serialize: () => '' },
		fetch: globalThis.fetch,
		getClientAddress: () => '127.0.0.1',
		platform,
		isDataRequest: false,
		isSubRequest: false,
		setHeaders: () => {}
	};
}

/** Minimal stand-in for the Workers Cache API (`caches.default`). */
function fakeCache() {
	const store = new Map();
	return {
		store,
		async match(req) {
			const hit = store.get(req.url);
			return hit ? hit.clone() : undefined;
		},
		async put(req, res) {
			store.set(req.url, res);
		}
	};
}

describe('route({ cache })', () => {
	test('sets Cache-Control, ETag and Vary on GET responses', async () => {
		const handler = route({ cache: { ttl: 30 }, handler: () => ({ rows: [1, 2, 3] }) });
		const res = await handler(makeEvent('/api/x'));
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('public, max-age=30');
		expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/);
		expect(res.headers.get('vary')).toBe('accept');
		expect(res.headers.get('x-norns-cache')).toBe('miss');
		expect(await res.json()).toEqual({ rows: [1, 2, 3] });
	});

	test('answers a matching If-None-Match with an empty 304', async () => {
		const handler = route({ cache: { ttl: 30 }, handler: () => ({ rows: [1, 2, 3] }) });
		const first = await handler(makeEvent('/api/x'));
		const etag = first.headers.get('etag');
		const second = await handler(makeEvent('/api/x', { headers: { 'if-none-match': etag } }));
		expect(second.status).toBe(304);
		expect(await second.text()).toBe('');
		expect(second.headers.get('etag')).toBe(etag);
		const stale = await handler(makeEvent('/api/x', { headers: { 'if-none-match': '"nope"' } }));
		expect(stale.status).toBe(200);
	});

	test('private caches skip the shared store and say so in Cache-Control', async () => {
		const caches = { default: fakeCache() };
		const handler = route({ cache: { ttl: 5, private: true }, handler: () => ({ me: 1 }) });
		const res = await handler(makeEvent('/api/me', { platform: { caches } }));
		expect(res.headers.get('cache-control')).toBe('private, max-age=5');
		expect(caches.default.store.size).toBe(0);
	});

	test('does not cache POST or non-200 responses', async () => {
		let calls = 0;
		const handler = route({
			cache: { ttl: 30 },
			handler: () => {
				calls++;
				return new Response('made', { status: 201 });
			}
		});
		const post = await handler(makeEvent('/api/x', { method: 'POST' }));
		expect(post.headers.get('cache-control')).toBeNull();
		const created = await handler(makeEvent('/api/x'));
		expect(created.status).toBe(201);
		expect(created.headers.get('cache-control')).toBeNull();
		expect(calls).toBe(2);
	});

	test('uses the platform edge cache: handler and serializer run once per TTL, keyed by Accept', async () => {
		const caches = { default: fakeCache() };
		let calls = 0;
		let waited = 0;
		const platform = { caches, context: { waitUntil: (p) => { waited++; return p; } } };
		const serializer = {
			serialize(result, event) {
				if (!event.request.headers.get('accept')?.includes('text/custom')) return null;
				return new Response('custom:' + JSON.stringify(result), { headers: { 'content-type': 'text/custom' } });
			}
		};
		const handler = route({
			cache: { ttl: 60 },
			serializer,
			handler: () => ({ n: ++calls })
		});

		const a = await handler(makeEvent('/api/x', { platform }));
		expect(a.headers.get('x-norns-cache')).toBe('miss');
		expect(await a.json()).toEqual({ n: 1 });
		expect(waited).toBe(1);

		const b = await handler(makeEvent('/api/x', { platform }));
		expect(b.headers.get('x-norns-cache')).toBe('hit');
		expect(await b.json()).toEqual({ n: 1 }); // handler did not run again
		expect(calls).toBe(1);

		// A different Accept is a different cache entry (and a different body).
		const c = await handler(makeEvent('/api/x', { platform, headers: { accept: 'text/custom' } }));
		expect(c.headers.get('x-norns-cache')).toBe('miss');
		expect(await c.text()).toBe('custom:{"n":2}');
		expect(caches.default.store.size).toBe(2);

		// Conditional requests are honoured on hits too.
		const d = await handler(makeEvent('/api/x', { platform, headers: { 'if-none-match': a.headers.get('etag') } }));
		expect(d.status).toBe(304);
		expect(d.headers.get('x-norns-cache')).toBe('hit');
	});

	test('rejects a missing or invalid ttl at construction', () => {
		expect(() => route({ cache: {}, handler: () => null })).toThrow(/cache\.ttl/);
		expect(() => route({ cache: { ttl: 0 }, handler: () => null })).toThrow(/cache\.ttl/);
	});
});
