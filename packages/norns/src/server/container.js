/**
 * Norns DI container.
 *
 * Tokens are namespaced strings (e.g. `notes.repo`, `db`). Bindings register a
 * factory that produces an instance; `single` bindings memoize at the level
 * where they are declared, `bind` bindings re-run the factory on every resolve.
 *
 * A child scope (created via `scope()`) inherits its parent's bindings but
 * tracks its own overrides and request-scoped singletons. Request scopes are
 * the natural fit for things like `db` (a transactional handle for one
 * request) or `user` (the authenticated principal).
 *
 * Overrides take precedence over bindings at every level — used in tests to
 * swap a real service for a fake without rebinding the production module.
 *
 * Migration directories are tracked at the root container only; child scopes
 * inherit visibility through the root walk.
 */

/** @typedef {(c: Container) => any} Factory */
/** @typedef {{ factory: Factory, lifetime: 'transient' | 'singleton' }} Binding */

export class Container {
	/** @param {Container | null} [parent] */
	constructor(parent = null) {
		/** @type {Container | null} */
		this.parent = parent;
		/** @type {Map<string, Binding>} */
		this.bindings = new Map();
		/** @type {Map<string, any>} */
		this.singletons = new Map();
		/** @type {Map<string, Factory>} */
		this.overrides = new Map();
		/** @type {string[]} */
		this.migrationDirs = [];
	}

	/**
	 * Bind a transient factory — called on every `resolve(token)`.
	 *
	 * @param {string} token
	 * @param {Factory} factory
	 * @returns {this}
	 */
	bind(token, factory) {
		this.bindings.set(token, { factory, lifetime: 'transient' });
		return this;
	}

	/**
	 * Bind a singleton factory — called once per container scope.
	 *
	 * @param {string} token
	 * @param {Factory} factory
	 * @returns {this}
	 */
	single(token, factory) {
		this.bindings.set(token, { factory, lifetime: 'singleton' });
		return this;
	}

	/**
	 * Override a token at this scope. Wins over any binding in this or any
	 * parent scope. Useful in tests.
	 *
	 * @param {string} token
	 * @param {Factory} factory
	 * @returns {this}
	 */
	override(token, factory) {
		this.overrides.set(token, factory);
		return this;
	}

	/**
	 * Register a migration directory. Tracked at the root container.
	 *
	 * @param {string} dir absolute path to a `migrations/` directory containing
	 *                     `*.sql` files
	 * @returns {this}
	 */
	migrations(dir) {
		let root = /** @type {Container} */ (this);
		while (root.parent) root = root.parent;
		root.migrationDirs.push(dir);
		return this;
	}

	/**
	 * Get all registered migration directories. Walks to root.
	 *
	 * @returns {string[]}
	 */
	getMigrationDirs() {
		let root = /** @type {Container} */ (this);
		while (root.parent) root = root.parent;
		return [...root.migrationDirs];
	}

	/**
	 * Resolve a token to a value. Walks the scope chain.
	 *
	 * Resolution order:
	 *   1. nearest override (any scope)
	 *   2. nearest binding (any scope) — singletons cache at that scope
	 *   3. throw
	 *
	 * The factory is called with the leaf scope (the one `resolve` was called
	 * on), so factories can resolve other tokens at the same level.
	 *
	 * @param {string} token
	 * @returns {any}
	 */
	resolve(token) {
		let node = /** @type {Container | null} */ (this);
		while (node) {
			if (node.overrides.has(token)) {
				const factory = /** @type {Factory} */ (node.overrides.get(token));
				return factory(this);
			}
			node = node.parent;
		}

		node = this;
		while (node) {
			const binding = node.bindings.get(token);
			if (binding) {
				if (binding.lifetime === 'singleton') {
					if (!node.singletons.has(token)) {
						node.singletons.set(token, binding.factory(this));
					}
					return node.singletons.get(token);
				}
				return binding.factory(this);
			}
			node = node.parent;
		}

		throw new Error(`Container: no binding for token "${String(token)}"`);
	}

	/**
	 * Whether a binding or override is reachable for the given token.
	 *
	 * @param {string} token
	 * @returns {boolean}
	 */
	has(token) {
		let node = /** @type {Container | null} */ (this);
		while (node) {
			if (node.overrides.has(token) || node.bindings.has(token)) return true;
			node = node.parent;
		}
		return false;
	}

	/**
	 * Create a child scope. The child inherits bindings via the parent walk;
	 * its own overrides and singletons are isolated.
	 *
	 * @returns {Container}
	 */
	scope() {
		return new Container(this);
	}
}

/**
 * Create a fresh root container.
 *
 * @returns {Container}
 */
export function createContainer() {
	return new Container();
}
