/**
 * `norns check` — compile-check every Norns source file the way the build
 * does, without running the build.
 *
 *   - `.n` / `.svelte` (any extension in the project's `extensions`) go
 *     through the project's own `svelte.config.js` preprocess chain (Pug,
 *     Civet, auto-imports) and then the Svelte compiler.
 *   - `.c` / `.civet` modules go through the Civet compiler.
 *
 * Errors carry `file:line:column` in the *source* file where the pipeline
 * can map them (Pug and Civet errors are mapped by norns-core; Svelte compile
 * errors are mapped through the preprocess source map when one is available
 * — template positions usually are not, and are then reported as positions
 * in the preprocessed output with `mapped: false`).
 *
 * @typedef {{
 *   file: string,
 *   line: number | null,
 *   column: number | null,
 *   message: string,
 *   stage: 'civet' | 'pug' | 'preprocess' | 'svelte',
 *   code?: string,
 *   frame?: string | null,
 *   mapped: boolean
 * }} CheckDiagnostic
 *
 * @typedef {{ files: number, errors: CheckDiagnostic[], warnings: CheckDiagnostic[] }} CheckResult
 */
/**
 * Load `svelte.config.js` from `cwd` (ESM). Returns null when absent.
 *
 * @param {string} cwd
 * @returns {Promise<import('@sveltejs/kit').Config | null>}
 */
export function loadSvelteConfig(cwd: string): Promise<import("@sveltejs/kit").Config | null>;
/**
 * @param {string} source
 * @param {number} line 1-based
 * @param {number | null} column 1-based
 * @returns {string}
 */
export function codeFrame(source: string, line: number, column: number | null): string;
/**
 * @param {{
 *   cwd?: string,
 *   preprocess?: any,
 *   extensions?: string[],
 *   srcDir?: string,
 *   warnings?: boolean
 * }} [opts]
 * @returns {Promise<CheckResult>}
 */
export function nornsCheck(opts?: {
    cwd?: string;
    preprocess?: any;
    extensions?: string[];
    srcDir?: string;
    warnings?: boolean;
}): Promise<CheckResult>;
/**
 * Pretty-print a check result. Returns the error count.
 *
 * @param {CheckResult} result
 * @returns {number}
 */
export function printCheck(result: CheckResult): number;
/** @param {string} file */
export function isComponentFile(file: string, extensions?: string[]): boolean;
/**
 * `norns check` — compile-check every Norns source file the way the build
 * does, without running the build.
 *
 *   - `.n` / `.svelte` (any extension in the project's `extensions`) go
 *     through the project's own `svelte.config.js` preprocess chain (Pug,
 *     Civet, auto-imports) and then the Svelte compiler.
 *   - `.c` / `.civet` modules go through the Civet compiler.
 *
 * Errors carry `file:line:column` in the *source* file where the pipeline
 * can map them (Pug and Civet errors are mapped by norns-core; Svelte compile
 * errors are mapped through the preprocess source map when one is available
 * — template positions usually are not, and are then reported as positions
 * in the preprocessed output with `mapped: false`).
 */
export type CheckDiagnostic = {
    file: string;
    line: number | null;
    column: number | null;
    message: string;
    stage: "civet" | "pug" | "preprocess" | "svelte";
    code?: string;
    frame?: string | null;
    mapped: boolean;
};
/**
 * `norns check` — compile-check every Norns source file the way the build
 * does, without running the build.
 *
 *   - `.n` / `.svelte` (any extension in the project's `extensions`) go
 *     through the project's own `svelte.config.js` preprocess chain (Pug,
 *     Civet, auto-imports) and then the Svelte compiler.
 *   - `.c` / `.civet` modules go through the Civet compiler.
 *
 * Errors carry `file:line:column` in the *source* file where the pipeline
 * can map them (Pug and Civet errors are mapped by norns-core; Svelte compile
 * errors are mapped through the preprocess source map when one is available
 * — template positions usually are not, and are then reported as positions
 * in the preprocessed output with `mapped: false`).
 */
export type CheckResult = {
    files: number;
    errors: CheckDiagnostic[];
    warnings: CheckDiagnostic[];
};
