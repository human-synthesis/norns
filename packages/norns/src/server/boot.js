import { sequence } from '@sveltejs/kit/hooks';
import { Container } from './container.js';
import { contextHandle } from './handle/context.js';
import { errorHandle } from './handle/error.js';

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
 * @param {{
 *   features?: Record<string, FeatureModule>,
 *   extraHandle?: import('@sveltejs/kit').Handle | import('@sveltejs/kit').Handle[],
 *   handleError?: import('@sveltejs/kit').HandleServerError
 * }} [opts]
 * @returns {Promise<{
 *   container: Container,
 *   handle: import('@sveltejs/kit').Handle,
 *   handleError: import('@sveltejs/kit').HandleServerError
 * }>}
 */
export async function boot(opts = {}) {
	const container = createApp();

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

	const handle = sequence(contextHandle(container), ...extras);
	const handleError = opts.handleError ?? errorHandle();

	return { container, handle, handleError };
}
