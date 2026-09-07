/**
 * @typedef {{ file: string; line: number; severity: 'error' | 'warning'; rule: string; msg: string }} Finding
 */
/**
 * Recursively list files under `dir` whose basename passes `filter`,
 * skipping build/vendor directories and dot-directories.
 *
 * @param {string} dir
 * @param {(name: string) => boolean} filter
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function walk(dir: string, filter: (name: string) => boolean, out?: string[]): string[];
/**
 * @param {string} cwd
 * @returns {Finding[]}
 */
export function nornsLint(cwd: string): Finding[];
/**
 * Lint a single source string (used by tests and by editors that want to
 * lint an unsaved buffer). `file` decides which rule set applies.
 *
 * @param {string} file
 * @param {string} content
 * @returns {Finding[]}
 */
export function lintSource(file: string, content: string): Finding[];
/**
 * Summarize findings.
 *
 * @param {Finding[]} findings
 * @returns {{ errors: number; warnings: number }}
 */
export function countFindings(findings: Finding[]): {
    errors: number;
    warnings: number;
};
/**
 * Pretty-print findings. Returns the number of errors.
 * @param {Finding[]} findings
 * @returns {{ errors: number; warnings: number }}
 */
export function printFindings(findings: Finding[]): {
    errors: number;
    warnings: number;
};
export const SKIP_DIRS: Set<string>;
export type Finding = {
    file: string;
    line: number;
    severity: "error" | "warning";
    rule: string;
    msg: string;
};
