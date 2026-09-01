/** @typedef {import('@sveltejs/kit').Handle} Handle */

/**
 * Normalize a better-auth user for policy predicates: `owner` compares
 * `row[ownerField] === user.id`; `role:x` checks `user.roles.includes('x')`.
 * better-auth's admin plugin stores roles as a comma-separated `role` string.
 *
 * @param {*} user
 * @returns {{ id: *, roles: string[] } | null}
 */
export function normalizeUser(user) {
	if (!user) return null;
	const roles = Array.isArray(user.roles)
		? user.roles
		: typeof user.role === 'string'
			? user.role.split(',').map((r) => r.trim()).filter(Boolean)
			: [];
	return { ...user, roles };
}

/**
 * Session middleware over a better-auth instance (`betterAuth({...})`):
 *
 * - requests under `basePath` (default `/api/auth`) go straight to
 *   better-auth's fetch handler (sign-in/out, callbacks, etc.)
 * - for everything else the session is resolved once per request;
 *   `event.locals.user` / `event.locals.session` are set, and — when
 *   `contextHandle` already attached a request scope — `user` and `session`
 *   are bound into `event.locals.container` so downstream code can
 *   `container.resolve('user')`.
 *
 * Anonymous requests get `user: null`; policy guards deny by default.
 *
 * @param {{ handler(req: Request): Response | Promise<Response>, api: { getSession(opts: { headers: Headers }): * } }} auth
 * @param {{ basePath?: string }} [opts]
 * @returns {Handle}
 */
export function authHandle(auth, { basePath = '/api/auth' } = {}) {
	return async ({ event, resolve }) => {
		if (event.url.pathname === basePath || event.url.pathname.startsWith(`${basePath}/`)) {
			return auth.handler(event.request);
		}
		const session = await auth.api.getSession({ headers: event.request.headers });
		const user = normalizeUser(session?.user ?? null);
		event.locals.session = session?.session ?? null;
		event.locals.user = user;
		const scope = event.locals.container;
		if (scope) {
			scope.single('user', () => user);
			scope.single('session', () => event.locals.session);
		}
		return resolve(event);
	};
}
