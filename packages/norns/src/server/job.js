/**
 * Job runtime (K-22/R-14). Generated `lib/<m>/jobs.c` wraps each unit in
 * `job({...})`; `registerJobs` subscribes them to `job:<address>` bus
 * messages, and the `jobs` container facade enqueues through the same bus —
 * production rides Cloudflare Queues (boot `queue` opt) while dev runs
 * inline, awaited, with the same retry/backoff/DLQ semantics.
 */

/**
 * @typedef {{
 *   address: string,
 *   retry?: { attempts: number, backoff: 'none'|'fixed'|'exponential', baseMs?: number },
 *   dlq?: string,
 *   concurrency?: number,
 *   run: (ctx: { input: *, container: *, user?: * }) => Promise<*>
 * }} JobDef
 */

/** Identity wrapper — the shape is the contract. @param {JobDef} def */
export function job(def) {
	return def;
}

/** Delay before retry `attempt` (1-based) under a retry policy. */
export function backoffMs(retry, attempt) {
	const base = retry?.baseMs ?? 1000;
	switch (retry?.backoff) {
		case 'fixed':
			return base;
		case 'exponential':
			return base * 2 ** (attempt - 1);
		default:
			return 0;
	}
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Run a job under its declared retry policy. On exhaustion: with a `dlq`,
 * a `dlq:<name>` event carries the failure and the message counts as
 * handled; without one the error rethrows (in queue mode Cloudflare then
 * applies its own message retry).
 *
 * @param {JobDef} jobDef
 * @param {{ input: *, container: *, user?: * }} ctx
 */
export async function runJob(jobDef, ctx) {
	const attempts = jobDef.retry?.attempts ?? 1;
	for (let attempt = 1; ; attempt++) {
		try {
			return await jobDef.run(ctx);
		} catch (err) {
			if (attempt < attempts) {
				await sleep(backoffMs(jobDef.retry, attempt));
				continue;
			}
			if (jobDef.dlq) {
				await ctx.container.resolve('events').emit(`dlq:${jobDef.dlq}`, {
					job: jobDef.address,
					input: ctx.input,
					error: String(err?.message ?? err),
					attempts: attempt
				});
				return undefined;
			}
			throw err;
		}
	}
}

/**
 * Wire job tables (generated `jobs` maps, address → JobDef) into the bus.
 *
 * @param {*} container
 * @param {Record<string, JobDef> | Record<string, JobDef>[]} tables
 * @returns {() => void} unsubscribe-all
 */
export function registerJobs(container, tables) {
	const events = container.resolve('events');
	const offs = [];
	for (const table of Array.isArray(tables) ? tables : [tables]) {
		for (const [address, jobDef] of Object.entries(table ?? {})) {
			offs.push(
				events.on(`job:${address}`, (payload = {}) =>
					runJob(jobDef, { input: payload.input ?? {}, container, user: payload.user })
				)
			);
		}
	}
	return () => {
		for (const off of offs) off();
	};
}

/** The `jobs` container facade behind generated `enqueue` steps. */
export function createJobs(container) {
	return {
		enqueue: (address, input, user) =>
			container.resolve('events').emit(`job:${address}`, { input, user })
	};
}
