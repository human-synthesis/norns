/**
 * Cron triggers: Workers `scheduled` adapter + local timer shim for
 * `norns dev`. Triggers are the generated tables (`[{ on, action, schedule? }]`).
 */

/**
 * Match a 5-field cron expression (min hour dom mon dow) against a Date.
 * Supports `*`, `n`, `a-b`, `*​/n`, `a-b/n`, and comma lists; dow 0/7 = Sunday.
 *
 * @param {string} expr
 * @param {Date} date
 */
export function cronMatches(expr, date) {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) return false;
	const values = [
		date.getUTCMinutes(),
		date.getUTCHours(),
		date.getUTCDate(),
		date.getUTCMonth() + 1,
		date.getUTCDay()
	];
	return fields.every((field, i) => fieldMatches(field, values[i], i === 4));
}

function fieldMatches(field, value, isDow) {
	return field.split(',').some((part) => {
		const [range, stepStr] = part.split('/');
		const step = stepStr === undefined ? 1 : Number(stepStr);
		if (!Number.isInteger(step) || step < 1) return false;
		let lo;
		let hi;
		if (range === '*') {
			lo = 0;
			hi = Infinity;
		} else if (range.includes('-')) {
			[lo, hi] = range.split('-').map(Number);
		} else {
			lo = hi = Number(range);
			if (isDow && lo === 7) lo = hi = 0;
		}
		if (!Number.isInteger(lo) || (hi !== Infinity && !Number.isInteger(hi))) return false;
		return value >= lo && value <= hi && (value - (lo === 0 || range === '*' ? 0 : lo)) % step === 0;
	});
}

/** @param {{ schedule?: string }[]} triggers */
export function cronTriggers(triggers) {
	return triggers.filter((t) => typeof t.schedule === 'string');
}

async function runTrigger(container, trigger) {
	await trigger.action.run({ input: {}, container });
}

/**
 * Cloudflare Workers `scheduled` handler. Runs every cron trigger whose
 * schedule equals `event.cron` (how Workers routes multi-cron Workers), or —
 * when `event.cron` is absent — whose schedule matches the event time.
 *
 * @param {*} container
 * @param {{ schedule?: string, action: { run(ctx: *): * } }[]} triggers
 */
export function scheduledHandler(container, triggers) {
	const crons = cronTriggers(triggers);
	return async (event) => {
		const due = event?.cron
			? crons.filter((t) => t.schedule === event.cron)
			: crons.filter((t) => cronMatches(t.schedule, new Date(event?.scheduledTime ?? Date.now())));
		for (const t of due) await runTrigger(container, t);
	};
}

/**
 * Local dev shim: checks once per minute (aligned to the minute) and runs
 * matching cron triggers. Returns a stop function.
 *
 * @param {*} container
 * @param {{ schedule?: string, action: { run(ctx: *): * } }[]} triggers
 * @param {{ onError?: (err: *, trigger: *) => void }} [opts]
 */
export function startCronShim(container, triggers, { onError } = {}) {
	const crons = cronTriggers(triggers);
	if (crons.length === 0) return () => {};
	let timer;
	const tick = async () => {
		const now = new Date();
		for (const t of crons.filter((t) => cronMatches(t.schedule, now))) {
			try {
				await runTrigger(container, t);
			} catch (err) {
				onError?.(err, t);
			}
		}
	};
	const arm = () => {
		const msToMinute = 60_000 - (Date.now() % 60_000);
		timer = setTimeout(async () => {
			await tick();
			arm();
		}, msToMinute);
	};
	arm();
	return () => clearTimeout(timer);
}
