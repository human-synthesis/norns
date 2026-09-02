/**
 * Wrangler config generation (R-12): the Cloudflare deploy surface is
 * derived from the specs, not hand-maintained. `generateApp` writes
 * `wrangler.json` into the generated root; deploy with
 * `wrangler deploy -c .norns/generated/wrangler.json`.
 *
 * Binding names are fixed contracts (`DB`, `STORAGE`, `EVENTS`, `ASSETS`,
 * `ROOM`)
 * so runtime adapters can rely on them. Account-specific values live in
 * `app.settings.cloudflare` — spec-canonical, like everything else:
 *
 *   settings: { cloudflare: { d1_id: '…', compatibility_date: '…', queue: true } }
 */

// Pinned so regeneration is deterministic; bump deliberately with runtime upgrades.
const DEFAULT_COMPAT_DATE = '2025-06-01';

const fieldType = (f) => (typeof f === 'string' ? f : f?.type);

function hasFileFields(specs) {
	for (const mod of Object.values(specs.modules)) {
		for (const entity of Object.values(mod.entities ?? {})) {
			for (const field of Object.values(entity?.fields ?? {})) {
				if (fieldType(field) === 'file') return true;
			}
		}
	}
	return false;
}

/** A Room DO is needed for live queries and for Worker units marked `room`. */
function needsRoom(specs) {
	for (const mod of Object.values(specs.modules)) {
		for (const query of Object.values(mod.queries ?? {})) {
			if (query?.live === true) return true;
		}
		for (const worker of Object.values(mod.workers ?? {})) {
			if (worker?.room === true) return true;
		}
	}
	return false;
}

/** Jobs share the app events queue in v3-A; the strictest job wins the consumer settings. */
function jobUnits(specs) {
	const out = [];
	for (const mod of Object.values(specs.modules)) {
		for (const j of Object.values(mod.jobs ?? {})) {
			if (j && typeof j === 'object') out.push(j);
		}
	}
	return out;
}

function cronSchedules(specs) {
	const crons = new Set();
	for (const mod of Object.values(specs.modules)) {
		for (const trigger of Object.values(mod.triggers ?? {})) {
			if (typeof trigger?.schedule === 'string') crons.add(trigger.schedule);
		}
	}
	return [...crons].sort();
}

/**
 * Build the wrangler configuration object for an app's specs.
 *
 * @param {{ app?: *, modules: Record<string, *> }} specs loaded specs (loadSpecs shape)
 * @returns {object} wrangler config, JSON-serializable
 */
export function wranglerConfig(specs) {
	const app = specs.app ?? {};
	const cf = app.settings?.cloudflare ?? {};
	const name = (app.name ?? 'app').toLowerCase().replaceAll('_', '-');
	const dialect = app.dialect ?? 'd1';

	const config = {
		name,
		main: '.svelte-kit/cloudflare/_worker.js',
		compatibility_date: cf.compatibility_date ?? DEFAULT_COMPAT_DATE,
		compatibility_flags: ['nodejs_compat'],
		assets: { binding: 'ASSETS', directory: '.svelte-kit/cloudflare' }
	};

	if (dialect === 'd1') {
		config.d1_databases = [
			{
				binding: 'DB',
				database_name: `${name}-db`,
				database_id: cf.d1_id ?? '<set app.settings.cloudflare.d1_id>'
			}
		];
	}

	if (hasFileFields(specs) || cf.r2 === true) {
		config.r2_buckets = [{ binding: 'STORAGE', bucket_name: `${name}-storage` }];
	}

	const jobs = jobUnits(specs);
	if (cf.queue === true || jobs.length > 0) {
		const queue = `${name}-events`;
		const consumer = { queue };
		if (jobs.length > 0) {
			consumer.max_retries = Math.max(...jobs.map((j) => j.retry?.attempts ?? 1));
			const dlqs = [...new Set(jobs.map((j) => j.dlq).filter(Boolean))].sort();
			if (dlqs.length > 0) consumer.dead_letter_queue = dlqs[0];
			const conc = jobs.map((j) => j.concurrency).filter(Boolean);
			if (conc.length > 0) consumer.max_concurrency = Math.min(...conc);
		}
		config.queues = {
			producers: [{ binding: 'EVENTS', queue }],
			consumers: [consumer]
		};
	}

	if (needsRoom(specs)) {
		const className = cf.room_class ?? 'NornsRoom';
		config.durable_objects = { bindings: [{ name: 'ROOM', class_name: className }] };
		config.migrations = [{ tag: 'norns-room-v1', new_classes: [className] }];
	}

	const crons = cronSchedules(specs);
	if (crons.length > 0) config.triggers = { crons };

	return config;
}

/** @param {*} specs @returns {{ path: string, text: string }} */
export function wranglerFile(specs) {
	return {
		path: 'wrangler.json',
		text: JSON.stringify(wranglerConfig(specs), null, '\t') + '\n'
	};
}
