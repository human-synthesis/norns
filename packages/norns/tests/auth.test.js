import { describe, expect, test } from 'bun:test';
import { boot } from '../src/server/boot.js';
import { contextHandle } from '../src/server/handle/context.js';
import { authHandle, normalizeUser } from '../src/server/handle/auth.js';

function fakeAuth({ session = null } = {}) {
	const calls = { handler: [], getSession: [] };
	return {
		calls,
		handler(request) {
			calls.handler.push(request.url);
			return new Response('auth-handled', { status: 200 });
		},
		api: {
			async getSession({ headers }) {
				calls.getSession.push(headers);
				return session;
			}
		}
	};
}

function makeEvent(path, { headers = {} } = {}) {
	const request = new Request(`http://localhost${path}`, { headers });
	return {
		request,
		url: new URL(request.url),
		locals: {}
	};
}

describe('normalizeUser', () => {
	test('null passes through', () => {
		expect(normalizeUser(null)).toBeNull();
		expect(normalizeUser(undefined)).toBeNull();
	});

	test('roles array is kept as-is', () => {
		const u = normalizeUser({ id: 'u1', roles: ['admin', 'member'] });
		expect(u.roles).toEqual(['admin', 'member']);
	});

	test('better-auth admin-plugin comma string is split and trimmed', () => {
		const u = normalizeUser({ id: 'u1', role: 'admin, member,,  ' });
		expect(u.roles).toEqual(['admin', 'member']);
		expect(u.role).toBe('admin, member,,  ');
	});

	test('no role info yields empty roles', () => {
		expect(normalizeUser({ id: 'u1' }).roles).toEqual([]);
	});
});

describe('authHandle', () => {
	test('requests at/under basePath go to auth.handler', async () => {
		const auth = fakeAuth();
		const handle = authHandle(auth);
		for (const path of ['/api/auth', '/api/auth/sign-in/email']) {
			const res = await handle({
				event: makeEvent(path),
				resolve: () => {
					throw new Error('resolve must not be called for auth routes');
				}
			});
			expect(await res.text()).toBe('auth-handled');
		}
		expect(auth.calls.handler.length).toBe(2);
		expect(auth.calls.getSession.length).toBe(0);
	});

	test('lookalike prefixes are not swallowed', async () => {
		const auth = fakeAuth();
		const handle = authHandle(auth);
		let resolved = false;
		await handle({
			event: makeEvent('/api/authors'),
			resolve: () => {
				resolved = true;
				return new Response('page');
			}
		});
		expect(resolved).toBe(true);
		expect(auth.calls.handler.length).toBe(0);
	});

	test('custom basePath is honored', async () => {
		const auth = fakeAuth();
		const handle = authHandle(auth, { basePath: '/auth' });
		const res = await handle({ event: makeEvent('/auth/session'), resolve: () => new Response('no') });
		expect(await res.text()).toBe('auth-handled');
	});

	test('session user lands normalized on event.locals', async () => {
		const auth = fakeAuth({
			session: { user: { id: 'u1', role: 'admin,member' }, session: { id: 's1' } }
		});
		const handle = authHandle(auth);
		const event = makeEvent('/deals');
		await handle({ event, resolve: () => new Response('page') });
		expect(event.locals.user).toEqual({ id: 'u1', role: 'admin,member', roles: ['admin', 'member'] });
		expect(event.locals.session).toEqual({ id: 's1' });
	});

	test('anonymous request gets null user and session', async () => {
		const auth = fakeAuth({ session: null });
		const handle = authHandle(auth);
		const event = makeEvent('/deals');
		await handle({ event, resolve: () => new Response('page') });
		expect(event.locals.user).toBeNull();
		expect(event.locals.session).toBeNull();
	});
});

// boot()'s composed handle uses SvelteKit's sequence(), which needs the
// framework request store — so we chain contextHandle + authHandle manually
// (same pattern as boot.test.js) and only smoke-test boot() wiring shape.
describe('contextHandle + authHandle chain', () => {
	function chain(container, auth, opts) {
		const ctx = contextHandle(container);
		const authed = authHandle(auth, opts);
		return ({ event, resolve }) => ctx({ event, resolve: (ev) => authed({ event: ev, resolve }) });
	}

	test('request scope receives user and session bindings', async () => {
		const auth = fakeAuth({
			session: { user: { id: 'u1', roles: ['member'] }, session: { id: 's1' } }
		});
		const app = await boot({ auth });
		const event = makeEvent('/deals');
		let seen;
		await chain(app.container, auth)({
			event,
			resolve: (ev) => {
				seen = {
					user: ev.locals.container.resolve('user'),
					session: ev.locals.container.resolve('session')
				};
				return new Response('page');
			}
		});
		expect(seen.user).toEqual({ id: 'u1', roles: ['member'] });
		expect(seen.session).toEqual({ id: 's1' });
	});

	test('auth routes short-circuit before app resolve', async () => {
		const auth = fakeAuth();
		const app = await boot({ auth });
		const res = await chain(app.container, auth)({
			event: makeEvent('/api/auth/callback'),
			resolve: () => {
				throw new Error('must not resolve');
			}
		});
		expect(await res.text()).toBe('auth-handled');
	});

	test('custom basePath flows through the chain', async () => {
		const auth = fakeAuth();
		const app = await boot({ auth, authBasePath: '/custom/auth' });
		const res = await chain(app.container, auth, { basePath: '/custom/auth' })({
			event: makeEvent('/custom/auth/session'),
			resolve: () => new Response('no')
		});
		expect(await res.text()).toBe('auth-handled');
	});

	test('boot() accepts auth without changing its return shape', async () => {
		const app = await boot({ auth: fakeAuth() });
		expect(typeof app.handle).toBe('function');
		expect(typeof app.handleError).toBe('function');
		expect(typeof app.scheduled).toBe('function');
	});
});
