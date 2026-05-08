import { describe, test, expect } from 'bun:test';
import { boot, createApp } from '../src/server/boot.js';
import { contextHandle } from '../src/server/handle/context.js';
import { Container } from '../src/server/container.js';

describe('createApp', () => {
	test('returns a fresh root Container', () => {
		const app = createApp();
		expect(app).toBeInstanceOf(Container);
		expect(app.parent).toBeNull();
	});
});

describe('boot', () => {
	test('with no features returns app + handle + handleError', async () => {
		const app = await boot();
		expect(app.container).toBeInstanceOf(Container);
		expect(typeof app.handle).toBe('function');
		expect(typeof app.handleError).toBe('function');
	});

	test('registers a feature module via default export', async () => {
		const features = {
			'./lib/notes/server/module.c': {
				default: (app) => {
					app.single('notes.repo', () => ({ name: 'repo' }));
				}
			}
		};
		const app = await boot({ features });
		expect(app.container.resolve('notes.repo').name).toBe('repo');
	});

	test('registers a feature module exported as the function itself', async () => {
		const features = {
			'./lib/x/server/module.c': (app) => {
				app.bind('x.tag', () => 'flat');
			}
		};
		const app = await boot({ features });
		expect(app.container.resolve('x.tag')).toBe('flat');
	});

	test('awaits async module registrations', async () => {
		const features = {
			'./lib/y/server/module.c': async (app) => {
				await new Promise((r) => setTimeout(r, 1));
				app.single('y.thing', () => 'async-bound');
			}
		};
		const app = await boot({ features });
		expect(app.container.resolve('y.thing')).toBe('async-bound');
	});

	test('rejects a module that does not export a function', async () => {
		const features = {
			'./lib/bad/server/module.c': { default: 42 }
		};
		await expect(boot({ features })).rejects.toThrow(/must default-export a function/);
	});

	// Note: end-to-end testing of `app.handle` requires SvelteKit's request
	// store, so we test contextHandle directly below and leave boot's composed
	// handle to integration smoke tests in norns-app.
});

describe('contextHandle', () => {
	test('attaches a child scope to event.locals.container', async () => {
		const root = createApp();
		root.single('db', () => ({ which: 'root-db' }));
		const handle = contextHandle(root);

		let scopedContainer = null;
		await handle({
			event: makeEvent('/health'),
			resolve: async (event) => {
				scopedContainer = event.locals.container;
				return new Response('ok');
			}
		});

		expect(scopedContainer).toBeInstanceOf(Container);
		expect(scopedContainer).not.toBe(root);
		expect(scopedContainer.parent).toBe(root);
		expect(scopedContainer.resolve('db').which).toBe('root-db');
	});

	test('overrides on the request scope do not leak to the root', async () => {
		const root = createApp();
		root.single('greet', () => 'hello');
		const handle = contextHandle(root);

		let probed = null;
		await handle({
			event: makeEvent('/x'),
			resolve: async (event) => {
				event.locals.container.override('greet', () => 'overridden');
				probed = event.locals.container.resolve('greet');
				return new Response('ok');
			}
		});

		expect(probed).toBe('overridden');
		expect(root.resolve('greet')).toBe('hello');
	});
});

function makeEvent(pathname) {
	return {
		request: new Request(`http://localhost${pathname}`),
		url: new URL(`http://localhost${pathname}`),
		locals: {},
		params: {},
		route: { id: pathname },
		cookies: { get: () => undefined, set: () => {}, delete: () => {}, serialize: () => '' },
		fetch: globalThis.fetch,
		getClientAddress: () => '127.0.0.1',
		platform: undefined,
		isDataRequest: false,
		isSubRequest: false,
		setHeaders: () => {}
	};
}
