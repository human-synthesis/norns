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
export function validate<T>(schema: StandardSchema | ((input: unknown) => T) | undefined | null, input: unknown): T;
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
    constructor(issues: Array<Issue>);
    issues: Issue[];
}
export type StandardSchema = {
    "~standard": {
        validate: (input: unknown) => any;
    };
};
export type Issue = {
    kind: "validation";
    path?: any[];
    message: string;
};
