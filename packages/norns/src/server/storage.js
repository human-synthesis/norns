import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';

/**
 * Storage behind `container.resolve('storage')` — backing for the `file`
 * field type. Two adapters with one surface:
 *
 *   put(key, data, { contentType? })  → { key }
 *   get(key)                          → { body: Uint8Array, contentType? } | null
 *   delete(key)                       → void
 *   list(prefix)                      → string[] (keys, sorted)
 *
 * Keys are `/`-separated paths (`orders/abc/invoice.pdf`).
 */

/**
 * Cloudflare R2 adapter over a bucket binding.
 * @param {*} bucket R2Bucket binding
 */
export function r2Storage(bucket) {
	return {
		async put(key, data, { contentType } = {}) {
			await bucket.put(key, data, contentType ? { httpMetadata: { contentType } } : undefined);
			return { key };
		},
		async get(key) {
			const obj = await bucket.get(key);
			if (!obj) return null;
			return {
				body: new Uint8Array(await obj.arrayBuffer()),
				contentType: obj.httpMetadata?.contentType
			};
		},
		async delete(key) {
			await bucket.delete(key);
		},
		async list(prefix = '') {
			const keys = [];
			let cursor;
			do {
				const page = await bucket.list({ prefix, cursor });
				for (const obj of page.objects) keys.push(obj.key);
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
			return keys.sort();
		}
	};
}

/**
 * Local-dir shim for `norns dev` / tests. Content types ride in a `.meta`
 * sidecar next to each object.
 * @param {string} root
 */
export function dirStorage(root) {
	const safe = (key) => {
		const p = normalize(join(root, key));
		if (!p.startsWith(normalize(root) + sep)) throw new Error(`storage: invalid key ${key}`);
		return p;
	};
	return {
		async put(key, data, { contentType } = {}) {
			const path = safe(key);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, typeof data === 'string' ? data : new Uint8Array(data));
			if (contentType) writeFileSync(`${path}.meta`, contentType);
			return { key };
		},
		async get(key) {
			const path = safe(key);
			if (!existsSync(path)) return null;
			const meta = existsSync(`${path}.meta`) ? readFileSync(`${path}.meta`, 'utf8') : undefined;
			return { body: new Uint8Array(readFileSync(path)), contentType: meta };
		},
		async delete(key) {
			const path = safe(key);
			rmSync(path, { force: true });
			rmSync(`${path}.meta`, { force: true });
		},
		async list(prefix = '') {
			if (!existsSync(root)) return [];
			const out = [];
			const walk = (dir) => {
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					const full = join(dir, entry.name);
					if (entry.isDirectory()) walk(full);
					else if (!entry.name.endsWith('.meta')) {
						const key = full.slice(normalize(root).length + 1).split(sep).join('/');
						if (key.startsWith(prefix)) out.push(key);
					}
				}
			};
			walk(root);
			return out.sort();
		}
	};
}
