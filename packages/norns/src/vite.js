import { readFile } from 'node:fs/promises';
import CoffeeScript from 'coffeescript';

/**
 * Vite plugin that compiles .coffee files to JavaScript.
 * Used so SvelteKit special files like +page.coffee, +page.server.coffee,
 * hooks.server.coffee, and +server.coffee work the same as their .js / .ts
 * counterparts.
 *
 * @returns {import('vite').Plugin}
 */
export function nornsCoffeePlugin() {
	return {
		name: 'norns:coffee',
		enforce: 'pre',
		async load(id) {
			const [path] = id.split('?');
			if (!path.endsWith('.coffee')) return null;
			const source = await readFile(path, 'utf8');
			const { js, sourceMap } = CoffeeScript.compile(source, {
				bare: true,
				sourceMap: true,
				inlineMap: false,
				filename: path
			});
			return { code: js, map: sourceMap?.generate?.() ?? null };
		}
	};
}
