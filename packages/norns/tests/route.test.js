import { describe, test, expect } from 'bun:test';
import { route } from '../src/server/route.js';
import { createApp } from '../src/server/boot.js';

describe('route', () => {
	test('returns JSON body from handler return value', async () => {
		const app = createApp();
		const handler = route({
			handler: ({ container }) => ({ ok: true, hasContainer: !!container })
		});
		const res = await handler(makeEvent('GET', '/x', null, app.scope()));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, hasContainer: true });
	});

	test('passes a Response through unchanged', async () => {
		const handler = route({
			handler: () => new Response('raw', { status: 201, headers: { 'x-test': 'yes' } })
		});
		const res = await handler(makeEvent('GET', '/x', null, createApp().scope()));
		expect(res.status).toBe(201);
		expect(res.headers.get('x-test')).toBe('yes');
		expect(await res.text()).toBe('raw');
	});

	test('null/undefined return is JSON null', async () => {
		const handler = route({ handler: () => undefined });
		const res = await handler(makeEvent('GET', '/x', null, createApp().scope()));
		expect(await res.json()).toBeNull();
	});

	test('validates JSON body against schema; passes parsed input to handler', async () => {
		let received;
		const handler = route({
			input: standardOk((input) => ({ ...input, parsed: true })),
			handler: ({ input }) => {
				received = input;
				return { got: input };
			}
		});
		const res = await handler(
			makeEvent(
				'POST',
				'/x',
				{ body: { name: 'a' }, contentType: 'application/json' },
				createApp().scope()
			)
		);
		expect(received).toEqual({ name: 'a', parsed: true });
		expect(res.status).toBe(200);
	});

	test('throws SvelteKit 400 error on validation failure', async () => {
		const handler = route({
			input: standardFail([{ kind: 'validation', path: [{ key: 'x' }], message: 'bad' }]),
			handler: () => ({ ok: true })
		});
		await expect(
			handler(
				makeEvent(
					'POST',
					'/x',
					{ body: {}, contentType: 'application/json' },
					createApp().scope()
				)
			)
		).rejects.toMatchObject({ status: 400 });
	});

	test('validates query params against schema', async () => {
		let q;
		const handler = route({
			query: standardOk((raw) => ({ page: Number(raw.page ?? 1) })),
			handler: ({ query }) => {
				q = query;
				return q;
			}
		});
		const res = await handler(makeEvent('GET', '/x?page=3', null, createApp().scope()));
		expect(q).toEqual({ page: 3 });
		expect(await res.json()).toEqual({ page: 3 });
	});

	test('handler receives container and user from event.locals', async () => {
		let probed = {};
		const app = createApp();
		app.single('hello', () => 'world');
		const scope = app.scope();
		scope.override = scope.override.bind(scope);

		const handler = route({
			handler: ({ container, user }) => {
				probed.hello = container.resolve('hello');
				probed.user = user;
				return null;
			}
		});

		const event = makeEvent('GET', '/x', null, scope);
		event.locals.user = { id: 'u-1' };
		await handler(event);
		expect(probed).toEqual({ hello: 'world', user: { id: 'u-1' } });
	});

	test('handler missing throws explanatory error at construction', () => {
		expect(() => route({ input: standardOk((v) => v) })).toThrow(/handler.* required/);
	});
});

function makeEvent(method, path, body, container) {
	const url = new URL(`http://localhost${path}`);
	let request;
	if (body) {
		const init = { method, headers: { 'content-type': body.contentType } };
		if (body.contentType === 'application/json') init.body = JSON.stringify(body.body);
		else if (body.contentType === 'application/x-www-form-urlencoded') {
			const params = new URLSearchParams(body.body);
			init.body = params.toString();
		}
		request = new Request(url, init);
	} else {
		request = new Request(url, { method });
	}
	return {
		request,
		url,
		params: {},
		route: { id: path },
		locals: { container },
		cookies: { get: () => undefined, set: () => {}, delete: () => {}, serialize: () => '' },
		fetch: globalThis.fetch,
		getClientAddress: () => '127.0.0.1',
		platform: undefined,
		isDataRequest: false,
		isSubRequest: false,
		setHeaders: () => {}
	};
}

function standardOk(transform) {
	return { '~standard': { validate: (input) => ({ value: transform(input) }) } };
}

function standardFail(issues) {
	return { '~standard': { validate: () => ({ issues }) } };
}
