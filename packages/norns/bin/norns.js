#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { watch, realpathSync, readFileSync, lstatSync, readdirSync, rmSync, existsSync } from 'node:fs';
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
import { nornsLint, printFindings } from '../src/lint.js';
import { nornsDiag } from '../src/diag.js';

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

/**
 * Spec-first regeneration hook. Returns null when the app has no `specs/`
 * dir; otherwise a closure that (re)generates `.norns/generated/` and
 * reports refusals without throwing.
 */
async function makeSpecRegen(cwd) {
	if (!existsSync(join(cwd, 'specs'))) return null;
	const { generateApp } = await import('../src/kernel/index.js');
	return () => {
		try {
			const result = generateApp(join(cwd, 'specs'));
			if (result.written.length > 0) {
				console.log(
					`[norns] generated ${result.written.length} file(s) (spec ${result.version.slice(0, 12)})`
				);
			}
			return true;
		} catch (err) {
			console.error(`[norns] generate refused:\n${err.message}`);
			return false;
		}
	};
}

async function devCommand(passthrough) {
	const cwd = process.cwd();
	const cleaned = cleanShadowedFrameworkPkgs(cwd);
	if (cleaned.length > 0) {
		console.log(
			`[norns] removed shadowed framework packages from local node_modules: ${cleaned.join(', ')} ` +
				`— the workspace symlinks at the parent will be used instead.`
		);
	}

	const regen = await makeSpecRegen(cwd);
	if (regen) {
		regen();
		const specsDir = join(cwd, 'specs');
		let specDebounce = null;
		try {
			watch(specsDir, { recursive: true }, () => {
				clearTimeout(specDebounce);
				// Vite HMR picks up the rewritten files in .norns/generated/ itself;
				// a failed regenerate keeps serving the last good tree.
				specDebounce = setTimeout(() => regen(), 100);
			});
			console.log(`[norns] watching specs: ${specsDir}`);
		} catch (err) {
			console.warn(`[norns] could not watch ${specsDir}: ${err.message}`);
		}
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

async function passthroughCommand(name, passthrough) {
	const cwd = process.cwd();

	if (name === 'build') {
		const regen = await makeSpecRegen(cwd);
		if (regen && !regen()) process.exit(1);
	}

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
			case 'gen':
				return runMigrateGen(rest.slice(1));
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
				console.error('Usage: norns migrate <gen|status|up|create <feature>/<name>>');
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

async function validateCommand(rest) {
	try {
		const { validateSpecs } = await import('../src/kernel/index.js');
		const result = validateSpecs(rest[0]);
		for (const issue of result.issues) {
			console.log(`[${issue.level}] ${issue.address}: ${issue.message}`);
		}
		if (result.ok) {
			console.log(
				`spec ok — ${result.modules.length} module(s), version ${result.version.slice(0, 12)}`
			);
		} else {
			process.exit(1);
		}
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
}

async function runMigrateGen(rest) {
	try {
		const { migrateApp } = await import('../src/kernel/index.js');
		const force = rest.includes('--force');
		const dir = rest.find((a) => !a.startsWith('--'));
		const result = await migrateApp(dir, { force });
		const modules = Object.keys(result.created);
		if (modules.length === 0) {
			console.log('migrations up to date — no schema changes');
			return;
		}
		for (const m of modules) {
			for (const f of result.created[m]) console.log(`created migrations/${m}/${f}`);
		}
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
}

async function generateCommand(rest) {
	try {
		const { generateApp } = await import('../src/kernel/index.js');
		const result = generateApp(rest[0]);
		console.log(`generated ${result.written.length} file(s) at spec version ${result.version}`);
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
}

async function traceCommand(rest) {
	try {
		const { traceApp } = await import('../src/kernel/index.js');
		const report = await traceApp(rest[0]);
		for (const c of report.cases) {
			const mark = c.pass ? '✓' : '✗';
			console.log(`${mark} ${c.address} #${c.index}`);
			if (!c.pass) {
				if (c.error) console.log(`    error: ${c.error}${c.status ? ` (${c.status})` : ''}`);
				console.log(`    input:  ${JSON.stringify(c.input)}`);
				console.log(`    expect: ${JSON.stringify(c.expect)}`);
				if (c.row) console.log(`    row:    ${JSON.stringify(c.row)}`);
				if (c.result !== undefined) console.log(`    result: ${JSON.stringify(c.result)}`);
			}
			for (const e of c.events) console.log(`    emit ${e.name}`);
			for (const call of c.calls) console.log(`    call ${call.name}`);
		}
		console.log(`${report.pass} pass, ${report.fail} fail (spec ${report.version.slice(0, 12)})`);
		process.exit(report.fail > 0 ? 1 : 0);
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
}

function lintCommand() {
	const findings = nornsLint(process.cwd());
	const { errors } = printFindings(findings);
	process.exit(errors > 0 ? 1 : 0);
}

async function diagCommand(rest) {
	const file = rest[0];
	if (!file) {
		console.error('Usage: norns diag <file.c | file.civet | file.n>');
		process.exit(1);
	}
	try {
		const js = await nornsDiag(file);
		process.stdout.write(js);
		if (!js.endsWith('\n')) process.stdout.write('\n');
	} catch (err) {
		console.error(`norns diag: ${err.message}`);
		if (err.stack) console.error(err.stack);
		process.exit(1);
	}
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
	case 'migrate':
		migrateCommand(rest);
		break;
	case 'lint':
		lintCommand();
		break;
	case 'validate':
		validateCommand(rest);
		break;
	case 'generate':
		generateCommand(rest);
		break;
	case 'trace':
		traceCommand(rest);
		break;
	case 'diag':
		diagCommand(rest);
		break;
	case '-h':
	case '--help':
		console.log(`norns <command>

Commands:
  dev                                start vite dev; watches specs/ → regenerate (spec-first) and framework src (default)
  build                              generate from specs/ (spec-first), then run vite build
  preview                            run vite preview
  migrate gen [dir] [--force]        diff specs against migrations/ via drizzle-kit (additive-only)
  migrate status                     list applied + pending migrations
  migrate up                         apply pending migrations
  migrate create <feature>/<name>    scaffold a new SQL migration
  validate [dir]                     validate specs/*.tron (default dir: ./specs)
  generate [dir]                     validate specs and generate code into .norns/generated/
  trace [dir]                        run Action examples against a sandboxed in-memory SQLite
  lint                               scan .c/.civet/.n + vite.config for known AI pitfalls
  diag <file>                        print the compiled JS for a .c/.civet/.n file

Migration db is read from \$DATABASE_URL (default: file:./data/app.db).
Only file: (better-sqlite3) is supported in v1; for D1 use \`wrangler d1 migrations apply\`.
`);
		break;
	default:
		console.error(`norns: unknown command "${cmd}"`);
		process.exit(1);
}
