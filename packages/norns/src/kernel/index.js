/**
 * Norns kernel — the spec-canonical engine (`@human-synthesis/norns/kernel`).
 *
 * Owns the pipeline: load `specs/*.tron` → validate → generate code into
 * `.norns/generated/`. Kept as a subpath of the norns package (not its own
 * package) but with no imports from the rest of `src/`, so it stays
 * extractable if it ever needs its own release cadence.
 */

export {
	KINDS,
	KIND_KEYS,
	KEY_KINDS,
	formatAddress,
	parseAddress,
	isAddress,
	newUid,
	listUnits,
	ensureUids,
	indexUnits,
	resolvePath
} from './address.js';
export { CMP_OPS, parseExpr, printExpr, isExpr } from './expr.js';
export { evalExpr, compileGuard, compileWhere } from './expr-compile.js';
export {
	FIELD_TYPES,
	DIALECTS,
	UNIT_SCHEMAS,
	MODULE_SCHEMA,
	APP_SCHEMA,
	schemaIssues
} from './meta.js';
export {
	moduleEdges,
	buildGraph,
	createGraphCache,
	updateGraph,
	neighborhood,
	impact
} from './graph.js';
export { refineSpecs } from './refine.js';
export {
	CUSTOM_RATIO_THRESHOLD,
	customUnits,
	customRatio,
	customBodyPath,
	absorbUnit,
	absorbApp
} from './absorb.js';
export { inferKind, inferCapabilities, inferAuth, adoptUnit, adoptFiles } from './adopt.js';
export { loadSpecs, validateSpecs } from './validate.js';
export { generateApp, checkGenerate, checkBindings, layoutFile, liveRouteFile, selfCheck, GenerateError, EMITTERS } from './generate.js';
export { wranglerConfig, wranglerFile } from './emit-wrangler.js';
export { emitModuleMachines, machinesEmitter } from './emit-machines.js';
export { migrateApp } from './migrate.js';
export { traceApp, TRACE_USER } from './trace.js';
export { emitModuleSchema, schemaEmitter } from './emit-schema.js';
export {
	emitModulePolicies,
	emitModuleQueries,
	emitModuleActions,
	emitModuleTriggers,
	emitModulePages,
	emitModuleRemotes,
	policiesEmitter,
	queriesEmitter,
	actionsEmitter,
	triggersEmitter,
	pagesEmitter,
	remotesEmitter
} from './emit-units.js';
