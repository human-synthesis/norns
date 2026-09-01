import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { APP_SPEC, readSpecs } from '@human-synthesis/norns-tron/spec';

import { indexUnits, listUnits } from './address.js';
import { APP_SCHEMA, MODULE_SCHEMA, UNIT_SCHEMAS, schemaIssues } from './meta.js';
import { refineSpecs } from './refine.js';

/**
 * @typedef {{ level: 'error' | 'warning', address: string, message: string }} Issue
 * @typedef {{
 *   dir: string,
 *   app: *,
 *   modules: Record<string, *>,
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
		throw new Error(`norns: no specs directory at ${abs} (expected specs/*.tron)`);
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
			message: `missing ${APP_SPEC}.tron — every app needs an app spec`
		});
	}

	for (const [name, value] of Object.entries(specs.modules)) {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			issues.push({
				level: 'error',
				address: name,
				message: `${name}.tron must be an object, got ${Array.isArray(value) ? 'array' : typeof value}`
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
