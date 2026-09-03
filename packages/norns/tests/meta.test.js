import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSpec } from '@human-synthesis/norns-tron/spec';

import {
	APP_SCHEMA,
	MODULE_SCHEMA,
	UNIT_SCHEMAS,
	schemaIssues
} from '../src/kernel/meta.js';
import { validateSpecs } from '../src/kernel/index.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

const fail = (kind, value) => schemaIssues(UNIT_SCHEMAS[kind], value, 't');
const messages = (issues) => issues.map((i) => i.message).join('\n');

describe('golden fixture', () => {
	test('the PLAN orders module validates clean end to end', () => {
		const dir = mkdtempSync(join(tmpdir(), 'norns-meta-'));
		try {
			writeSpec(join(dir, 'app.tron'), APP);
			writeSpec(join(dir, 'orders.tron'), ORDERS);
			writeSpec(join(dir, 'catalog.tron'), CATALOG);
			const result = validateSpecs(dir);
			expect(result.issues).toEqual([]);
			expect(result.ok).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('Entity', () => {
	test('unknown keys are rejected', () => {
		const issues = fail('Entity', { fields: {}, extra: 1 });
		expect(messages(issues)).toContain('extra');
	});

	test('bad field type', () => {
		expect(fail('Entity', { fields: { x: 'nope' } }).length).toBeGreaterThan(0);
	});

	test('ref fields need ref, others must not have it', () => {
		expect(messages(fail('Entity', { fields: { x: { type: 'ref' } } }))).toContain('ref');
		expect(
			messages(fail('Entity', { fields: { x: { type: 'text', ref: 'core.Entity.User' } } }))
		).toContain('ref');
		expect(fail('Entity', { fields: { x: { type: 'ref', ref: 'core.Entity.User' } } })).toEqual([]);
	});

	test('a wrong field-object key is named, not folded into a union mismatch', () => {
		const issues = messages(fail('Entity', { fields: { x: { type: 'ref', entity: 'User' } } }));
		expect(issues).toContain('entity');
		expect(issues).not.toContain('| Object');
		const badType = messages(fail('Entity', { fields: { x: { type: 'enum' } } }));
		expect(badType).toContain('type');
		expect(badType).toContain('"enum"');
	});

	test('bad uid shape', () => {
		expect(messages(fail('Entity', { uid: 'short', fields: {} }))).toContain('ULID');
	});
});

describe('Query', () => {
	test('from is required; filter must parse', () => {
		expect(fail('Query', {}).length).toBeGreaterThan(0);
		expect(messages(fail('Query', { from: 'Order', filter: 'status ==' }))).toContain(
			'expression'
		);
		expect(fail('Query', { from: 'Order', filter: 'status == draft' })).toEqual([]);
	});
});

describe('Action', () => {
	test('impl: custom requires examples', () => {
		expect(messages(fail('Action', { impl: 'custom' }))).toContain('example');
		expect(fail('Action', { impl: 'custom', examples: [{ input: {} }] })).toEqual([]);
	});

	test('refresh entries must be full addresses', () => {
		expect(fail('Action', { refresh: ['board'] }).length).toBeGreaterThan(0);
		expect(fail('Action', { refresh: ['orders.Query.board'] })).toEqual([]);
	});

	test('transport is form or remote', () => {
		expect(fail('Action', { transport: 'websocket' }).length).toBeGreaterThan(0);
	});

	test('requires must parse', () => {
		expect(messages(fail('Action', { requires: 'not not x' }))).toContain('expression');
	});
});

describe('Page', () => {
	test('route must start with /', () => {
		expect(messages(fail('Page', { route: 'orders' }))).toContain('route');
		expect(fail('Page', { route: '/orders' })).toEqual([]);
	});
});

describe('Trigger', () => {
	test('string shorthand must be an address', () => {
		expect(fail('Trigger', 'orders.Action.cancel')).toEqual([]);
		expect(fail('Trigger', 'not-an-address').length).toBeGreaterThan(0);
	});

	test('object form needs action', () => {
		expect(fail('Trigger', { schedule: '0 * * * *' }).length).toBeGreaterThan(0);
		expect(fail('Trigger', { action: 'orders.Action.cancel', schedule: '0 * * * *' })).toEqual([]);
	});
});

describe('Function / Component', () => {
	test('functions require examples', () => {
		expect(fail('Function', {}).length).toBeGreaterThan(0);
		expect(messages(fail('Function', { examples: [] }))).toContain('example');
		expect(fail('Function', { examples: [{ input: 1, expect: 2 }] })).toEqual([]);
	});

	test('component events must point at actions', () => {
		expect(fail('Component', { events: { select: 'open' } }).length).toBeGreaterThan(0);
		expect(fail('Component', { events: { select: 'orders.Action.open' } })).toEqual([]);
	});
});

describe('Level-3 kinds', () => {
	test('refused without an auth declaration', () => {
		expect(fail('Worker', { source: 'workers/MatchRoom.c' }).length).toBeGreaterThan(0);
		expect(fail('Worker', { source: 'workers/MatchRoom.c', auth: 'authenticated', room: true })).toEqual([]);
	});
});

describe('module / app shapes', () => {
	test('typo collection keys are rejected', () => {
		const issues = schemaIssues(MODULE_SCHEMA, { module: 'orders', action: {} }, 'orders');
		expect(messages(issues)).toContain('action');
	});

	test('bad dialect is rejected', () => {
		expect(schemaIssues(APP_SCHEMA, { dialect: 'mysql' }, 'app').length).toBeGreaterThan(0);
		expect(schemaIssues(APP_SCHEMA, { dialect: 'postgres' }, 'app')).toEqual([]);
	});

	test('issues carry dotted paths', () => {
		const issues = fail('Entity', { fields: { x: { type: 'nope' } } });
		expect(issues[0].message).toMatch(/fields/);
	});
});
