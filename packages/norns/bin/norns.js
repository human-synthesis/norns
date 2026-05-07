#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { watch, realpathSync, readFileSync } from 'node:fs';
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
