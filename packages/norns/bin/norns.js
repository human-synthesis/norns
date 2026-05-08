#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { watch, realpathSync, readFileSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const FRAMEWORK_PKGS = ['@human-synthesis/norns-core', '@human-synthesis/norns'];

function resolveWorkspaceFrameworkSrcs(root) {
	const require = createRequire(join(root, 'package.json'));
	const out = [];
	for (const pkg of FRAMEWORK_PKGS) {
		try {
			const real = realpathSync(require.resolve(`${pkg}/package.json`));
			const pkgDir = dirname(real);
			if (!pkgDir.includes(`${join('/', 'node_modules', '/')}`)) {
				out.push(join(pkgDir, 'src'));
			}
		} catch {}
	}
	return out;
}

/**
 * In workspace mode (a parent node_modules has framework packages as symlinks),
 * a `bun add <pkg>` from the consumer dir often drops the *published* version
 * of @human-synthesis/* into the local node_modules, which then shadows the
 * workspace symlinks. The shadow is the npm-published code, not the local
 * source — silently breaks dev. This detects the shadow and removes it.
 *
 * Only acts when both conditions hold:
 *   1. some ancestor node_modules has the framework package as a symlink
 *      (proves we're in workspace mode)
 *   2. the cwd-local node_modules has the same package as a real directory
 *      (the shadow that's overriding the symlink)
 *
 * No-op for normal installs (no symlinked ancestor → nothing to shadow).
 *
 * @param {string} cwd
 * @returns {string[]} package names that were cleaned
 */
function cleanShadowedFrameworkPkgs(cwd) {
	// Walk up from cwd looking for a parent with a framework package as symlink.
	let workspaceMode = false;
	let dir = dirname(cwd);
	while (dir !== dirname(dir)) {
		for (const pkg of FRAMEWORK_PKGS) {
			try {
				const stat = lstatSync(join(dir, 'node_modules', ...pkg.split('/')));
				if (stat.isSymbolicLink()) {
					workspaceMode = true;
					break;
				}
			} catch {}
		}
		if (workspaceMode) break;
		dir = dirname(dir);
	}
	if (!workspaceMode) return [];

	const removed = [];
	for (const pkg of FRAMEWORK_PKGS) {
		const shadowPath = join(cwd, 'node_modules', ...pkg.split('/'));
		try {
			const stat = lstatSync(shadowPath);
			// lstat doesn't follow symlinks — a symlinked dir reports
			// isDirectory() === false, so this only matches real dirs.
			if (stat.isDirectory()) {
				rmSync(shadowPath, { recursive: true, force: true });
				removed.push(pkg);
			}
		} catch {}
	}

	// Tidy up an emptied @human-synthesis/ scope dir if it has no other content.
	const scopeDir = join(cwd, 'node_modules', '@human-synthesis');
	try {
		if (readdirSync(scopeDir).length === 0) rmSync(scopeDir, { recursive: true, force: true });
	} catch {}

	return removed;
}

function findViteBin(root) {
	const require = createRequire(join(root, 'package.json'));
	const pkgPath = require.resolve('vite/package.json');
	const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
	const binEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.vite;
	if (!binEntry) throw new Error('vite package has no bin entry');
	return join(dirname(pkgPath), binEntry);
}

function devCommand(passthrough) {
	const cwd = process.cwd();
	const cleaned = cleanShadowedFrameworkPkgs(cwd);
	if (cleaned.length > 0) {
		console.log(
			`[norns] removed shadowed framework packages from local node_modules: ${cleaned.join(', ')} ` +
				`— the workspace symlinks at the parent will be used instead.`
		);
	}
	const viteBin = findViteBin(cwd);
	const watchSrcs = resolveWorkspaceFrameworkSrcs(cwd);

	let child = null;
	let restarting = false;
	let pendingRestart = false;

	function spawnVite() {
		child = spawn(process.execPath, [viteBin, 'dev', ...passthrough], {
			cwd,
			stdio: 'inherit',
			env: process.env
		});
		child.on('exit', (code, signal) => {
			child = null;
			if (restarting) {
				restarting = false;
				if (pendingRestart) {
					pendingRestart = false;
				}
				spawnVite();
				return;
			}
			process.exit(code ?? (signal ? 1 : 0));
		});
	}

	function restart(reason) {
		if (restarting) {
			pendingRestart = true;
			return;
		}
		restarting = true;
		console.log(`\n[norns] ${reason} — respawning vite dev for fresh module cache.\n`);
		if (child && child.exitCode === null) child.kill('SIGTERM');
		else spawnVite();
	}

	let debounce = null;
	function onChange(file) {
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			restart(`framework source changed (${file})`);
		}, 100);
	}

	for (const src of watchSrcs) {
		try {
			watch(src, { recursive: true }, (_event, filename) => {
				if (!filename) return;
				onChange(join(src, filename));
			});
			console.log(`[norns] watching framework src: ${src}`);
		} catch (err) {
			console.warn(`[norns] could not watch ${src}: ${err.message}`);
		}
	}

	for (const sig of ['SIGINT', 'SIGTERM']) {
		process.on(sig, () => {
			if (child && child.exitCode === null) child.kill(sig);
			else process.exit(0);
		});
	}

	spawnVite();
}

function passthroughCommand(name, passthrough) {
	const cwd = process.cwd();
	const cleaned = cleanShadowedFrameworkPkgs(cwd);
	if (cleaned.length > 0) {
		console.log(
			`[norns] removed shadowed framework packages from local node_modules: ${cleaned.join(', ')}`
		);
	}
	const viteBin = findViteBin(cwd);
	const child = spawn(process.execPath, [viteBin, name, ...passthrough], {
		cwd,
		stdio: 'inherit',
		env: process.env
	});
	child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

const [, , cmd = 'dev', ...rest] = process.argv;

switch (cmd) {
	case 'dev':
		devCommand(rest);
		break;
	case 'build':
	case 'preview':
		passthroughCommand(cmd, rest);
		break;
	case '-h':
	case '--help':
		console.log(`norns <command>

Commands:
  dev       start vite dev with framework-source watching (default)
  build     run vite build
  preview   run vite preview
`);
		break;
	default:
		console.error(`norns: unknown command "${cmd}"`);
		process.exit(1);
}
