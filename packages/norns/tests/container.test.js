import { describe, test, expect } from 'bun:test';
import { Container, createContainer } from '../src/server/container.js';

describe('Container', () => {
	test('bind + resolve transient produces a fresh value each time', () => {
		const c = createContainer();
		let n = 0;
		c.bind('counter', () => ++n);
		expect(c.resolve('counter')).toBe(1);
		expect(c.resolve('counter')).toBe(2);
	});

	test('single + resolve memoizes', () => {
		const c = createContainer();
		let n = 0;
		c.single('counter', () => ++n);
		expect(c.resolve('counter')).toBe(1);
		expect(c.resolve('counter')).toBe(1);
	});

	test('factory receives the container so it can resolve dependencies', () => {
		const c = createContainer();
		c.single('a', () => 10);
		c.bind('b', (cc) => cc.resolve('a') + 1);
		expect(c.resolve('b')).toBe(11);
	});

	test('resolve walks parent for bindings', () => {
		const root = createContainer();
		root.single('db', () => ({ name: 'root-db' }));
		const scope = root.scope();
		expect(scope.resolve('db').name).toBe('root-db');
	});

	test('singletons cache at the scope where the binding lives', () => {
		const root = createContainer();
		let n = 0;
		root.single('counter', () => ++n);
		const a = root.scope();
		const b = root.scope();
		expect(a.resolve('counter')).toBe(1);
		expect(b.resolve('counter')).toBe(1); // same root cache
	});

	test('scope-local overrides win over root bindings', () => {
		const root = createContainer();
		root.single('mailer', () => ({ kind: 'real' }));
		const test = root.scope();
		test.override('mailer', () => ({ kind: 'fake' }));
		expect(test.resolve('mailer').kind).toBe('fake');
		expect(root.resolve('mailer').kind).toBe('real');
	});

	test('override on root affects child scopes', () => {
		const root = createContainer();
		root.bind('thing', () => 'real');
		root.override('thing', () => 'overridden');
		const child = root.scope();
		expect(child.resolve('thing')).toBe('overridden');
	});

	test('resolve throws on unknown token', () => {
		const c = createContainer();
		expect(() => c.resolve('missing')).toThrow(/no binding for token "missing"/);
	});

	test('has() reports presence across scope chain', () => {
		const root = createContainer();
		root.single('x', () => 1);
		const child = root.scope();
		expect(child.has('x')).toBe(true);
		expect(child.has('y')).toBe(false);
		child.override('y', () => 2);
		expect(child.has('y')).toBe(true);
	});

	test('migrations() registers at the root regardless of scope', () => {
		const root = createContainer();
		root.migrations('/a/migrations');
		const child = root.scope();
		child.migrations('/b/migrations');
		expect(root.getMigrationDirs()).toEqual(['/a/migrations', '/b/migrations']);
		expect(child.getMigrationDirs()).toEqual(['/a/migrations', '/b/migrations']);
	});

	test('factory passed the leaf scope can read scope-local overrides', () => {
		const root = createContainer();
		root.single('user', () => ({ id: 'real' }));
		root.bind('greet', (c) => `hi ${c.resolve('user').id}`);
		const req = root.scope();
		req.override('user', () => ({ id: 'test-user' }));
		expect(req.resolve('greet')).toBe('hi test-user');
	});

	test('Container instance can be created directly with a parent', () => {
		const root = createContainer();
		root.single('x', () => 42);
		const child = new Container(root);
		expect(child.resolve('x')).toBe(42);
	});
});
