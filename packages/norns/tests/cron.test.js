import { describe, expect, test } from 'bun:test';

import { cronMatches, cronTriggers, scheduledHandler } from '../src/server/cron.js';

// 2026-03-04 was a Wednesday (UTC).
const at = (h, m) => new Date(Date.UTC(2026, 2, 4, h, m));

describe('cronMatches', () => {
	test('* * * * * matches any time', () => {
		expect(cronMatches('* * * * *', at(13, 37))).toBe(true);
	});

	test('exact minute/hour', () => {
		expect(cronMatches('30 9 * * *', at(9, 30))).toBe(true);
		expect(cronMatches('30 9 * * *', at(9, 31))).toBe(false);
		expect(cronMatches('30 9 * * *', at(10, 30))).toBe(false);
	});

	test('step values', () => {
		expect(cronMatches('*/15 * * * *', at(8, 45))).toBe(true);
		expect(cronMatches('*/15 * * * *', at(8, 46))).toBe(false);
	});

	test('ranges with steps offset from the range start', () => {
		expect(cronMatches('10-30/10 * * * *', at(0, 10))).toBe(true);
		expect(cronMatches('10-30/10 * * * *', at(0, 20))).toBe(true);
		expect(cronMatches('10-30/10 * * * *', at(0, 25))).toBe(false);
		expect(cronMatches('10-30/10 * * * *', at(0, 40))).toBe(false);
	});

	test('comma lists', () => {
		expect(cronMatches('0,30 * * * *', at(5, 30))).toBe(true);
		expect(cronMatches('0,30 * * * *', at(5, 15))).toBe(false);
	});

	test('day-of-week including 7 as Sunday', () => {
		expect(cronMatches('* * * * 3', at(12, 0))).toBe(true); // Wednesday
		expect(cronMatches('* * * * 0', at(12, 0))).toBe(false);
		const sunday = new Date(Date.UTC(2026, 2, 8, 12, 0));
		expect(cronMatches('* * * * 7', sunday)).toBe(true);
	});

	test('day-of-month and month', () => {
		expect(cronMatches('0 0 4 3 *', at(0, 0))).toBe(true);
		expect(cronMatches('0 0 5 3 *', at(0, 0))).toBe(false);
	});

	test('malformed expressions never match', () => {
		expect(cronMatches('* * * *', at(0, 0))).toBe(false);
		expect(cronMatches('x * * * *', at(0, 0))).toBe(false);
		expect(cronMatches('*/0 * * * *', at(0, 0))).toBe(false);
	});
});

describe('scheduledHandler', () => {
	const mkTrigger = (schedule, runs, tag) => ({
		on: tag,
		schedule,
		action: { run: () => void runs.push(tag) }
	});

	test('routes by event.cron string equality', async () => {
		const runs = [];
		const triggers = [
			mkTrigger('*/5 * * * *', runs, 'five'),
			mkTrigger('0 0 * * *', runs, 'midnight'),
			{ on: 'x.deleted', action: { run: () => void runs.push('event') } }
		];
		await scheduledHandler({}, triggers)({ cron: '0 0 * * *' });
		expect(runs).toEqual(['midnight']);
	});

	test('falls back to time matching without event.cron', async () => {
		const runs = [];
		const triggers = [mkTrigger('30 9 * * *', runs, 'daily')];
		const ts = Date.UTC(2026, 2, 4, 9, 30);
		await scheduledHandler({}, triggers)({ scheduledTime: ts });
		expect(runs).toEqual(['daily']);
	});

	test('cronTriggers ignores event triggers', () => {
		expect(cronTriggers([{ on: 'a' }, { on: 'b', schedule: '* * * * *' }])).toHaveLength(1);
	});
});
