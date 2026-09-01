/**
 * Cross-unit refinements (K-06) — everything the per-kind meta-schemas
 * cannot see because it spans units or modules: references resolve, the
 * `depends:` graph is a DAG, status machines are closed, gated features
 * stay refused.
 *
 * A module listed in `depends:` but not present in `specs/` is treated as
 * external (e.g. the platform-provided `core` module before it is
 * materialized); references into it are not resolvable and are skipped.
 * References into modules that are neither loaded nor declared are errors.
 */

import { formatAddress, indexUnits, isAddress, parseAddress } from './address.js';

/** @typedef {{ level: 'error' | 'warning', address: string, message: string }} Issue */

/**
 * @param {{ app: *, modules: Record<string, *> }} specs
 * @returns {Issue[]}
 */
export function refineSpecs(specs) {
	const { modules, app } = specs;
	const index = indexUnits(modules);
	/** @type {Issue[]} */
	const issues = [];

	const dependsOf = (moduleName) => {
		const d = modules[moduleName]?.depends;
		return Array.isArray(d) ? d : [];
	};

	/**
	 * Resolve `ref` from `fromModule` expecting a unit of `kind`.
	 * Bare names resolve within the module; full addresses anywhere.
	 * Returns null when the ref points into an external (declared) module.
	 */
	function checkRef(at, fromModule, ref, kind, what) {
		if (typeof ref !== 'string') return;
		let target;
		if (isAddress(ref)) {
			const addr = parseAddress(ref);
			if (!(addr.module in modules)) {
				if (addr.module === fromModule || dependsOf(fromModule).includes(addr.module)) return;
				issues.push({
					level: 'error',
					address: at,
					message: `${what} "${ref}" points into unknown module "${addr.module}" (not loaded, not in depends)`
				});
				return;
			}
			if (addr.kind !== kind) {
				issues.push({
					level: 'error',
					address: at,
					message: `${what} "${ref}" must reference a ${kind}, not a ${addr.kind}`
				});
				return;
			}
			target = ref;
		} else {
			target = formatAddress({ module: fromModule, kind, name: ref.split('.')[0] });
		}
		if (!index.byAddress.has(target)) {
			issues.push({
				level: 'error',
				address: at,
				message: `${what} "${ref}" does not resolve (no ${target})`
			});
		}
	}

	// depends: modules exist (or are external-by-convention? no — depends
	// names must be loaded or the well-known platform module "core") and form a DAG.
	for (const [name, spec] of Object.entries(modules)) {
		for (const dep of dependsOf(name)) {
			if (!(dep in modules) && dep !== 'core') {
				issues.push({
					level: 'error',
					address: name,
					message: `depends: unknown module "${dep}"`
				});
			}
		}
	}
	const visiting = new Set();
	const done = new Set();
	function visit(name, chain) {
		if (done.has(name)) return;
		if (visiting.has(name)) {
			issues.push({
				level: 'error',
				address: name,
				message: `depends: cycle ${[...chain, name].join(' -> ')}`
			});
			return;
		}
		visiting.add(name);
		for (const dep of dependsOf(name)) {
			if (dep in modules) visit(dep, [...chain, name]);
		}
		visiting.delete(name);
		done.add(name);
	}
	for (const name of Object.keys(modules)) visit(name, []);

	const remoteEnabled = app?.settings?.remoteTransport === true;

	for (const unit of index.units) {
		const { address: at, module: mod, kind, value } = unit;
		switch (kind) {
			case 'Entity': {
				if (typeof value?.owner === 'string' && !(value.owner in (value.fields ?? {}))) {
					issues.push({
						level: 'error',
						address: at,
						message: `owner "${value.owner}" is not a field of this entity`
					});
				}
				for (const [fname, f] of Object.entries(value?.fields ?? {})) {
					if (f && typeof f === 'object' && f.type === 'ref') {
						checkRef(at, mod, f.ref, 'Entity', `fields.${fname}.ref`);
					}
				}
				const status = value?.status;
				if (status && typeof status === 'object') {
					for (const [state, nexts] of Object.entries(status)) {
						for (const nxt of Array.isArray(nexts) ? nexts : []) {
							if (!(nxt in status)) {
								issues.push({
									level: 'error',
									address: at,
									message: `status: transition ${state} -> ${nxt} targets an undeclared state`
								});
							}
						}
					}
				}
				break;
			}
			case 'Query':
				checkRef(at, mod, value?.from, 'Entity', 'from');
				break;
			case 'Action': {
				for (const ref of Array.isArray(value?.refresh) ? value.refresh : []) {
					checkRef(at, mod, ref, 'Query', 'refresh');
				}
				if (value?.transport === 'remote' && !remoteEnabled) {
					issues.push({
						level: 'error',
						address: at,
						message:
							'transport: remote is not enabled — opt in with app settings.remoteTransport: true (runtime support landed with R-11)'
					});
				}
				break;
			}
			case 'Policy': {
				const entityAddr = formatAddress({ module: mod, kind: 'Entity', name: unit.name });
				if (!index.byAddress.has(entityAddr)) {
					issues.push({
						level: 'error',
						address: at,
						message: `policy "${unit.name}" does not match an entity in module "${mod}"`
					});
				}
				for (const actionName of Object.keys(value?.run ?? {})) {
					checkRef(at, mod, actionName, 'Action', 'run');
				}
				break;
			}
			case 'Page': {
				for (const comp of Array.isArray(value?.components) ? value.components : []) {
					if (comp && typeof comp === 'object') {
						for (const [key, bound] of Object.entries(comp)) {
							if (typeof bound === 'string' && isAddress(bound)) {
								const addr = parseAddress(bound);
								checkRef(at, mod, bound, addr.kind, `components.${key}`);
							}
						}
					}
				}
				break;
			}
			case 'Trigger': {
				const action = typeof value === 'string' ? value : value?.action;
				checkRef(at, mod, action, 'Action', 'trigger action');
				break;
			}
			case 'Component': {
				for (const [event, target] of Object.entries(value?.events ?? {})) {
					checkRef(at, mod, target, 'Action', `events.${event}`);
				}
				break;
			}
		}
	}

	return issues;
}
