import { error } from '@sveltejs/kit';

/**
 * Runtime status-machine enforcement over a spec transitions map
 * (`{ draft: ['submitted'], submitted: ['paid', 'cancelled'], ... }`).
 * Unknown states and undeclared transitions are always denied.
 *
 * @param {Record<string, string[]>} transitions
 */
export function machine(transitions) {
	const states = Object.keys(transitions).sort();

	// Same rule as the generated schema default: the state no transition
	// targets; falls back to the (sorted) first.
	const targeted = new Set(Object.values(transitions).flat());
	const sources = states.filter((s) => !targeted.has(s));
	const initial = sources.length === 1 ? sources[0] : states[0];

	return {
		states,
		initial,
		can(from, to) {
			return (transitions[from] ?? []).includes(to);
		},
		next(from) {
			return [...(transitions[from] ?? [])];
		},
		assert(from, to) {
			if (!this.can(from, to)) {
				throw error(409, `invalid transition ${String(from)} -> ${String(to)}`);
			}
			return to;
		}
	};
}
