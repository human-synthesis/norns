import { describe, expect, test } from 'bun:test';

import { createContainer } from '../src/server/container.js';
import { createEvents, registerTriggers } from '../src/server/events.js';

describe('createEvents (local)', () => {
	test('emit awaits every matching handler in order', async () => {
		const events = createEvents();
		const seen = [];
		events.on('a.b', async (p) => {
			await Promise.resolve();
			seen.push(['h1', p.n]);
		});
		events.on('a.b', (p) => seen.push(['h2', p.n]));
		events.on('other', () => seen.push(['nope']));
		await events.emit('a.b', { n: 1 });
		expect(seen).toEqual([
			['h1', 1],
			['h2', 1]
		]);
	});

	test('wildcard handler sees every event with its name', async () => {
		const events = createEvents();
		const seen = [];
		events.on('*', (p, name) => seen.push(name));
		await events.emit('x.y', {});
		await events.emit('z', {});
		expect(seen).toEqual(['x.y', 'z']);
	});

	test('unsubscribe stops delivery', async () => {
		const events = createEvents();
		let calls = 0;
		const off = events.on('e', () => calls++);
		await events.emit('e', {});
		off();
		await events.emit('e', {});
		expect(calls).toBe(1);
	});
});

describe('createEvents (queue mode)', () => {
	test('emit enqueues instead of dispatching', async () => {
		const sent = [];
		const events = createEvents({ queue: { send: (b) => void sent.push(b) } });
		let delivered = 0;
		events.on('a', () => delivered++);
		await events.emit('a', { n: 1 });
		expect(sent).toEqual([{ name: 'a', payload: { n: 1 } }]);
		expect(delivered).toBe(0);
	});

	test('consumer dispatches batch messages and acks', async () => {
		const events = createEvents({ queue: { send: () => {} } });
		const seen = [];
		events.on('a', (p) => seen.push(p.n));
		events.on('boom', () => {
			throw new Error('fail');
		});
		const acked = [];
		const retried = [];
		const msg = (body, id) => ({ body, ack: () => acked.push(id), retry: () => retried.push(id) });
		await events.consumer()({
			messages: [msg({ name: 'a', payload: { n: 1 } }, 1), msg({ name: 'boom', payload: {} }, 2)]
		});
		expect(seen).toEqual([1]);
		expect(acked).toEqual([1]);
		expect(retried).toEqual([2]);
	});
});

describe('registerTriggers', () => {
	function setup() {
		const events = createEvents();
		const container = createContainer();
		container.single('events', () => events);
		return { events, container };
	}

	test('an event runs the wired action with row-id fallback input', async () => {
		const { events, container } = setup();
		const runs = [];
		registerTriggers(container, [
			{ on: 'catalog.Product.deleted', action: { run: (ctx) => void runs.push(ctx) } }
		]);
		await events.emit('catalog.Product.deleted', { row: { id: 'p1' }, user: { id: 'u1' } });
		expect(runs).toHaveLength(1);
		expect(runs[0].input).toEqual({ id: 'p1' });
		expect(runs[0].user).toEqual({ id: 'u1' });
		expect(runs[0].container).toBe(container);
	});

	test('explicit payload input wins over the row fallback', async () => {
		const { events, container } = setup();
		const runs = [];
		registerTriggers(container, [{ on: 'e', action: { run: (ctx) => void runs.push(ctx.input) } }]);
		await events.emit('e', { input: { id: 'x' }, row: { id: 'y' } });
		expect(runs).toEqual([{ id: 'x' }]);
	});

	test('returned disposer unwires all triggers', async () => {
		const { events, container } = setup();
		let calls = 0;
		const off = registerTriggers(container, [{ on: 'e', action: { run: () => calls++ } }]);
		await events.emit('e', {});
		off();
		await events.emit('e', {});
		expect(calls).toBe(1);
	});
});

describe('boot integration', () => {
	test('boot binds a default events bus and wires trigger tables', async () => {
		const { boot } = await import('../src/server/boot.js');
		const runs = [];
		const app = await boot({
			triggers: [
				[{ on: 'catalog.Product.deleted', action: { run: (ctx) => void runs.push(ctx.input) } }],
				[{ on: 'nightly', schedule: '0 0 * * *', action: { run: () => void runs.push('cron') } }]
			]
		});
		const events = app.container.resolve('events');
		await events.emit('catalog.Product.deleted', { row: { id: 'p1' } });
		expect(runs).toEqual([{ id: 'p1' }]);
		await app.scheduled({ cron: '0 0 * * *' });
		expect(runs).toEqual([{ id: 'p1' }, 'cron']);
		app.stopCronShim();
	});

	test('a feature-bound events bus is not overridden', async () => {
		const { boot } = await import('../src/server/boot.js');
		const custom = { emit: () => {}, on: () => () => {} };
		const app = await boot({
			features: { 'm.c': (c) => c.single('events', () => custom) }
		});
		expect(app.container.resolve('events')).toBe(custom);
	});
});
