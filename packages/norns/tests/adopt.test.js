import { describe, expect, test } from 'bun:test';

import { adoptFiles, adoptUnit, inferAuth, inferKind } from '../src/kernel/adopt.js';
import { UNIT_SCHEMAS, schemaIssues } from '../src/kernel/meta.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

const SPECS = { app: APP, modules: { orders: ORDERS, catalog: CATALOG } };

const ROUTE_SOURCE = `import { json } from '@sveltejs/kit'

export async function GET({ locals }) {
	if (!locals.user) return json({ error: 'forbidden' }, { status: 403 })
	const res = await fetch('https://api.example.com/rates')
	return json(await res.json())
}
`;

const WORKER_SOURCE = `export class MatchRoom extends DurableObject {
	webSocketMessage(ws, message) {
		this.broadcast(message)
	}
}

export default {
	async scheduled(event, env) {
		await env.DB.prepare('DELETE FROM stale').run()
	}
}
`;

const MIDDLEWARE_SOURCE = `export const handle = async ({ event, resolve }) => {
	event.locals.requestId = crypto.randomUUID()
	return resolve(event)
}
`;

const ADAPTER_SOURCE = `const BASE = 'https://api.stripe.com/v1'

export const charge = async (amount) => {
	return fetch(BASE + '/charges', { headers: { authorization: env.STRIPE_KEY } })
}
`;

describe('adoptUnit', () => {
	// D69: the Route wrap kind is gone — verb-handler files are still
	// detected, but the answer names Endpoint instead of wrapping dead units.
	test('a verb-exporting file is not adoptable; the refusal names Endpoint', () => {
		const result = adoptUnit(SPECS, { module: 'orders', path: 'src/routes/api/rates/+server.c', source: ROUTE_SOURCE });
		expect(result.adoptable).toBe(false);
		expect(result.reason).toContain('Endpoint');
		expect(result.reason).toContain('verb handlers');
	});

	test('a Durable Object becomes a room Worker with schedule/db/websocket capabilities', () => {
		const result = adoptUnit(SPECS, { module: 'orders', path: 'src/match.worker.c', source: WORKER_SOURCE });

		expect(result.kind).toBe('Worker');
		expect(result.name).toBe('match-worker');
		expect(result.ops[0].value.room).toBe(true);
		expect(result.ops[0].value.capabilities).toEqual(expect.arrayContaining(['schedule', 'websocket']));
		expect(schemaIssues(UNIT_SCHEMAS.Worker, result.ops[0].value, result.address)).toEqual([]);
	});

	test('a handle hook becomes Middleware; a bare client becomes an Adapter with public auth flagged', () => {
		const mw = adoptUnit(SPECS, { module: 'orders', path: 'src/hooks/request-id.c', source: MIDDLEWARE_SOURCE });
		expect(mw.kind).toBe('Middleware');

		const adapter = adoptUnit(SPECS, { module: 'orders', path: 'src/stripe.c', source: ADAPTER_SOURCE });
		expect(adapter.kind).toBe('Adapter');
		expect(adapter.ops[0].value.auth).toBe('public');
		expect(adapter.ops[0].value.capabilities).toEqual(expect.arrayContaining(['network', 'env']));
		expect(adapter.inferred.auth).toContain('no user/session');
	});

	test('refusals: unknown module, empty source, no exports, name collision', () => {
		expect(adoptUnit(SPECS, { module: 'billing', path: 'src/x.c', source: ROUTE_SOURCE }).reason).toContain('billing');
		expect(adoptUnit(SPECS, { module: 'orders', path: 'src/x.c', source: '' }).reason).toContain('no source');
		expect(adoptUnit(SPECS, { module: 'orders', path: 'src/x.c', source: 'const a = 1\n' }).reason).toContain('no recognisable exports');

		const withWorker = structuredClone(SPECS);
		withWorker.modules.orders.workers = { 'match-worker': { source: 'x', auth: 'authenticated' } };
		const collision = adoptUnit(withWorker, { module: 'orders', path: 'src/match.worker.c', source: WORKER_SOURCE });
		expect(collision.adoptable).toBe(false);
		expect(collision.reason).toContain('already exists');
	});

	test('inference helpers expose their evidence', () => {
		expect(inferKind(MIDDLEWARE_SOURCE, 'src/h.c').evidence).toContain('handle');
		expect(inferAuth(ROUTE_SOURCE).auth).toBe('authenticated');
		expect(inferAuth(ADAPTER_SOURCE).auth).toBe('public');
	});
});

describe('adoptFiles', () => {
	test('maps every file to a proposal, refusals included', () => {
		const { proposals } = adoptFiles(SPECS, {
			module: 'orders',
			files: [
				{ path: 'src/stripe.c', source: ADAPTER_SOURCE },
				{ path: 'src/empty.c', source: null }
			]
		});
		expect(proposals).toHaveLength(2);
		expect(proposals[0].adoptable).toBe(true);
		expect(proposals[1].adoptable).toBe(false);
	});
});
