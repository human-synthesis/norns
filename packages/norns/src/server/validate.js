/**
 * Validation glue. Norns doesn't bundle a schema library — it speaks the
 * Standard Schema interface (https://github.com/standard-schema/standard-schema)
 * supported by Valibot, Zod 3.24+, ArkType, etc. A plain function (`input -> parsed`)
 * also works, for ad-hoc cases or simple hand-rolled parsers.
 */

/** @typedef {{ '~standard': { validate: (input: unknown) => any } }} StandardSchema */
/** @typedef {{ kind: 'validation', path?: any[], message: string }} Issue */

export class ValidationError extends Error {
	/**
	 * @param {Array<Issue>} issues
	 */
	constructor(issues) {
		const summary = issues
			.map((i) => `${formatPath(i.path)}: ${i.message}`)
			.join(', ');
		super(`Validation failed: ${summary}`);
		this.name = 'ValidationError';
		this.issues = issues;
	}
}

/**
 * Validate `input` against `schema`. Returns the parsed value or throws
 * `ValidationError`.
 *
 * Accepts:
 *   - Standard Schema instance (Valibot, Zod, ArkType, …)
 *   - a plain function `(input) => parsed` that throws on invalid input
 *   - `undefined` / `null` → passthrough (no validation)
 *
 * @template T
 * @param {StandardSchema | ((input: unknown) => T) | undefined | null} schema
 * @param {unknown} input
 * @returns {T}
 */
export function validate(schema, input) {
	if (schema == null) return /** @type {T} */ (input);
	if (typeof schema === 'function') return schema(input);
	if (schema['~standard'] && typeof schema['~standard'].validate === 'function') {
		const result = schema['~standard'].validate(input);
		if (result instanceof Promise) {
			throw new Error('Async schema validation is not supported in route()/page.actions()');
		}
		if (result.issues) throw new ValidationError(result.issues);
		return result.value;
	}
	throw new Error('validate(): schema must implement Standard Schema or be a function');
}

/**
 * @param {any[] | undefined} path
 * @returns {string}
 */
function formatPath(path) {
	if (!path || path.length === 0) return '$';
	return path.map((p) => (typeof p === 'object' ? p.key : p)).join('.');
}
