import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nornsConfig } from '../src/config.js';

let root;
let prevCwd;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'norns-config-'));
	prevCwd = process.cwd();
	process.chdir(root);
});

afterEach(() => {
	process.chdir(prevCwd);
	rmSync(root, { recursive: true, force: true });
});

describe('nornsConfig', () => {
	test('classic app: no files.routes/lib override, $custom alias set', () => {
		const cfg = nornsConfig();
		expect(cfg.kit.alias.$custom).toBe('src');
		expect(cfg.kit.files.routes).toBeUndefined();
		expect(cfg.kit.files.lib).toBeUndefined();
		expect(cfg.extensions).toEqual(['.svelte', '.n']);
	});

	test('spec-first app: routes and lib point into .norns/generated', () => {
		mkdirSync(join(root, 'specs'));
		const cfg = nornsConfig();
		expect(cfg.kit.files.routes).toBe(join('.norns', 'generated', 'routes'));
		expect(cfg.kit.files.lib).toBe(join('.norns', 'generated', 'lib'));
	});

	test('spec-first app: user files overrides win', () => {
		mkdirSync(join(root, 'specs'));
		const cfg = nornsConfig({ kit: { files: { routes: 'elsewhere/routes' } } });
		expect(cfg.kit.files.routes).toBe('elsewhere/routes');
		expect(cfg.kit.files.lib).toBe(join('.norns', 'generated', 'lib'));
	});

	test('hooks are found in src/ (classic)', () => {
		mkdirSync(join(root, 'src'));
		writeFileSync(join(root, 'src', 'hooks.server.c'), '');
		const cfg = nornsConfig();
		expect(cfg.kit.files.hooks.server).toBe(join('src', 'hooks.server.c'));
	});

	test('spec-first: hooks found in the generated tree', () => {
		mkdirSync(join(root, 'specs'));
		mkdirSync(join(root, '.norns', 'generated'), { recursive: true });
		writeFileSync(join(root, '.norns', 'generated', 'hooks.server.c'), '');
		const cfg = nornsConfig();
		expect(cfg.kit.files.hooks.server).toBe(join('.norns', 'generated', 'hooks.server.c'));
	});

	test('spec-first: a src/ hook wins over the generated one', () => {
		mkdirSync(join(root, 'specs'));
		mkdirSync(join(root, 'src'));
		mkdirSync(join(root, '.norns', 'generated'), { recursive: true });
		writeFileSync(join(root, 'src', 'hooks.server.c'), '');
		writeFileSync(join(root, '.norns', 'generated', 'hooks.server.c'), '');
		const cfg = nornsConfig();
		expect(cfg.kit.files.hooks.server).toBe(join('src', 'hooks.server.c'));
	});

	test('classic app never picks hooks from .norns/generated', () => {
		mkdirSync(join(root, '.norns', 'generated'), { recursive: true });
		writeFileSync(join(root, '.norns', 'generated', 'hooks.server.c'), '');
		const cfg = nornsConfig();
		expect(cfg.kit.files.hooks.server).toBeUndefined();
	});
});
