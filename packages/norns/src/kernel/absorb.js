/**
 * Absorb — propose replacing custom bodies with spec (K-19, PLAN §268).
 *
 * `absorbUnit` statically analyses a Level-2 (`impl: custom`) action body
 * and, when every statement is expressible in the vetted step vocabulary
 * (`set` with literal fields, `emit`), returns spec ops that `spec.apply`
 * can run to make the unit generated again. The analyser is deliberately
 * conservative: any statement, import, or expression it cannot prove
 * equivalent makes the unit non-absorbable with a reason — absorb never
 * guesses. Custom ratio per module is the companion health metric,
 * surfaced past ~25% (PLAN: remedied by absorb suggestions, never refusal).
 */

import { listUnits, parseAddress } from './address.js';
import { actionEntity } from './emit-units.js';

export const CUSTOM_RATIO_THRESHOLD = 0.25;

/** Every `impl: custom` unit across the app, as address records. */
export function customUnits(specs) {
	const units = [];
	for (const [moduleName, moduleSpec] of Object.entries(specs.modules ?? {})) {
		for (const unit of listUnits(moduleName, moduleSpec)) {
			if (unit.value?.impl === 'custom') units.push(unit);
		}
	}
	return units;
}

/** Per-module custom-body health: { modules: { m: { custom, total, ratio, surfaced } }, app }. */
export function customRatio(specs, { threshold = CUSTOM_RATIO_THRESHOLD } = {}) {
	const modules = {};
	let custom = 0;
	let total = 0;
	for (const [moduleName, moduleSpec] of Object.entries(specs.modules ?? {})) {
		const units = listUnits(moduleName, moduleSpec);
		const own = units.filter((u) => u.value?.impl === 'custom').length;
		const ratio = units.length === 0 ? 0 : own / units.length;
		modules[moduleName] = { custom: own, total: units.length, ratio, surfaced: ratio > threshold };
		custom += own;
		total += units.length;
	}
	const ratio = total === 0 ? 0 : custom / total;
	return { modules, app: { custom, total, ratio, surfaced: ratio > threshold } };
}

/** Where a custom body lives, relative to the project root. */
export function customBodyPath(address) {
	const { module, kind, name } = parseAddress(address);
	if (kind === 'Action') return `src/${module}/actions/${name}.c`;
	if (kind === 'Page') return `src/${module}/pages/${name}.n`;
	return null;
}

function stripComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** Merge lines into statements by bracket balance. Strings that unbalance
 * brackets just make the statement unrecognisable — a safe failure. */
function splitStatements(text) {
	const out = [];
	let buf = '';
	let depth = 0;
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line === '') continue;
		buf = buf === '' ? line : `${buf} ${line}`;
		for (const ch of line) {
			if (ch === '(' || ch === '[' || ch === '{') depth += 1;
			else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
		}
		if (depth <= 0) {
			out.push(buf);
			buf = '';
			depth = 0;
		}
	}
	if (buf !== '') out.push(buf);
	return out;
}

function splitTopCommas(text) {
	const parts = [];
	let depth = 0;
	let buf = '';
	for (const ch of text) {
		if (ch === '(' || ch === '[' || ch === '{') depth += 1;
		else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
		if (ch === ',' && depth === 0) {
			parts.push(buf);
			buf = '';
			continue;
		}
		buf += ch;
	}
	if (buf.trim() !== '') parts.push(buf);
	return parts;
}

function parseLiteral(text) {
	const t = text.trim().replace(/;$/, '').trim();
	if (/^'(?:[^'\\]|\\.)*'$/.test(t)) return { ok: true, value: t.slice(1, -1).replace(/\\(.)/g, '$1') };
	try {
		const value = JSON.parse(t);
		const type = typeof value;
		if (value === null || type === 'string' || type === 'number' || type === 'boolean') {
			return { ok: true, value };
		}
	} catch {
		// fall through — not a literal
	}
	return { ok: false };
}

/** `{ field: literal, ... }` inner text → { ok, fields } */
function parseLiteralObject(inner) {
	const fields = {};
	for (const part of splitTopCommas(inner)) {
		const m = part.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/);
		if (!m) return { ok: false, at: part.trim() };
		const lit = parseLiteral(m[2]);
		if (!lit.ok) return { ok: false, at: part.trim() };
		fields[m[1]] = lit.value;
	}
	return { ok: true, fields };
}

