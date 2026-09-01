import { sequence } from '@sveltejs/kit/hooks';
import { Container } from './container.js';
import { contextHandle } from './handle/context.js';
import { authHandle } from './handle/auth.js';
import { errorHandle } from './handle/error.js';
import { setSerializer } from './route.js';
import { createEvents, registerTriggers } from './events.js';
import { createLive } from './live.js';
import { scheduledHandler, startCronShim } from './cron.js';

/**
 * Create a fresh root container with no features registered. Useful for tests
 * that want full control over what's bound.
 *
 * @returns {Container}
 */
export function createApp() {
	return new Container();
}

/** @typedef {(app: Container) => void | Promise<void>} ModuleRegister */
/** @typedef {{ default?: ModuleRegister } | ModuleRegister} FeatureModule */

/**
 * Boot a Norns app: builds the root container, runs every feature's
 * `module.c` registration, and returns the SvelteKit hooks ready to wire into
 * `src/hooks.server.c`.
 *
 * Typical use in a consumer app:
 *
 *   import { boot } from '@human-synthesis/norns/server';
 *
 *   const app = await boot({
 *     features: import.meta.glob('./lib/*\/server/module.c', { eager: true })
 *   });
 *   export const { handle, handleError, container } = app;
 *
 * Each `module.c` must default-export a function `(app) -> ...` that calls
 * `app.bind(...)` / `app.single(...)` / `app.migrations(...)`.
 *
 * Spec-first extras:
 * - `triggers` — generated trigger tables (`lib/<m>/triggers.c` exports),
 *   nested arrays are flattened. Event triggers are wired into the bus;
 *   cron ones are served by the returned `scheduled` handler.
 * - `queue` — Cloudflare Queues producer binding; `emit` enqueues instead of
 *   dispatching in-process.
 * - `cronShim: true` — local minute-timer for cron triggers (`norns dev`).
 * - `auth` — a better-auth-shaped instance (`.handler(request)` +
 *   `.api.getSession({ headers })`); requests under `authBasePath`
 *   (default `/api/auth`) are handed to it, every other request gets
 *   `event.locals.user` / `event.locals.session` and scope bindings.
 * - `room` — the `ROOM` Durable Object namespace binding (Workers prod);
 *   live-query publishes and the `/_norns/live` stream go through it. Omit
 *   in dev: signals ride the in-process bus.
 * - an `events` singleton is bound automatically unless a feature bound one,
 *   and a `live` bridge singleton likewise (actions with `refresh` lists
 *   publish through it).
 *
 * @param {{
 *   features?: Record<string, FeatureModule>,
 *   extraHandle?: import('@sveltejs/kit').Handle | import('@sveltejs/kit').Handle[],
 *   handleError?: import('@sveltejs/kit').HandleServerError,
 *   serializer?: import('./route.js').Serializer | null,
 *   triggers?: *[],
 *   queue?: { send(body: *): Promise<void> | void },
 *   cronShim?: boolean,
 *   room?: *,
 *   auth?: { handler(request: Request): Promise<Response> | Response, api: { getSession(input: *): Promise<*> } },
 *   authBasePath?: string
 * }} [opts]
 * @returns {Promise<{
 *   container: Container,
 *   handle: import('@sveltejs/kit').Handle,
 *   handleError: import('@sveltejs/kit').HandleServerError,
 *   scheduled: (event: *) => Promise<void>,
 *   stopCronShim: () => void
 * }>}
 */
export async function boot(opts = {}) {
	const container = createApp();

	// App-wide route() response serializer (e.g. tronSerializer() from
	// @human-synthesis/norns-tron/server). Omit to keep plain JSON.
	if (opts.serializer !== undefined) setSerializer(opts.serializer);

	if (opts.features) {
		for (const [path, mod] of Object.entries(opts.features)) {
			const register = /** @type {ModuleRegister | undefined} */ (
				typeof mod === 'function' ? mod : mod?.default
			);
			if (typeof register !== 'function') {
				throw new Error(
					`Norns: ${path} must default-export a function (app) -> ... — got ${typeof register}`
				);
			}
			await register(container);
		}
	}

	const extras = opts.extraHandle
		? Array.isArray(opts.extraHandle)
			? opts.extraHandle
			: [opts.extraHandle]
		: [];

	if (!container.has('events')) {
		container.single('events', () => createEvents(opts.queue ? { queue: opts.queue } : {}));
	}
	if (!container.has('live')) {
		container.single('live', () =>
			createLive({ events: container.resolve('events'), room: opts.room })
		);
	}

	const triggers = (opts.triggers ?? []).flat(Infinity);
	if (triggers.length > 0) {
		registerTriggers(container, triggers.filter((t) => !t.schedule));
	}
	const stopCronShim = opts.cronShim ? startCronShim(container, triggers) : () => {};

	// contextHandle must come first so authHandle can bind user/session into
	// the per-request scope it creates.
	const handle = sequence(
		contextHandle(container),
		...(opts.auth ? [authHandle(opts.auth, { basePath: opts.authBasePath })] : []),
		...extras
	);
	const handleError = opts.handleError ?? errorHandle();

	return {
		container,
		handle,
		handleError,
		scheduled: scheduledHandler(container, triggers),
		stopCronShim
	};
}
