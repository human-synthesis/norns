#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { watch, realpathSync, readFileSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
	listMigrations,
	resolveDatabaseUrl,
	openSqliteDb,
	getApplied,
	applyMigrations,
	createMigration
} from '../src/migrate.js';
import { nornsLint, printFindings, countFindings } from '../src/lint.js';
import { nornsDiag, nornsDiagTemplate } from '../src/diag.js';
import { nornsCheck, printCheck, loadSvelteConfig } from '../src/check.js';

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

function migrateCommand(rest) {
	const sub = rest[0] || 'status';
	const cwd = process.cwd();
	const cleaned = cleanShadowedFrameworkPkgs(cwd);
	if (cleaned.length > 0) {
		console.log(
			`[norns] removed shadowed framework packages from local node_modules: ${cleaned.join(', ')}`
		);
	}
	try {
		switch (sub) {
			case 'status':
				return runMigrateStatus(cwd);
			case 'up':
				return runMigrateUp(cwd);
			case 'create': {
				const file = createMigration(cwd, rest[1]);
				console.log(`Created ${file}`);
				return;
			}
			default:
				console.error(`norns migrate: unknown subcommand "${sub}"`);
				console.error('Usage: norns migrate <status|up|create <feature>/<name>>');
				process.exit(1);
		}
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
}

function runMigrateStatus(cwd) {
	const all = listMigrations(cwd);
	if (all.length === 0) {
		console.log('No migrations found.');
		return;
	}
	const db = openTargetDb(cwd);
	const applied = getApplied(db);
	console.log(`Found ${all.length} migration(s):`);
	for (const m of all) {
		const tag = applied.has(m.id) ? '[applied]' : '[pending]';
		console.log(`  ${tag} ${m.id}`);
	}
	const pending = all.filter((m) => !applied.has(m.id)).length;
	console.log(`\n${pending} pending, ${all.length - pending} applied.`);
}

function runMigrateUp(cwd) {
	const all = listMigrations(cwd);
	if (all.length === 0) {
		console.log('No migrations found.');
		return;
	}
	const db = openTargetDb(cwd);
	const applied = getApplied(db);
	const pending = all.filter((m) => !applied.has(m.id));
	if (pending.length === 0) {
		console.log('Nothing to apply — all migrations are up to date.');
		return;
	}
	console.log(`Applying ${pending.length} migration(s)...`);
	for (const m of pending) {
		try {
			applyMigrations(db, [m]);
			console.log(`  [ok] ${m.id}`);
		} catch (err) {
			console.error(`  [fail] ${m.id}: ${err.message}`);
			process.exit(1);
		}
	}
	console.log('Done.');
}

function openTargetDb(cwd) {
	const target = resolveDatabaseUrl(cwd);
	return openSqliteDb(cwd, target.path);
}

function lintCommand(args, flags) {
	const findings = nornsLint(process.cwd());
	if (flags.has('--json')) {
		const { errors, warnings } = countFindings(findings);
		console.log(JSON.stringify({ ok: errors === 0, errors, warnings, findings }, null, 2));
		process.exit(errors > 0 ? 1 : 0);
	}
	const { errors } = printFindings(findings);
	process.exit(errors > 0 ? 1 : 0);
}

async function checkCommand(args, flags) {
	let result;
	try {
		result = await nornsCheck({ cwd: process.cwd(), warnings: flags.has('--warnings') });
	} catch (err) {
		console.error(`norns check: ${err.message}`);
		if (err.stack) console.error(err.stack);
		process.exit(2);
	}
	if (flags.has('--json')) {
		console.log(JSON.stringify({ ok: result.errors.length === 0, ...result }, null, 2));
		process.exit(result.errors.length > 0 ? 1 : 0);
	}
	const errors = printCheck(result);
	process.exit(errors > 0 ? 1 : 0);
}

async function diagCommand(args, flags) {
	const file = args[0];
	if (!file) {
		console.error('Usage: norns diag [--template] <file.c | file.civet | file.n>');
		process.exit(1);
	}
	try {
		let out;
		if (flags.has('--template')) {
			const config = await loadSvelteConfig(process.cwd());
			let pre = config?.preprocess;
			if (!pre) {
				const { nornsPreprocess } = await import('@human-synthesis/norns-core/preprocess');
				pre = nornsPreprocess();
			}
			out = await nornsDiagTemplate(file, pre);
		} else {
			out = await nornsDiag(file);
		}
		process.stdout.write(out);
		if (!out.endsWith('\n')) process.stdout.write('\n');
	} catch (err) {
		console.error(`norns diag: ${err.message}`);
		if (err.stack && !err.line) console.error(err.stack);
		process.exit(1);
	}
}

const [, , cmd = 'dev', ...rest] = process.argv;
// `--flag` options are collected separately for the norns-owned commands;
// dev/build/preview pass everything through to vite untouched.
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));

switch (cmd) {
	case 'dev':
		devCommand(rest);
		break;
	case 'build':
	case 'preview':
		passthroughCommand(cmd, rest);
		break;
	case 'migrate':
		migrateCommand(rest);
		break;
	case 'lint':
		lintCommand(args, flags);
		break;
	case 'check':
		checkCommand(args, flags);
		break;
	case 'diag':
		diagCommand(args, flags);
		break;
	case '-h':
	case '--help':
		console.log(`norns <command>

Commands:
  dev                                start vite dev with framework-source watching (default)
  build                              run vite build
  preview                            run vite preview
  migrate status                     list applied + pending migrations
  migrate up                         apply pending migrations
  migrate create <feature>/<name>    scaffold a new SQL migration
  lint [--json]                      scan .c/.civet/.n (templates + script blocks) and vite.config for known pitfalls
  check [--json] [--warnings]        preprocess + compile every .n/.c/.civet through svelte.config.js; file:line:column errors
  diag <file>                        print the JS Civet compiles a .c/.civet/.n script to
  diag --template <file.n>           print the Svelte source the compiler sees after Pug/Civet/auto-import preprocessing

Verification order for a change: lint, check, build, then curl through dev.
Migration db is read from \$DATABASE_URL (default: file:./data/app.db).
Only file: (better-sqlite3) is supported in v1; for D1 use \`wrangler d1 migrations apply\`.
`);
		break;
	default:
		console.error(`norns: unknown command "${cmd}"`);
		process.exit(1);
}
