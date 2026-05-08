import { describe, test, expect } from 'bun:test';
import { page } from '../src/server/page.js';
import { createApp } from '../src/server/boot.js';

describe('page.load', () => {
	test('returns handler value verbatim with container injected', async () => {
		const app = createApp();
		app.single('count', () => 7);

		const load = page.load({
			handler: ({ container, params, url, user }) => ({
				count: container.resolve('count'),
				params,
				path: url.pathname,
				user
			})
		});

		const result = await load(loadEvent('/notes/42', { id: '42' }, app.scope(), { id: 'u' }));
		expect(result).toEqual({
			count: 7,
			params: { id: '42' },
			path: '/notes/42',
			user: { id: 'u' }
		});
	});

	test('rejects without handler', () => {
		expect(() => page.load({})).toThrow(/handler.* required/);
	});
});

describe('page.actions', () => {
	test('forwards parsed input to action.run', async () => {
		const actions = page.actions({
			create: {
				input: standardOk((raw) => ({ title: raw.title, body: raw.body ?? '' })),
				run: ({ input, container }) => ({
					ok: true,
					title: input.title,
					hasContainer: !!container
				})
			}
		});

		const event = formActionEvent('/x', new URLSearchParams({ title: 'Hi' }), createApp().scope());
		const result = await actions.create(event);
		expect(result).toEqual({ ok: true, title: 'Hi', hasContainer: true });
	});

	test('returns fail(400) on validation error', async () => {
		const actions = page.actions({
			create: {
				input: standardFail([
					{ kind: 'validation', path: [{ key: 'title' }], message: 'required' }
				]),
				run: () => ({ ok: true })
			}
		});

		const event = formActionEvent('/x', new URLSearchParams(), createApp().scope());
		const result = await actions.create(event);
		expect(result).toMatchObject({ status: 400 });
		expect(result.data?.errors?.[0]?.message).toBe('required');
	});

	test('action without input still runs and gets container/user', async () => {
		let probed;
		const actions = page.actions({
			ping: {
				run: ({ container, user }) => {
					probed = { hasContainer: !!container, user };
					return { ok: true };
				}
			}
		});

		const event = formActionEvent('/x', new URLSearchParams(), createApp().scope());
		event.locals.user = { id: 'p' };
		const result = await actions.ping(event);
		expect(result).toEqual({ ok: true });
		expect(probed).toEqual({ hasContainer: true, user: { id: 'p' } });
	});

	test('rejects an action missing run', () => {
		expect(() => page.actions({ bad: { input: () => null } })).toThrow(
			/action "bad" missing `run`/
		);
	});
});

function loadEvent(path, params, container, user) {
	const url = new URL(`http://localhost${path}`);
	return {
		params,
		url,
		route: { id: path },
		locals: { container, user },
		request: new Request(url),
		cookies: { get: () => undefined, set: () => {}, delete: () => {}, serialize: () => '' },
		fetch: globalThis.fetch,
		getClientAddress: () => '127.0.0.1',
		platform: undefined,
		isDataRequest: false,
		isSubRequest: false,
		parent: async () => ({}),
		depends: () => {},
		setHeaders: () => {}
	};
}

function formActionEvent(path, params, container) {
	const url = new URL(`http://localhost${path}`);
	const request = new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: params.toString()
	});
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
