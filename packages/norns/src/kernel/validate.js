import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { APP_SPEC, readSpecs } from '@human-synthesis/norns-tron/spec';

import { indexUnits, listUnits } from './address.js';
import { APP_SCHEMA, MODULE_SCHEMA, UNIT_SCHEMAS, schemaIssues } from './meta.js';
import { refineSpecs } from './refine.js';

// Kinds whose unit name is emitted verbatim as an exported identifier
// (`export <name> := …` in the generated module files). A JS reserved word
// there would only fail at generation's self-check, after the spec change
// has already been committed — refuse it here instead.
const IDENTIFIER_KINDS = new Set(['Query', 'Action', 'Service', 'Job']);
const RESERVED_WORDS = new Set([
	'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
	'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
	'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
	'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
	'typeof', 'var', 'void', 'while', 'with', 'let', 'static', 'yield',
	'await', 'implements', 'interface', 'package', 'private', 'protected',
	'public', 'arguments', 'eval'
]);

/**
 * @typedef {{ level: 'error' | 'warning', address: string, message: string }} Issue
 * @typedef {{
 *   dir: string,
 *   app: *,
 *   modules: Record<string, *>,
 *   files: Record<string, string>,
 *   hashes: Record<string, string>,
 *   version: string
 * }} LoadedSpecs
 */

/**
 * Load a `specs/` directory. Throws when the directory is missing —
 * everything past this point can assume specs exist.
 *
 * @param {string} [dir] defaults to `<cwd>/specs`
 * @returns {LoadedSpecs}
 */
export function loadSpecs(dir = resolve(process.cwd(), 'specs')) {
	const abs = resolve(dir);
	if (!existsSync(abs)) {
		throw new Error(`norns: no specs directory at ${abs} (expected specs/*.t)`);
	}
	return { dir: abs, ...readSpecs(abs) };
}

/**
 * Validate a specs directory and return every issue found: structural
 * checks, per-kind meta-schemas, uid uniqueness. Cross-unit refinements
 * (K-06) register here as they land.
 *
 * @param {string} [dir]
 * @returns {{ ok: boolean, version: string, modules: string[], issues: Issue[] }}
 */
export function validateSpecs(dir) {
	const specs = loadSpecs(dir);
	/** @type {Issue[]} */
	const issues = [];

	if (specs.app === null) {
		issues.push({
			level: 'error',
			address: APP_SPEC,
			message: `missing ${APP_SPEC}.t — every app needs an app spec`
		});
	}

	for (const [name, value] of Object.entries(specs.modules)) {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			issues.push({
				level: 'error',
				address: name,
				message: `${specs.files[name] ?? `${name}.t`} must be an object, got ${Array.isArray(value) ? 'array' : typeof value}`
			});
			continue;
		}
		if (value.module !== name) {
			issues.push({
				level: 'error',
				address: name,
				message: `module field ${JSON.stringify(value.module)} does not match file name "${name}"`
			});
		}
		issues.push(...schemaIssues(MODULE_SCHEMA, value, name));
		for (const unit of listUnits(name, value)) {
			issues.push(...schemaIssues(UNIT_SCHEMAS[unit.kind], unit.value, unit.address));
			if (IDENTIFIER_KINDS.has(unit.kind) && RESERVED_WORDS.has(unit.name)) {
				issues.push({
					level: 'error',
					address: unit.address,
					message: `${unit.kind} name "${unit.name}" is a reserved JavaScript word and cannot become an exported identifier — rename it (e.g. "remove" instead of "delete")`
				});
			}
		}
	}

	if (specs.app !== null) {
		issues.push(...schemaIssues(APP_SCHEMA, specs.app, APP_SPEC));
	}

	issues.push(...indexUnits(specs.modules).issues);
	issues.push(...refineSpecs(specs));

	return {
		ok: !issues.some((i) => i.level === 'error'),
		version: specs.version,
		modules: Object.keys(specs.modules),
		issues
	};
}