const DB_RESOLVE_RE = /^(?:const\s+db\s*=|db\s*:=)\s*container\s*\.\s*resolve\(\s*(['"])db\1\s*\)\s*;?$/;
const UPDATE_RE =
	/^await\s+db\s*\.\s*update\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\.\s*set\(\s*\{([\s\S]*)\}\s*\)\s*\.\s*where\(\s*eq\(\s*([A-Za-z_$][\w$]*)\s*\.\s*id\s*,\s*input\s*\.\s*([\w$]+)\s*\)\s*\)\s*;?$/;
const EMIT_RE =
	/^await\s+container\s*\.\s*resolve\(\s*(['"])events\1\s*\)\s*\.\s*emit\(\s*(['"])([\w.-]+)\2\s*(?:,\s*\{\s*row\s*,\s*input\s*,\s*user\s*\}\s*)?\)\s*;?$/;
const RETURN_RE = /^return(?:\s*(\{[\s\S]*\}))?\s*;?$/;
const CONTRACT_RE = /export\s+default\s+(?:async\s+)?\(\s*\{([^}]*)\}\s*\)\s*(?:=>|->)\s*\{/;
const IMPORT_RE = /^import\s*\{\s*([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;?$/;

const CONTRACT_PARAMS = new Set(['row', 'input', 'container', 'user']);

/**
 * Analyse one custom unit. Returns
 * `{ address, absorbable: false, reason }` or
 * `{ address, absorbable: true, ops, steps, notes }`.
 *
 * @param {{ app: object|null, modules: Record<string, object> }} specs
 * @param {string} address  e.g. `orders.Action.price`
 * @param {string|null} source  the custom body's source text
 */
export function absorbUnit(specs, address, source) {
	const { module, kind, name } = parseAddress(address);
	const no = (reason) => ({ address, absorbable: false, reason });

	const unit = specs.modules?.[module]?.[kind === 'Action' ? 'actions' : kind === 'Page' ? 'pages' : '']?.[name];
	if (!unit) return no(`no ${kind} unit at ${address}`);
	if (unit.impl !== 'custom') return no('unit is already generated (impl is not custom)');
	if (kind === 'Page') {
		return no('page bodies are not analysed yet — the component vocabulary does not cover arbitrary markup');
	}
	if (kind !== 'Action') return no(`${kind} units cannot be custom`);
	if (typeof source !== 'string' || source.trim() === '') {
		return no(`custom body not found (expected ${customBodyPath(address)})`);
	}

	const target = actionEntity(module, unit, specs);
	if (!target) return no('action has no resolvable target entity — nothing to express steps against');
	const idKey =
		Object.keys(unit.input ?? {})
			.sort()
			.find((k) => unit.input[k] === `${target.entity}.id`) ?? null;

	const clean = stripComments(source);
	const contract = clean.match(CONTRACT_RE);
	if (!contract) return no('body is not a `export default async ({ … }) => { … }` block');
	const params = contract[1]
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean);
	for (const p of params) {
		if (!CONTRACT_PARAMS.has(p)) return no(`contract parameter "${p}" is outside { row, input, container, user }`);
	}

	// Imports: only drizzle's `eq` and the target entity's schema are vocabulary.
	const head = clean.slice(0, contract.index);
	for (const stmt of splitStatements(head)) {
		const m = stmt.match(IMPORT_RE);
		if (!m) return no(`unrecognised statement before the body: \`${stmt}\``);
		const names = m[1].split(',').map((n) => n.trim());
		const from = m[3];
		if (from === 'drizzle-orm') {
			if (names.every((n) => n === 'eq')) continue;
			return no(`import { ${names.join(', ')} } from 'drizzle-orm' — only \`eq\` is in vocabulary`);
		}
		if (/(^|\/)schema\.c$/.test(from) && names.length === 1 && names[0] === target.entity) continue;
		return no(`import from '${from}' is outside the generated vocabulary`);
	}

	const bodyStart = contract.index + contract[0].length;
	const bodyEnd = clean.lastIndexOf('}');
	if (bodyEnd <= bodyStart) return no('could not find the end of the body block');
	const body = clean.slice(bodyStart, bodyEnd);

	const steps = [];
	const notes = [];
	const setFields = {};
	for (const stmt of splitStatements(body)) {
		if (DB_RESOLVE_RE.test(stmt)) continue; // the generated shell resolves db itself

		const update = stmt.match(UPDATE_RE);
		if (update) {
			const [, entity, inner, whereEntity, whereKey] = update;
			if (entity !== target.entity || whereEntity !== target.entity) {
				return no(`update targets ${entity} but the action's entity is ${target.entity}`);
			}
			if (idKey === null || whereKey !== idKey) {
				return no(`where clause uses input.${whereKey}, not the action's ${target.entity}.id input`);
			}
			const parsed = parseLiteralObject(inner);
			if (!parsed.ok) {
				return no(`set field \`${parsed.at}\` is not a literal — the step vocabulary only takes literal values`);
			}
			Object.assign(setFields, parsed.fields);
			steps.push({ set: { entity: target.entity, ...parsed.fields } });
			if ('status' in parsed.fields) {
				notes.push('the generated shell adds the machine-edge guard for status writes (K-17)');
			}
			continue;
		}

		const emit = stmt.match(EMIT_RE);
		if (emit) {
			steps.push({ emit: emit[3] });
			continue;
		}

		const ret = stmt.match(RETURN_RE);
		if (ret) {
			if (ret[1] === undefined) continue;
			const parsed = parseLiteralObject(ret[1].slice(1, -1));
			if (!parsed.ok) return no(`return value \`${ret[1]}\` is not a literal object`);
			const entries = Object.entries(parsed.fields);
			const redundant = entries.every(([k, v]) => (k === 'ok' && v === true) || setFields[k] === v);
			if (!redundant) {
				return no('return value carries data the generated shell would not (it returns { ok: true })');
			}
			if (entries.some(([k]) => k !== 'ok')) {
				notes.push('the custom return of row fields is dropped — generated actions return { ok: true }; read fresh values through a query');
			}
			continue;
		}

		return no(`statement is outside the step vocabulary: \`${stmt}\``);
	}

	const base = `${module}.Action.${name}`;
	const ops = [];
	if (steps.length > 0) ops.push({ op: 'set', path: `${base}.steps`, value: steps });
	ops.push({ op: 'remove', path: `${base}.impl` });
	notes.push(`delete ${customBodyPath(address)} after applying — the generated body replaces it`);

	return { address, absorbable: true, ops, steps, notes };
}

/**
 * Scan the whole app: every custom unit gets an absorb verdict, plus the
 * custom-ratio health metric.
 *
 * @param {{ app: object|null, modules: Record<string, object> }} specs
 * @param {(relPath: string) => string|null} readSource
 */
export function absorbApp(specs, readSource) {
	const candidates = customUnits(specs).map((unit) => {
		const rel = customBodyPath(unit.address);
		const source = rel === null ? null : readSource(rel);
		return absorbUnit(specs, unit.address, source);
	});
	return { candidates, ratio: customRatio(specs) };
}
