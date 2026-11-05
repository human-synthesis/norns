import { describe, expect, test } from 'bun:test';
import { errorHandle } from '../src/server/handle/error.js';

const event = { request: { method: 'GET' }, url: { pathname: '/x' } };

describe('errorHandle', () => {
	test('logs unknown errors and keeps the SvelteKit defaults', () => {
		const logged = [];
		const handle = errorHandle({ logger: { error: (msg, err) => logged.push([msg, err]) } });
		const boom = new Error('boom');
		expect(handle({ kind: 'unknown', error: boom, event })).toBeUndefined();
		expect(logged).toEqual([['[norns] GET /x 500', boom]]);
	});

	test('expected, framework and validation errors pass through unlogged', () => {
		const logged = [];
		const handle = errorHandle({ logger: { error: (msg, err) => logged.push([msg, err]) } });
		handle({ kind: 'app', error: { status: 400, message: 'bad' }, event });
		handle({ kind: 'framework', error: { status: 404, message: 'Not Found' }, event });
		handle({ kind: 'validation', error: { status: 400, message: 'Bad Request' }, issues: [], event });
		expect(logged).toEqual([]);
	});
});
