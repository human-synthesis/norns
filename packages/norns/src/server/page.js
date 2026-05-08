import { fail } from '@sveltejs/kit';
import { validate, ValidationError } from './validate.js';

/** @typedef {import('@sveltejs/kit').ServerLoadEvent} ServerLoadEvent */
/** @typedef {import('@sveltejs/kit').RequestEvent} RequestEvent */
/** @typedef {import('./container.js').Container} Container */

/**
 * @typedef {Object} LoadContext
 * @property {Container} container
 * @property {ServerLoadEvent} event
 * @property {ServerLoadEvent['params']} params
 * @property {ServerLoadEvent['url']} url
 * @property {any} user
 */

/**
 * @typedef {Object} ActionContext
 * @property {any} input parsed form data (after validation)
 * @property {Container} container
 * @property {RequestEvent} event
 * @property {any} user
 */

/**
 * Wrappers for `+page.server.c` exports — `load` and `actions`. They mirror
 * `route()` but: (a) `load` returns its result as data (no JSON wrapper), and
 * (b) actions return `fail(400, ...)` on validation rather than throwing
 * `error(400)`, which is the SvelteKit-idiomatic shape for forms.
 */
export const page = {
	/**
	 * Wrap a SvelteKit `load`.
	 *
	 * @param {{ handler: (ctx: LoadContext) => any | Promise<any> }} opts
	 * @returns {(event: ServerLoadEvent) => Promise<any>}
	 */
	load(opts) {
		if (typeof opts?.handler !== 'function') {
			throw new Error('page.load(): `handler` is required');
		}
		return async (event) => {
			return opts.handler({
				container: event.locals.container,
				event,
				params: event.params,
				url: event.url,
				user: event.locals.user
			});
		};
	},

	/**
	 * Wrap a SvelteKit `actions` object. Each action takes `{ input?, run }`
	 * — `input` is a schema, `run` is the handler.
	 *
	 * @param {Record<string, { input?: any, run: (ctx: ActionContext) => any | Promise<any> }>} spec
	 * @returns {Record<string, (event: RequestEvent) => Promise<any>>}
	 */
	actions(spec) {
		/** @type {Record<string, (event: RequestEvent) => Promise<any>>} */
		const out = {};
		for (const [name, def] of Object.entries(spec)) {
			if (typeof def?.run !== 'function') {
				throw new Error(`page.actions(): action "${name}" missing \`run\` function`);
			}
			out[name] = async (event) => {
				let raw = null;
				let input;
				if (def.input !== undefined) {
					raw = await readForm(event.request);
					try {
						input = validate(def.input, raw);
					} catch (e) {
						if (e instanceof ValidationError) {
							return fail(400, { errors: e.issues, values: raw });
						}
						throw e;
					}
				}
				return def.run({
					input,
					container: event.locals.container,
					event,
					user: event.locals.user
				});
			};
		}
		return out;
	}
};

/**
 * Read form-encoded body into a plain object. Designed for `actions` —
 * SvelteKit only invokes them via form POST.
 *
 * @param {Request} request
 * @returns {Promise<any>}
 */
async function readForm(request) {
	try {
		const data = await request.formData();
		return Object.fromEntries(data);
	} catch {
		return null;
	}
}
