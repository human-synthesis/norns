# @human-synthesis/norns

SvelteKit with CoffeeScript, Pug, and UnoCSS preconfigured.

Builds on top of [`@human-synthesis/norns-core`](https://github.com/human-synthesis/norns-core) and adds first-class support for `.coffee` SvelteKit special files (`+page.coffee`, `+page.server.coffee`, `hooks.server.coffee`, `+server.coffee`, etc.).

## Install

```sh
pnpm add -D @human-synthesis/norns @sveltejs/kit svelte unocss vite
```

## Usage

`svelte.config.js`:

```js
import { nornsConfig } from '@human-synthesis/norns/config';

export default nornsConfig({
  // your overrides here, e.g.:
  // kit: { adapter: adapterNode() }
});
```

`vite.config.js`:

```js
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { nornsCoffeePlugin, nornsUno } from '@human-synthesis/norns';

export default defineConfig({
  plugins: [nornsCoffeePlugin(), nornsUno(), sveltekit()]
});
```

## What this gives you

- **`.svelte` files** with `<script lang="coffee">`, `<template lang="pug">`, and UnoCSS class attributes
- **`.coffee` Kit modules** — write `+page.coffee`, `+page.server.coffee`, `+layout.coffee`, `+server.coffee`, `hooks.server.coffee` instead of `.js`/`.ts`
- **UnoCSS** preset stack (Uno, Attributify, Icons, Typography) wired into Vite

## Example route

`src/routes/+page.svelte`:

```svelte
<template lang="pug">
  h1.text-3xl.font-bold Hello {data.name}
  button(on:click="{() => count++}") count is {count}
</template>

<script lang="coffee">
  export let data
  count = 0
</script>
```

`src/routes/+page.server.coffee`:

```coffee
export load = ->
  name: 'Norns'
```

## License & attribution

MIT © Human Synthesis. Built on top of [SvelteKit](https://github.com/sveltejs/kit) and [Svelte](https://github.com/sveltejs/svelte) © Svelte Contributors, MIT licensed.
