/**
 * Service client runtime (D15/K-21, R-15).
 *
 * The generated `lib/<m>/services.c` calls `serviceClient(def)` with the
 * spec-derived manifest; each declared operation becomes
 * `client.<op>(args, container)`.
 *
 * Credentials resolve at call time, never from spec: `def.auth.binding`
 * names an env binding looked up on the container's `env` token when one is
 * bound (Cloudflare per-request scope) and `process.env` otherwise (dev).
 */

export class ServiceError extends Error {
	/**
	 * @param {string} service unit address (`crm.Service.mailer`)
	 * @param {string} operation
	 * @param {number} status HTTP status (0 for transport failures)
	 * @param {*} body parsed response body (or error message)
	 */
	constructor(service, operation, status, body) {
		super(`${service}.${operation} failed with ${status}`);
		this.name = 'ServiceError';
		this.service = service;
		this.operation = operation;
		this.status = status;
		this.body = body;
	}
}

/** Env for credential lookups: container `env` token when bound, else process.env. */
export function envOf(container) {
	if (container?.has?.('env')) return container.resolve('env') ?? {};
	return globalThis.process?.env ?? {};
}

function credential(def, container) {
	const { mode, binding } = def.auth ?? { mode: 'none' };
	if (mode === 'none') return null;
	const value = envOf(container)[binding];
	if (!value) throw new Error(`Service ${def.name}: env binding "${binding}" is not set`);
	return value;
}

async function authHeaders(def, container, bodyText) {
	const { mode, header } = def.auth ?? { mode: 'none' };
	if (mode === 'none') return {};
	const value = credential(def, container);
	switch (mode) {
		case 'bearer':
			return { authorization: `Bearer ${value}` };
		case 'basic':
			return { authorization: `Basic ${btoa(value)}` };
		case 'header':
			return { [header]: value };
		case 'hmac':
			return { 'x-signature': await hmacHex(value, bodyText ?? '') };
		default:
			return {};
	}
}

/** HMAC-SHA-256 hex of `text` keyed by `secret` — signing and inbound verification. */
export async function hmacHex(secret, text) {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const TYPE_OK = {
	text: (x) => typeof x === 'string',
	email: (x) => typeof x === 'string' && x.includes('@'),
	url: (x) => typeof x === 'string',
	date: (x) => typeof x === 'string' || x instanceof Date,
	datetime: (x) => typeof x === 'string' || x instanceof Date,
	int: (x) => Number.isInteger(x),
	number: (x) => typeof x === 'number',
	money: (x) => typeof x === 'number',
	bool: (x) => typeof x === 'boolean',
	json: () => true
};

/** Contract check for an operation's input/output shape (spec field types; entity refs pass through). */
export function shapeIssues(shape, value, label) {
	const issues = [];
	for (const [key, t] of Object.entries(shape ?? {})) {
		const spec = typeof t === 'string' ? t : (t?.type ?? 'json');
		const optional = typeof t === 'string' ? t.endsWith('?') : t?.optional === true;
		const type = spec.replace(/\?$/, '');
		const val = value?.[key];
		if (val === undefined || val === null) {
			if (!optional) issues.push(`missing ${label} "${key}"`);
			continue;
		}
		if (!(TYPE_OK[type] ?? (() => true))(val)) issues.push(`${label} "${key}": expected ${type}`);
	}
	return issues;
}

/**
 * Build a typed client from a Service manifest.
 *
 * @param {{
 *   name: string,
 *   base: string,
 *   auth?: { mode: 'none'|'bearer'|'basic'|'hmac'|'header', binding?: string, header?: string },
 *   timeoutMs?: number,
 *   operations: Record<string, { method?: string, path?: string, input?: Record<string, *>, output?: * }>
 * }} def
 * @param {typeof fetch} [fetchImpl] injectable for tests
 * @returns {Record<string, (args?: Record<string, *>, container?: *) => Promise<*>>}
 */
export function serviceClient(def, fetchImpl) {
	const client = {};
	for (const [opName, op] of Object.entries(def.operations ?? {})) {
		client[opName] = async (args = {}, container) => {
			const inputIssues = shapeIssues(op.input, args, 'input');
			if (inputIssues.length > 0) {
				throw new Error(`Service ${def.name}.${opName}: ${inputIssues.join('; ')}`);
			}
			// Op-level container override — trace fixtures and tests bind
			// `<service address>.<op>` to bypass the network after validation.
			const fixtureKey = `${def.name}.${opName}`;
			if (container?.has?.(fixtureKey)) {
				return await container.resolve(fixtureKey)(args);
			}
			const method = (op.method ?? 'POST').toUpperCase();
			const rest = { ...args };
			const path = (op.path ?? `/${opName}`).replace(
				/\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
				(_, k) => {
					delete rest[k];
					return encodeURIComponent(String(args[k]));
				}
			);
			let url = def.base.replace(/\/$/, '') + path;
			let bodyText;
			if (method === 'GET' || method === 'DELETE') {
				const qs = new URLSearchParams();
				for (const [k, val] of Object.entries(rest)) {
					if (val !== undefined && val !== null) qs.set(k, String(val));
				}
				const q = qs.toString();
				if (q) url += `?${q}`;
			} else {
				bodyText = JSON.stringify(rest);
			}
			const headers = {
				accept: 'application/json',
				...(bodyText !== undefined ? { 'content-type': 'application/json' } : {}),
				...(await authHeaders(def, container, bodyText))
			};
			let res;
			try {
				res = await (fetchImpl ?? fetch)(url, {
					method,
					headers,
					...(bodyText !== undefined ? { body: bodyText } : {}),
					signal: AbortSignal.timeout(def.timeoutMs ?? 10_000)
				});
			} catch (err) {
				throw new ServiceError(def.name, opName, 0, String(err?.message ?? err));
			}
			const text = await res.text();
			let data;
			try {
				data = text ? JSON.parse(text) : null;
			} catch {
				data = text;
			}
			if (!res.ok) throw new ServiceError(def.name, opName, res.status, data);
			if (op.output && typeof op.output === 'object') {
				const outIssues = shapeIssues(op.output, data, 'output');
				if (outIssues.length > 0) {
					throw new ServiceError(def.name, opName, res.status, { contract: outIssues, data });
				}
			}
			return data;
		};
	}
	return client;
}
