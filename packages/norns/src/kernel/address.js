/**
 * Addressing — stable identity for spec units.
 *
 * A unit lives at `module.Kind.name` (e.g. `orders.Action.submit`); a path
 * extends that with a dotted sub-path into the unit's value
 * (`orders.Entity.Order.fields.note`). Every object-valued unit also carries
 * an immutable `uid` (ULID), so references survive renames: the address is
 * how humans and specs refer to a unit, the uid is how history and the edge
 * graph do.
 *
 * Unit names may themselves contain dots (Trigger sources like
 * `catalog.Product.deleted`), so splitting a path into name vs sub-path is
 * only possible against a loaded spec — that is what the index is for.
 */

import { randomBytes } from 'node:crypto';

/** Spec collection key → unit kind. Order irrelevant; keys are the schema. */
export const KIND_KEYS = {
	Entity: 'entities',
	Query: 'queries',
	Action: 'actions',
	Policy: 'policies',
	Page: 'pages',
	Trigger: 'triggers',
	Function: 'functions',
	Component: 'components',
	Snippet: 'snippets',
	Service: 'services',
	Job: 'jobs',
	Endpoint: 'endpoints',
	Worker: 'workers',
	Adapter: 'adapters',
	Middleware: 'middleware',
	Plugin: 'plugins'
};

export const KINDS = Object.keys(KIND_KEYS);

/** @type {Record<string, string>} collection key → Kind */
export const KEY_KINDS = Object.fromEntries(Object.entries(KIND_KEYS).map(([k, v]) => [v, k]));

const MODULE_RE = /^[a-z][a-z0-9_]*$/;
const NAME_SEGMENT_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

/** @typedef {{ module: string, kind: string, name: string }} Address */

/** `orders.Action.submit` ← { module, kind, name }. */
export function formatAddress({ module, kind, name }) {
	return `${module}.${kind}.${name}`;
}

/**
 * Parse a unit address. The second segment must be a known Kind; everything
 * after it is the name (which may itself contain dots).
 *
 * @param {string} text
 * @returns {Address}
 */
export function parseAddress(text) {
	const parts = String(text).split('.');
	const [module, kind] = parts;
	const name = parts.slice(2).join('.');
	if (parts.length < 3 || name === '') {
		throw new Error(`invalid address "${text}" — expected module.Kind.name`);
	}
	if (!MODULE_RE.test(module)) {
		throw new Error(`invalid address "${text}" — bad module segment "${module}"`);
	}
	if (!KINDS.includes(kind)) {
		throw new Error(`invalid address "${text}" — unknown kind "${kind}"`);
	}
	if (!parts.slice(2).every((s) => NAME_SEGMENT_RE.test(s))) {
		throw new Error(`invalid address "${text}" — bad name "${name}"`);
	}
	return { module, kind, name };
}

/** @param {string} text */
export function isAddress(text) {
	try {
		parseAddress(text);
		return true;
	} catch {
		return false;
	}
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** New ULID — 10 chars of timestamp + 16 chars of randomness, sortable. */
export function newUid(now = Date.now()) {
	let ts = '';
	let t = now;
	for (let i = 0; i < 10; i++) {
		ts = CROCKFORD[t % 32] + ts;
		t = Math.floor(t / 32);
	}
	const bytes = randomBytes(16);
	let rand = '';
	for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
	return ts + rand;
}

function isUnitObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @typedef {{
 *   address: string, module: string, kind: string, name: string,
 *   uid: string | null, value: *
 * }} Unit
 */

/**
 * List every unit in one module spec.
 *
 * @param {string} moduleName
 * @param {*} moduleSpec
 * @returns {Unit[]}
 */
export function listUnits(moduleName, moduleSpec) {
	const units = [];
	if (!isUnitObject(moduleSpec)) return units;
	for (const [key, kind] of Object.entries(KEY_KINDS)) {
		const collection = moduleSpec[key];
		if (!isUnitObject(collection)) continue;
		for (const [name, value] of Object.entries(collection)) {
			units.push({
				address: formatAddress({ module: moduleName, kind, name }),
				module: moduleName,
				kind,
				name,
				uid: isUnitObject(value) && typeof value.uid === 'string' ? value.uid : null,
				value
			});
		}
	}
	return units;
}

/**
 * Assign a fresh uid to every object-valued unit that lacks one, mutating
 * the module specs in place (string-shorthand units carry no uid until
 * they are expanded to objects).
 *
 * @param {Record<string, *>} modules module name → spec value
 * @returns {string[]} addresses that received a uid
 */
export function ensureUids(modules) {
	const assigned = [];
	for (const [moduleName, spec] of Object.entries(modules)) {
		for (const unit of listUnits(moduleName, spec)) {
			if (unit.uid === null && isUnitObject(unit.value)) {
				unit.value.uid = newUid();
				assigned.push(unit.address);
			}
		}
	}
	return assigned;
}

/**
 * @typedef {{
 *   units: Unit[],
 *   byAddress: Map<string, Unit>,
 *   byUid: Map<string, Unit>,
 *   issues: { level: 'error', address: string, message: string }[]
 * }} UnitIndex
 */

/**
 * Index all units across an app's modules for address/uid resolution.
 * Duplicate uids are reported as issues (addresses cannot collide — they
 * are object keys).
 *
 * @param {Record<string, *>} modules
 * @returns {UnitIndex}
 */
export function indexUnits(modules) {
	const units = [];
	const byAddress = new Map();
	const byUid = new Map();
	const issues = [];
	for (const [moduleName, spec] of Object.entries(modules)) {
		for (const unit of listUnits(moduleName, spec)) {
			units.push(unit);
			byAddress.set(unit.address, unit);
			if (unit.uid !== null) {
				const prior = byUid.get(unit.uid);
				if (prior) {
					issues.push({
						level: 'error',
						address: unit.address,
						message: `duplicate uid ${unit.uid} — already used by ${prior.address}`
					});
				} else {
					byUid.set(unit.uid, unit);
				}
			}
		}
	}
	return { units, byAddress, byUid, issues };
}

/**
 * Resolve a path (`module.Kind.name[.sub.path]`) against an index. Because
 * unit names may contain dots, the longest name that matches an existing
 * unit wins; the remainder is the sub-path.
 *
 * @param {UnitIndex} index
 * @param {string} text
 * @returns {{ unit: Unit, subPath: string[] } | null}
 */
export function resolvePath(index, text) {
	const parts = String(text).split('.');
	if (parts.length < 3) return null;
	const [module, kind] = parts;
	const rest = parts.slice(2);
	for (let take = rest.length; take >= 1; take--) {
		const name = rest.slice(0, take).join('.');
		const unit = index.byAddress.get(formatAddress({ module, kind, name }));
		if (unit) return { unit, subPath: rest.slice(take) };
	}
	return null;
}
