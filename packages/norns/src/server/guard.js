import { error } from '@sveltejs/kit';

/**
 * Deny-by-default policy guard over the CEL-compiled policy objects the
 * generator emits (`{ read: { check, where }, write: { check, where }, run? }`).
 *
 * - Missing policy, missing rule, or a rule without a `check` function → 403.
 * - A `check` that throws counts as a denial, never as a bypass.
 *
 * @param {*} policy   emitted policy object (e.g. `OrderPolicy`)
 * @param {'read' | 'write'} kind
 * @param {{ row?: *, user?: * }} [ctx]
 * @returns {true}
 */
export function guard(policy, kind, { row, user } = {}) {
	const rule = policy?.[kind];
	if (typeof rule?.check !== 'function') throw error(403, 'forbidden');
	let ok = false;
	try {
		ok = rule.check(row, user) === true;
	} catch {
		ok = false;
	}
	if (!ok) throw error(403, 'forbidden');
	return true;
}

/**
 * Guard a named action against `policy.run[action]` predicates. Actions
 * without a run rule pass (the write guard is the floor; run rules narrow).
 *
 * @param {*} policy
 * @param {string} action
 * @param {{ row?: *, user?: * }} [ctx]
 * @returns {true}
 */
export function guardRun(policy, action, { row, user } = {}) {
	const rule = policy?.run?.[action];
	if (rule === undefined) return true;
	let ok = false;
	try {
		ok = (typeof rule === 'function' ? rule(row, user) : rule) === true;
	} catch {
		ok = false;
	}
	if (!ok) throw error(403, 'forbidden');
	return true;
}
