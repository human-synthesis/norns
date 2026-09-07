/**
 * Create a fresh root container with no features registered. Useful for tests
 * that want full control over what's bound.
 *
 * @returns {Container}
 */
export function createApp(): Container;
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
 *   handleError?: import('@sveltejs/kit').HandleServerError,
 *   serializer?: import('./route.js').Serializer | null
 * }} [opts]
 * @returns {Promise<{
 *   container: Container,
 *   handle: import('@sveltejs/kit').Handle,
 *   handleError: import('@sveltejs/kit').HandleServerError
 * }>}
 */
export function boot(opts?: {
    features?: Record<string, FeatureModule>;
    extraHandle?: import("@sveltejs/kit").Handle | import("@sveltejs/kit").Handle[];
    handleError?: import("@sveltejs/kit").HandleServerError;
    serializer?: import("./route.js").Serializer | null;
}): Promise<{
    container: Container;
    handle: import("@sveltejs/kit").Handle;
    handleError: import("@sveltejs/kit").HandleServerError;
}>;
export type ModuleRegister = (app: Container) => void | Promise<void>;
export type FeatureModule = {
    default?: ModuleRegister;
} | ModuleRegister;
import { Container } from './container.js';
