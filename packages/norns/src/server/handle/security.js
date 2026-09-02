/**
 * Security headers (R-17/D30): every response leaves with a hardened
 * baseline — the spec can only tighten, never remove. CSP stays on the
 * SvelteKit config side (nonce emission needs kit's csp block); this handle
 * owns the header floor that needs no build-time knowledge.
 */
const BASELINE = {
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};

export function securityHandle(overrides = {}) {
	const headers = { ...BASELINE, ...overrides };
	return async ({ event, resolve }) => {
		const response = await resolve(event);
		for (const [name, value] of Object.entries(headers)) {
			if (value !== null && !response.headers.has(name)) response.headers.set(name, value);
		}
		if (event.url.protocol === 'https:' && !response.headers.has('strict-transport-security')) {
			response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
		}
		return response;
	};
}
