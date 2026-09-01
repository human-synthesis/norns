import { describe, test, expect } from 'bun:test';
import { liveQueries, remoteCall, dependsKey } from '../src/live-client.js';

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
