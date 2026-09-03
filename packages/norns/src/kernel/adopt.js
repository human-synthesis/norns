/**
 * Adopt — wrap existing hand-written code as Level-3 units (K-20, PLAN §268).
 *
 * `adoptUnit` inspects one hand-written source file and proposes the
 * Level-3 declaration (`{ source, auth, capabilities }` under Route /
 * Worker / Adapter / Middleware) that would bring it under spec ownership.
 * Everything is inference-with-evidence: the kind comes from the file's
 * export shape, capabilities from what it touches, and auth from whether
 * it reads the user/session — but auth is a *declaration*, so every
 * proposal says the human must confirm it. Like absorb, this only ever
 * proposes ops; nothing is applied here.
 */

import { KIND_KEYS } from './address.js';

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
const HTTP_VERBS = 'GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD';

const KIND_RULES = [
	{
		kind: 'Worker',
		test: (src, path) =>
			(/export\s+default\s*\{[^}]*\b(fetch|scheduled|queue)\b/s.test(src) && 'exports a default { fetch/scheduled/queue } worker object') ||
			(/extends\s+DurableObject\b/.test(src) && 'a class extends DurableObject') ||
			(/\bwebSocketMessage\s*[(:=]/.test(src) && 'implements webSocketMessage') ||
			(/addEventListener\(\s*['"](fetch|scheduled)['"]/.test(src) && "registers a global fetch/scheduled listener") ||
			(/\.worker\.(c|civet|js|ts)$/.test(path) && 'file is named *.worker.*')
	},
	{
		kind: 'Route',
		test: (src, path) =>
			(new RegExp(`export\\s+(?:async\\s+)?(?:function\\s+|const\\s+)?(${HTTP_VERBS})\\b`).test(src) && 'exports HTTP verb handlers') ||
			(new RegExp(`\\b(${HTTP_VERBS})\\s*:=`).test(src) && 'exports HTTP verb handlers (Civet)') ||
			(/\+server\.(c|civet|js|ts)$/.test(path) && 'file is a +server route module')
	},
	{
		kind: 'Middleware',
		test: (src) =>
			(/export\s+(?:const\s+)?handle\b|(?:^|\s)handle\s*:=/.test(src) && 'exports a `handle` hook') ||
			(/\bsequence\s*\(/.test(src) && 'composes hooks with sequence()') ||
			(/\(\s*\{\s*event\s*,\s*resolve\s*\}\s*\)/.test(src) && 'takes the ({ event, resolve }) middleware contract')
	},
	{
		kind: 'Adapter',
		test: (src) =>
			/export\s+(default|const|function|async|\{)|(?:^|\n)\s*[A-Za-z_$][\w$]*\s*:=/.test(src) &&
			'no route/worker/middleware shape — treated as an adapter around its exports'
	}
];

const CAPABILITY_RULES = [
	{ name: 'db', re: /resolve\(\s*['"]db['"]\s*\)|from\s+['"]drizzle-orm|\bD1Database\b/, why: 'touches the database' },
	{ name: 'events', re: /resolve\(\s*['"]events['"]\s*\)|\.emit\(/, why: 'emits events' },
	{ name: 'storage', re: /resolve\(\s*['"]storage['"]\s*\)|\bR2Bucket\b/, why: 'uses the storage adapter' },
	{ name: 'network', re: /\bfetch\s*\(|https?:\/\//, why: 'makes outbound network calls' },
	{ name: 'env', re: /\benv\.[A-Z_]|platform\.env|\$env\b/, why: 'reads environment bindings' },
	{ name: 'schedule', re: /\bscheduled\b|\bcron\b/i, why: 'runs on a schedule' },
	{ name: 'websocket', re: /\bWebSocket\b|webSocketMessage/, why: 'speaks WebSocket' }
];

const AUTH_RE = /locals\.user|\buser\.roles\b|\bsession\b|better-auth|\bgetUser\b/;

function nameFromPath(path) {
	const base = String(path)
		.split('/')
		.filter(Boolean)
		.pop()
		?.replace(/\.(c|civet|n|js|ts)$/, '')
		?.replace(/^\+/, '');
	if (!base) return null;
	const name = base.replace(/[^A-Za-z0-9_$-]/g, '-');
	return NAME_RE.test(name) ? name : null;
}

export function inferKind(source, path) {
	for (const rule of KIND_RULES) {
		const evidence = rule.test(source, String(path));
		if (evidence) return { kind: rule.kind, evidence };
	}
	return null;
}

export function inferCapabilities(source) {
	const capabilities = [];
	const evidence = {};
	for (const rule of CAPABILITY_RULES) {
		if (rule.re.test(source)) {
			capabilities.push(rule.name);
			evidence[rule.name] = rule.why;
		}
	}
	return { capabilities, evidence };
}

export function inferAuth(source) {
	return AUTH_RE.test(source)
		? { auth: 'authenticated', evidence: 'references the user/session' }
		: { auth: 'public', evidence: 'no user/session reference found' };
}

/**
 * Propose adopting one hand-written file as a Level-3 unit.
 *
 * @param {{ app: object|null, modules: Record<string, object> }} specs
 * @param {{ module: string, path: string, source: string|null }} file
 * @returns {{ path, adoptable: false, reason } |
 *           { path, adoptable: true, address, kind, name, ops, inferred, notes }}
 */
export function adoptUnit(specs, { module, path, source }) {
	const no = (reason) => ({ path, adoptable: false, reason });

	const moduleSpec = specs.modules?.[module];
	if (!moduleSpec) return no(`module "${module}" is not in specs — add the module before adopting into it`);
	if (typeof source !== 'string' || source.trim() === '') return no(`no source at ${path}`);

	const name = nameFromPath(path);
	if (!name) return no(`could not derive a unit name from "${path}"`);

	const kindMatch = inferKind(source, path);
	if (!kindMatch) return no('file has no recognisable exports — nothing to wrap as a unit');
	const { kind, evidence: kindEvidence } = kindMatch;

	// D69: the Route wrap kind is gone (Endpoint superseded it; Route units
	// were never emitted). Verb-handler files are still detected, but the
	// answer is a declared Endpoint, not a wrap.
	if (kind === 'Route') {
		return no(
			'exports HTTP verb handlers — declare an Endpoint (route/method/auth/input/output) and move the handler into its body; the legacy Route wrap no longer exists'
		);
	}

	const existing = moduleSpec[KIND_KEYS[kind]]?.[name];
	if (existing) return no(`${module}.${kind}.${name} already exists — rename the file or the unit`);

	const { capabilities, evidence: capabilityEvidence } = inferCapabilities(source);
	const { auth, evidence: authEvidence } = inferAuth(source);

	const value = { source: String(path), auth };
	if (capabilities.length > 0) value.capabilities = capabilities;
	if (kind === 'Worker' && /extends\s+DurableObject\b|webSocketMessage/.test(source)) value.room = true;

	const address = `${module}.${kind}.${name}`;
	return {
		path,
		adoptable: true,
		address,
		kind,
		name,
		ops: [{ op: 'set', path: address, value }],
		inferred: { kind: kindEvidence, capabilities: capabilityEvidence, auth: authEvidence },
		notes: [
			`auth was inferred as "${auth}" (${authEvidence}) — auth is a declaration, confirm it before applying`,
			'adopting declares ownership and capabilities; the file itself stays hand-written (Level 3)'
		]
	};
}

/**
 * Adopt several files at once (the `spec.adopt {path}` directory case).
 *
 * @param {{ app: object|null, modules: Record<string, object> }} specs
 * @param {{ module: string, files: Array<{ path: string, source: string|null }> }} input
 */
export function adoptFiles(specs, { module, files }) {
	return { proposals: files.map(({ path, source }) => adoptUnit(specs, { module, path, source })) };
}
