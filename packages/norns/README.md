# Norns

**AI-driven software architecture and development framework, based on Svelte.**

SvelteKit with Pug, CoffeeScript, and `.n` / `.c` files — preconfigured.

## Stack

- [Svelte 5](https://svelte.dev) — components and runes
- [SvelteKit 2](https://kit.svelte.dev) — file-system routing, SSR, endpoints
- [Pug](https://pugjs.org) — templates
- [CoffeeScript 2](https://coffeescript.org) — script
- [Tailwind CSS v4](https://tailwindcss.com) — recommended styling
- [Vite](https://vitejs.dev) — bundler
- [bun](https://bun.sh) — runtime / package manager

## Install

```sh
bun add -D @human-synthesis/norns @sveltejs/kit svelte
```

Or use the [`norns-app`](https://github.com/human-synthesis/norns-app) starter, which has everything wired up.

## Setup

`svelte.config.js`:

```js
import { nornsConfig } from '@human-synthesis/norns/config';

export default nornsConfig({
  // your overrides here
});
```

`vite.config.js`:

```js
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { nornsCoffeePlugin } from '@human-synthesis/norns/vite';

export default defineConfig({
  plugins: [nornsCoffeePlugin(), sveltekit()]
});
```

`package.json`:

```json
{
  "scripts": {
    "dev": "norns dev",
    "build": "norns build",
    "preview": "norns preview"
  }
}
```

## License

MIT © Daniel Teodoroiu / [Human Synthesis](https://humansynthesis.ai). Built on top of [SvelteKit](https://github.com/sveltejs/kit) and [Svelte](https://github.com/sveltejs/svelte) © Svelte Contributors, MIT licensed.
