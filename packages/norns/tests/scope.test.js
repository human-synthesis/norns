import { describe, test, expect } from 'bun:test';
import { createContainer } from '../src/server/container.js';
import { withScope, getScope, getContainer } from '../src/server/scope.js';

describe('scope', () => {
	test('getScope() returns undefined outside withScope', () => {
		expect(getScope()).toBeUndefined();
	});

	test('withScope makes scope available synchronously', () => {
		const c = createContainer();
		const result = withScope({ container: c, user: { id: 'u1' } }, () => {
			const s = getScope();
			return s?.user?.id;
		});
		expect(result).toBe('u1');
	});

	test('withScope makes scope available across awaits', async () => {
		const c = createContainer();
		const result = await withScope({ container: c, tenant: 't1' }, async () => {
			await new Promise((r) => setTimeout(r, 1));
			return getScope()?.tenant;
		});
		expect(result).toBe('t1');
	});

	test('getContainer throws outside a request scope', () => {
		expect(() => getContainer()).toThrow(/outside a request scope/);
	});

	test('getContainer returns the scoped container inside withScope', () => {
		const c = createContainer();
		c.single('x', () => 99);
		const got = withScope({ container: c }, () => getContainer().resolve('x'));
		expect(got).toBe(99);
	});

	test('parallel scopes are isolated', async () => {
		const c1 = createContainer();
		const c2 = createContainer();
		c1.single('id', () => 'one');
		c2.single('id', () => 'two');
		const [a, b] = await Promise.all([
			withScope({ container: c1 }, async () => {
				await new Promise((r) => setTimeout(r, 5));
				return getContainer().resolve('id');
			}),
			withScope({ container: c2 }, async () => {
				await new Promise((r) => setTimeout(r, 1));
				return getContainer().resolve('id');
			})
		]);
		expect(a).toBe('one');
		expect(b).toBe('two');
	});
});
