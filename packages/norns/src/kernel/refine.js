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

	/**
	 * `call` steps may target a service operation
	 * (`<module>.Service.<name>.<op>`) — the service and operation must both
	 * exist. Other call targets are container tokens, resolved at runtime.
	 */
	function checkServiceCall(at, fromModule, call) {
		const m = /^([a-z][a-z0-9_]*)\.Service\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(
			call
		);
		if (!m) return;
		const [, module, service, op] = m;
		if (!(module in modules)) {
			if (dependsOf(fromModule).includes(module)) return;
			issues.push({
				level: 'error',
				address: at,
				message: `call "${call}" points into unknown module "${module}" (not loaded, not in depends)`
			});
			return;
		}
		const svc = modules[module]?.services?.[service];
		if (!svc) {
			issues.push({
				level: 'error',
				address: at,
				message: `call "${call}" does not resolve (no ${module}.Service.${service})`
			});
			return;
		}
		if (!svc.operations?.[op]) {
			issues.push({
				level: 'error',
				address: at,
				message: `call "${call}": service "${service}" has no operation "${op}"`
			});
		}
	}

	/** Shared step checks for Actions and Jobs: service calls and job enqueues resolve. */
	function checkFlowSteps(at, fromModule, unitValue) {
		for (const step of Array.isArray(unitValue?.steps) ? unitValue.steps : []) {
			if (typeof step?.call === 'string') checkServiceCall(at, fromModule, step.call);
			if (typeof step?.enqueue === 'string') {
				checkRef(at, fromModule, step.enqueue, 'Job', 'enqueue');
			}
			// D44/K-39: data steps stay one flat line — no conditionals, no
			// nesting, no cascades; anything cleverer is honestly `impl: custom`.
			if (step?.create !== undefined) {
				const c = step.create;
				if (typeof c?.entity !== 'string') {
					issues.push({ level: 'error', address: at, message: 'create step needs { entity, values }' });
				} else {
					checkRef(at, fromModule, c.entity, 'Entity', 'create.entity');
					for (const [field, value] of Object.entries(c.values ?? {})) {
						const flat =
							typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
						if (!flat) {
							issues.push({
								level: 'error',
								address: at,
								message: `STEP_TOO_CLEVER: create.values.${field} must be a flat input ref, $user, $initial, or literal`
							});
						} else if (
							typeof value === 'string' &&
							value.startsWith('input.') &&
							(unitValue.input?.[value.slice(6)] ?? undefined) === undefined
						) {
							issues.push({
								level: 'error',
								address: at,
								message: `create.values.${field}: "${value}" is not a declared input`
							});
						}
					}
				}
			}
			if (step?.delete !== undefined) {
				const d = step.delete;
				if (typeof d?.entity !== 'string') {
					issues.push({ level: 'error', address: at, message: 'delete step needs { entity, id }' });
				} else {
					checkRef(at, fromModule, d.entity, 'Entity', 'delete.entity');
					const entityName = d.entity.includes('.') ? d.entity.split('.').pop() : d.entity;
					const owner =
						modules[fromModule]?.policies?.[entityName] ??
						Object.values(modules).find((m) => m?.policies?.[entityName])?.policies?.[entityName];
					if (owner?.write === undefined) {
						issues.push({
							level: 'error',
							address: at,
							message: `delete step on ${entityName} needs the entity to declare write authority (D44/D30)`
						});
					}
				}
			}
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

	// K-40 (D45/D46): app settings are validated vocabulary, not free-form.
	const settings = app?.settings;
	if (settings && typeof settings === 'object') {
		if (settings.serializer !== undefined && !['tron', 'json'].includes(settings.serializer)) {
			issues.push({ level: 'error', address: 'app', message: 'settings.serializer must be "tron" or "json"' });
		}
		const shellNav = settings.shell && typeof settings.shell === 'object' ? settings.shell.nav : undefined;
		for (const group of Array.isArray(shellNav) ? shellNav : []) {
			for (const addr of Array.isArray(group?.pages) ? group.pages : []) {
				const [m, k, n] = String(addr).split('.');
				if (k !== 'Page' || modules[m]?.pages?.[n] === undefined) {
					issues.push({
						level: 'error',
						address: 'app',
						message: `settings.shell.nav: "${addr}" is not a declared Page`
					});
				}
			}
		}
		// Seed rows speak entity fields, exactly like `given:` fixtures (K-30).
		for (const [entName, rows] of Object.entries(settings.seed ?? {})) {
			const entitySpec = Object.values(modules).find((m) => m?.entities?.[entName])?.entities?.[entName];
			if (!entitySpec) {
				issues.push({ level: 'error', address: 'app', message: `settings.seed seeds unknown entity "${entName}"` });
				continue;
			}
			const known = new Set(['id', 'status', ...Object.keys(entitySpec.fields ?? {})]);
			for (const row of Array.isArray(rows) ? rows : []) {
				for (const key of Object.keys(row ?? {})) {
					if (!known.has(key)) {
						issues.push({
							level: 'error',
							address: 'app',
							message: `settings.seed.${entName}: "${key}" is not a field of ${entName}`
						});
					}
				}
			}
		}
	}

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
				// D30 (warning in v4.0 → refusal in v4.1): every entity declares its
				// access; a missing Policy ships with a ready-to-apply default-deny op.
				if (modules[mod]?.policies?.[unit.name] === undefined) {
					const owned = typeof value?.owner === 'string';
					issues.push({
						level: 'warning',
						address: at,
						message:
							'D30: entity has no Policy — access must be declared (default-deny becomes a refusal in v4.1)',
						op: {
							op: 'set',
							path: `${mod}.Policy.${unit.name}`,
							value: owned
								? { read: 'owner or role:admin', write: 'owner' }
								: { read: 'role:admin', write: 'role:admin' }
						}
					});
				}
				for (const [fname, f] of Object.entries(value?.fields ?? {})) {
					if (f && typeof f === 'object' && f.type === 'file' && (f.mime === undefined || f.max === undefined)) {
						issues.push({
							level: 'warning',
							address: at,
							message: `D30: file field "${fname}" should declare \`mime\` allowlist and \`max\` size`,
							op: {
								op: 'set',
								path: `${mod}.Entity.${unit.name}.fields.${fname}`,
								value: { ...f, mime: f.mime ?? ['application/octet-stream'], max: f.max ?? 10_000_000 }
							}
						});
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
					// v6 K-42: the initial state is declared or provable, never
					// alphabetical — a cyclic machine silently defaulting new rows
					// to whatever sorts first is a wrong answer, not a fallback.
					const states = Object.keys(status);
					if (value.initial !== undefined && !(value.initial in status)) {
						issues.push({
							level: 'error',
							address: at,
							message: `initial: "${value.initial}" is not a declared status state`
						});
					} else if (value.initial === undefined) {
						const targeted = new Set(Object.values(status).flat());
						const sources = states.filter((s) => !targeted.has(s));
						if (sources.length !== 1) {
							issues.push({
								level: 'error',
								address: at,
								message: `INITIAL_AMBIGUOUS: no single untargeted status state — declare \`initial\` (one of: ${states.sort().join(', ')})`
							});
						}
					}
				}
				break;
			}
			case 'Endpoint': {
				// D30: public surface declares its own limits.
				if (value?.auth?.mode === 'none' && value?.rateLimit === undefined) {
					issues.push({
						level: 'warning',
						address: at,
						message: 'D30: public endpoint (auth: none) has no rateLimit (refusal in v4.1)',
						op: { op: 'set', path: `${at}.rateLimit`, value: { per: 'ip', rpm: 60 } }
					});
				}
				break;
			}
			case 'Query': {
				checkRef(at, mod, value?.from, 'Entity', 'from');
				for (const f of Array.isArray(value?.reveal) ? value.reveal : []) {
					issues.push({
						level: 'warning',
						address: at,
						message: `D31: query reveals sensitive field "${f}" — make sure every binding of this query may see it`
					});
				}
				// K-30: `given` fixture rows must speak the seeded entity's fields —
				// drift between fixtures and schema fails validate, not the trace.
				for (const [exIndex, ex] of (Array.isArray(value?.examples) ? value.examples : []).entries()) {
					for (const [entName, rows] of Object.entries(ex?.given ?? {})) {
						const owner = modules[mod]?.entities?.[entName] ? mod : null;
						const entitySpec =
							owner !== null
								? modules[mod].entities[entName]
								: Object.values(modules).find((m) => m?.entities?.[entName])?.entities?.[entName];
						if (!entitySpec) {
							issues.push({
								level: 'error',
								address: at,
								message: `examples[${exIndex}].given seeds unknown entity "${entName}"`
							});
							continue;
						}
						const known = new Set(['id', 'status', ...Object.keys(entitySpec.fields ?? {})]);
						for (const row of Array.isArray(rows) ? rows : []) {
							for (const key of Object.keys(row ?? {})) {
								if (!known.has(key)) {
									issues.push({
										level: 'error',
										address: at,
										message: `examples[${exIndex}].given.${entName}: "${key}" is not a field of ${entName}`
									});
								}
							}
						}
					}
				}
				break;
			}
			case 'Action': {
				for (const ref of Array.isArray(value?.refresh) ? value.refresh : []) {
					checkRef(at, mod, ref, 'Query', 'refresh');
				}
				checkFlowSteps(at, mod, value);
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
				// D41 (warning v5.0 → refusal v5.1): a Page is a composition — whole
				// custom bodies deprecate in favor of Component extraction.
				if (value?.impl === 'custom') {
					issues.push({
						level: 'warning',
						address: at,
						message:
							'PAGE_BODY_DEPRECATED: custom Page bodies are deprecated (refusal in v5.1) — run spec.absorb on this page for the ready-to-apply Component extraction'
					});
				}
				for (const comp of Array.isArray(value?.components) ? value.components : []) {
					if (comp && typeof comp === 'object') {
						for (const [key, bound] of Object.entries(comp)) {
							if (key === 'with' || bound === '$data' || bound === '$form') continue;
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
			case 'Job': {
				checkFlowSteps(at, mod, value);
				break;
			}
			case 'Worker': {
				if (value?.messages) {
					for (const [i, ex] of (value.examples ?? []).entries()) {
						for (const step of ex.script ?? []) {
							if (!(step.send in value.messages)) {
								issues.push({
									level: 'error',
									address: at,
									message: `example ${i}: script sends undeclared message "${step.send}"`
								});
							}
						}
					}
				}
				break;
			}
			case 'Route': {
				issues.push({
					level: 'warning',
					address: at,
					message:
						'schema-less Route is deprecated — declare an Endpoint (route/method/auth/input/output) instead; v3.1 refuses bare Routes'
				});
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

	// K-53: an Action bound to no Page, Component event, or Trigger has no
	// HTTP route at all — SvelteKit only registers ?/name for actions a
	// page's own `actions()` export references, so an unwired action is
	// invisible at the HTTP level, not merely missing from the UI. Sweep
	// every spec-level string for each action's address (its own module's
	// actions and policies subtrees excluded: intra-action mentions and
	// policy run-guards are not invocations). Custom bodies are not scanned
	// — but a custom page cannot reach an unbound action either, so the
	// warning stands.
	{
		// Only meaningful when the app has a route surface at all — a headless
		// spec (jobs/triggers/endpoints, no pages yet) invokes actions without
		// page bindings, and flagging every action there is noise.
		const hasPages = Object.values(modules).some((m) => Object.keys(m?.pages ?? {}).length > 0);
		const referenced = new Set();
		const sweep = (value) => {
			if (typeof value === 'string') {
				if (isAddress(value) && parseAddress(value).kind === 'Action') referenced.add(value);
				return;
			}
			if (Array.isArray(value)) for (const item of value) sweep(item);
			else if (value && typeof value === 'object') for (const item of Object.values(value)) sweep(item);
		};
		for (const moduleSpec of Object.values(modules)) {
			const { actions: _actions, policies: _policies, ...rest } = moduleSpec ?? {};
			sweep(rest);
		}
		for (const [mod, moduleSpec] of Object.entries(modules)) {
			for (const name of Object.keys(moduleSpec?.actions ?? {})) {
				if (!hasPages) break;
				const address = `${mod}.Action.${name}`;
				if (referenced.has(address)) continue;
				issues.push({
					level: 'warning',
					address,
					message: `action is wired to no Page, Component event, or Trigger — no ?/${name} route will exist, so it is unreachable over HTTP; bind it or remove it`
				});
			}
		}
	}

	return issues;
}
