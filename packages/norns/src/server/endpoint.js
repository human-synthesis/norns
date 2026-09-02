/**
 * Endpoint shell runtime (D14/K-23).
 *
 * The generated `routes<route>/+server.c` calls `endpoint(def)` with the
 * spec-derived contract plus the custom body: auth verifies *before*
 * anything else runs, input validates before the body, output validates
 * after it — or, with `def.stream`, the body's yielded frames are served
 * as SSE, each checked against the declared frame shape.
 *
 * Credentials resolve at request time from the env binding named in spec
 * (container `env` token or process.env) — never from spec values.
 */

import { json, error } from '@sveltejs/kit';

import { envOf, hmacHex, shapeIssues } from './service.js';

/** Verify the inbound request against `def.auth` (401 on mismatch). */
async function verifyAuth(def, event, bodyText, container) {
	const { mode, binding, header } = def.auth ?? { mode: 'none' };
	if (mode === 'none') return;
	const value = envOf(container)[binding];
	if (!value) {
		throw error(500, { message: `Endpoint ${def.name}: env binding "${binding}" is not set` });
	}
	const headers = event.request.headers;
	const ok =
		mode === 'bearer'
			? headers.get('authorization') === `Bearer ${value}`
			: mode === 'basic'
				? headers.get('authorization') === `Basic ${btoa(value)}`
				: mode === 'header'
					? headers.get(header) === value
					: mode === 'hmac'
						? headers.get('x-signature') === (await hmacHex(value, bodyText))
						: false;
	if (!ok) throw error(401, { message: 'unauthorized' });
}

/**
 * Rate limiting (R-17/D30): a declared `rateLimit` is enforced before auth
 * or body. When the env carries a `RATE_LIMITER` Cloudflare rate-limiting
 * binding it is used (no extra round trip); otherwise an in-process sliding
 * window backs dev and single-isolate deployments.
 */
const windows = new Map();

async function checkRateLimit(def, event, container) {
	if (!def.rateLimit) return;
	const who =
		def.rateLimit.per === 'user'
			? (event.locals?.user?.id ?? 'anonymous')
			: (event.getClientAddress?.() ?? 'unknown');
	const key = `${def.name}:${who}`;
	const native = envOf(container).RATE_LIMITER;
	if (native && typeof native.limit === 'function') {
		const { success } = await native.limit({ key });
		if (!success) throw error(429, { message: 'rate limited' });
		return;
	}
	const now = Date.now();
	const hits = (windows.get(key) ?? []).filter((t) => now - t < 60_000);
	if (hits.length >= def.rateLimit.rpm) throw error(429, { message: 'rate limited' });
	hits.push(now);
	windows.set(key, hits);
}

/** CORS (D30): 'same-origin' (the default for declared `cors`) refuses
 * cross-origin browser requests outright; 'any' answers them openly. */
function checkCors(def, event) {
	if (!def.cors) return null;
	const origin = event.request.headers.get('origin');
	if (origin === null || origin === event.url.origin) return null;
	if (def.cors === 'same-origin') throw error(403, { message: 'cross-origin request refused' });
	return origin; // 'any' — echo below
}

// Query-string values arrive as strings; nudge them toward the declared type.
const COERCE = {
	int: (s) => (/^-?\d+$/.test(s) ? Number(s) : s),
	number: (s) => (s !== '' && !Number.isNaN(Number(s)) ? Number(s) : s),
	money: (s) => (s !== '' && !Number.isNaN(Number(s)) ? Number(s) : s),
	bool: (s) => (s === 'true' ? true : s === 'false' ? false : s)
};

function coerceQuery(shape, raw) {
	for (const [key, t] of Object.entries(shape ?? {})) {
		const spec = (typeof t === 'string' ? t : t?.type ?? '').replace(/\?$/, '');
		if (COERCE[spec] && typeof raw[key] === 'string') raw[key] = COERCE[spec](raw[key]);
	}
	return raw;
}

function sseResponse(def, frames) {
	const enc = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			try {
				for await (const frame of frames) {
					const issues = def.stream?.frame ? shapeIssues(def.stream.frame, frame, 'frame') : [];
					if (issues.length > 0) throw new Error(`Endpoint ${def.name}: ${issues.join('; ')}`);
					controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
				}
				controller.enqueue(enc.encode('event: done\ndata: {}\n\n'));
			} catch (e) {
				const message = String(e?.message ?? e);
				controller.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`));
			}
			controller.close();
		}
	});
	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
}

/**
 * @param {{
 *   name: string,
 *   auth?: { mode: string, binding?: string, header?: string },
 *   input?: Record<string, *>,
 *   output?: Record<string, *>,
 *   stream?: { frame: Record<string, *> },
 *   body: (ctx: { input: *, container: *, event: *, user: * }) => *
 * }} def
 * @returns {(event: import('@sveltejs/kit').RequestEvent) => Promise<Response>}
 */
export function endpoint(def) {
	if (typeof def?.body !== 'function') throw new Error('endpoint(): `body` is required');

	return async (event) => {
		const container = event.locals.container;
		const method = event.request.method;
		await checkRateLimit(def, event, container);
		const corsOrigin = checkCors(def, event);
		const usesBody = method !== 'GET' && method !== 'DELETE' && method !== 'HEAD';
		const bodyText = usesBody ? await event.request.text() : '';
		await verifyAuth(def, event, bodyText, container);

		let input;
		if (usesBody) {
			try {
				input = bodyText === '' ? {} : JSON.parse(bodyText);
			} catch {
				throw error(400, { message: `Endpoint ${def.name}: body is not valid JSON` });
			}
		} else {
			input = coerceQuery(def.input, Object.fromEntries(event.url.searchParams));
		}
		if (def.input) {
			const issues = shapeIssues(def.input, input, 'input');
			if (issues.length > 0) {
				throw error(400, { message: `Endpoint ${def.name}: ${issues.join('; ')}`, issues });
			}
		}

		const ctx = { input, container, event, user: event.locals.user };

		if (def.stream) {
			let frames = def.body(ctx);
			if (!frames?.[Symbol.asyncIterator]) frames = await frames;
			if (!frames?.[Symbol.asyncIterator]) {
				throw error(500, { message: `Endpoint ${def.name}: stream body must return an async iterable of frames` });
			}
			return sseResponse(def, frames);
		}

		const result = await def.body(ctx);
		if (result instanceof Response) {
			if (corsOrigin) result.headers.set('access-control-allow-origin', corsOrigin);
			return result;
		}
		if (def.output) {
			const issues = shapeIssues(def.output, result, 'output');
			if (issues.length > 0) {
				throw error(500, { message: `Endpoint ${def.name}: ${issues.join('; ')}`, issues });
			}
		}
		const response = json(result ?? null);
		if (corsOrigin) response.headers.set('access-control-allow-origin', corsOrigin);
		return response;
	};
}
