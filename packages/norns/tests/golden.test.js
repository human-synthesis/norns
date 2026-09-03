/**
 * Golden-file harness (K-08). Fixture specs live in tests/golden/specs as
 * canonical TRON; derived artifacts (edge graph, validation report) are
 * snapshotted next to them. Any drift — formatter, meta-schema, refinement
 * or graph changes — fails byte-identically.
 *
 * Regenerate intentionally with:  UPDATE_GOLDEN=1 bun test tests/golden.test.js
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { formatCanonical } from '@human-synthesis/norns-tron';
import { readSpec, writeSpec } from '@human-synthesis/norns-tron/spec';

import { EMITTERS, buildGraph, loadSpecs, validateSpecs } from '../src/kernel/index.js';
import { APP, CATALOG, ORDERS } from './kernel-fixtures.js';

const GOLDEN = join(import.meta.dir, 'golden');
const SPECS = join(GOLDEN, 'specs');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

function emitAll(specs) {
	const graph = buildGraph(specs.modules);
	const files = [];
	for (const [moduleName, moduleSpec] of Object.entries(specs.modules)) {
		for (const emitter of EMITTERS) {
			files.push(...emitter.emit({ moduleName, moduleSpec, specs, graph }));
		}
	}
	return files;
}

if (UPDATE) {
	mkdirSync(SPECS, { recursive: true });
	writeSpec(join(SPECS, 'app.tron'), APP);
	writeSpec(join(SPECS, 'orders.tron'), ORDERS);
	writeSpec(join(SPECS, 'catalog.tron'), CATALOG);
	const specs = loadSpecs(SPECS);
	const graph = buildGraph(specs.modules);
	writeFileSync(join(GOLDEN, 'edges.json'), JSON.stringify(graph.edges, null, '\t') + '\n');
	writeFileSync(
		join(GOLDEN, 'validate.json'),
		JSON.stringify(validateSpecs(SPECS), null, '\t') + '\n'
	);
	for (const file of emitAll(specs)) {
		const full = join(GOLDEN, 'generated', file.path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, file.text);
	}
}

describe('golden files', () => {
	test('golden dir exists (run UPDATE_GOLDEN=1 once after adding fixtures)', () => {
		expect(existsSync(SPECS)).toBe(true);
	});

	test('canonical form is a byte-identical fixed point on disk', () => {
		for (const file of readdirSync(SPECS)) {
			const full = join(SPECS, file);
			const onDisk = readFileSync(full, 'utf-8');
			expect(formatCanonical(readSpec(full))).toBe(onDisk);
		}
	});

	test('validation report matches golden byte-for-byte', () => {
		const report = JSON.stringify(validateSpecs(SPECS), null, '\t') + '\n';
		expect(report).toBe(readFileSync(join(GOLDEN, 'validate.json'), 'utf-8'));
	});

	test('edge graph matches golden byte-for-byte', () => {
		const specs = loadSpecs(SPECS);
		const edges = JSON.stringify(buildGraph(specs.modules).edges, null, '\t') + '\n';
		expect(edges).toBe(readFileSync(join(GOLDEN, 'edges.json'), 'utf-8'));
	});

	test('generated output matches golden byte-for-byte', () => {
		const files = emitAll(loadSpecs(SPECS));
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			expect(file.text).toBe(readFileSync(join(GOLDEN, 'generated', file.path), 'utf-8'));
		}
	});

	// K-49: a spec `title` renders verbatim as the page heading, overriding the
	// humanized unit name — the one hook to rename or localize generated chrome.
	test('a page title override wins over the humanized unit name', () => {
		const files = emitAll(loadSpecs(SPECS));
		const board = files.find((f) => f.path.endsWith('routes/orders/+page.n'));
		expect(board.text).toContain('h1.norns-page-title Order Board');
		expect(board.text).not.toContain('norns-page-title Board\n');
	});
});
