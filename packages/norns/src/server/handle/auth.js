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
 * `auth` may also be a factory `(event) => instance | Promise<instance>`
 * (D86/T-02): on Workers the D1 binding exists only per request, so the
 * better-auth instance is built from the request's DB. A factory returning
 * nothing lets the request through anonymous.
 *
 * @param {AuthInstance | ((event: *) => AuthInstance | undefined | Promise<AuthInstance | undefined>)} auth
 * @param {{ basePath?: string }} [opts]
 * @returns {Handle}
 * @typedef {{ handler(req: Request): Response | Promise<Response>, api: { getSession(opts: { headers: Headers }): * } }} AuthInstance
 */
export function authHandle(auth, { basePath = '/api/auth' } = {}) {
	return async ({ event, resolve }) => {
		const inst = typeof auth === 'function' ? await auth(event) : auth;
		if (!inst) return resolve(event);
		if (event.url.pathname === basePath || event.url.pathname.startsWith(`${basePath}/`)) {
			return inst.handler(event.request);
		}
		const session = await inst.api.getSession({ headers: event.request.headers });
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
