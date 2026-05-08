import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	listFeatures,
	listMigrations,
	resolveDatabaseUrl,
	openSqliteDb,
	getApplied,
	applyMigrations,
	createMigration
} from '../src/migrate.js';

let cwd;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'norns-migrate-'));
	// Each scratch app is a real bun-installable shape so createRequire from inside
	// it can find better-sqlite3 via the workspace.
	writeFileSync(
		join(cwd, 'package.json'),
		JSON.stringify({ name: 'scratch', private: true, type: 'module' })
	);
	mkdirSync(join(cwd, 'src', 'lib'), { recursive: true });
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	delete process.env.DATABASE_URL;
});

describe('listFeatures', () => {
	test('returns folders that contain server/module.c', () => {
		mkFeature(cwd, 'notes');
		mkFeature(cwd, 'tags');
		mkdirSync(join(cwd, 'src', 'lib', 'components'), { recursive: true });
		mkdirSync(join(cwd, 'src', 'lib', 'utils'), { recursive: true });
		mkdirSync(join(cwd, 'src', 'lib', '_internal', 'server'), { recursive: true });
		writeFileSync(join(cwd, 'src', 'lib', '_internal', 'server', 'module.c'), '');
		// Folder without module.c is not a feature
		mkdirSync(join(cwd, 'src', 'lib', 'half', 'server'), { recursive: true });

		expect(listFeatures(join(cwd, 'src', 'lib'))).toEqual(['notes', 'tags']);
	});

	test('empty when src/lib does not exist', () => {
		rmSync(join(cwd, 'src'), { recursive: true });
		expect(listFeatures(join(cwd, 'src', 'lib'))).toEqual([]);
	});
});

describe('listMigrations', () => {
	test('scans and sorts by filename across features', () => {
		mkMigration(cwd, 'notes', '20260101_init.sql', 'CREATE TABLE notes (id INT);');
		mkMigration(cwd, 'tags', '20260102_init.sql', 'CREATE TABLE tags (id INT);');
		mkMigration(cwd, 'notes', '20260201_add_col.sql', 'ALTER TABLE notes ADD COLUMN x INT;');

		const out = listMigrations(cwd);
		expect(out.map((m) => m.id)).toEqual([
			'notes/20260101_init',
			'tags/20260102_init',
			'notes/20260201_add_col'
		]);
	});

	test('returns empty when migrations/ root does not exist', () => {
		expect(listMigrations(cwd)).toEqual([]);
	});

	test('non-sql files are ignored', () => {
		mkMigration(cwd, 'notes', '20260101_init.sql', 'CREATE TABLE notes (id INT);');
		mkMigration(cwd, 'notes', 'README.md', '# notes migrations');
		const out = listMigrations(cwd);
		expect(out.map((m) => m.file)).toEqual(['20260101_init.sql']);
	});
});

describe('resolveDatabaseUrl', () => {
	test('default is file:./data/app.db', () => {
		expect(resolveDatabaseUrl(cwd)).toEqual({ kind: 'sqlite', path: join(cwd, 'data', 'app.db') });
	});

	test('honors DATABASE_URL with file: scheme', () => {
		process.env.DATABASE_URL = 'file:/tmp/custom.db';
		expect(resolveDatabaseUrl(cwd)).toEqual({ kind: 'sqlite', path: '/tmp/custom.db' });
	});

	test('rejects non-file schemes with helpful message', () => {
		process.env.DATABASE_URL = 'postgres://localhost/x';
		expect(() => resolveDatabaseUrl(cwd)).toThrow(/only SQLite \(file:\.\.\.\) is supported/);
	});
});

// `bun:test` segfaults when loading the better-sqlite3 native binding on this
// platform — verified the same module loads cleanly under node. Until that's
// resolved upstream, the SQLite-touching paths are exercised end-to-end in
// norns-app via `norns migrate up` (see Phase 7 verification).
describe.skip('openSqliteDb + applyMigrations + getApplied', () => {
	test('end-to-end: status pending → applies → status applied', () => {
		mkMigration(
			cwd,
			'notes',
			'20260101_init.sql',
			'CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL);'
		);
		mkMigration(
			cwd,
			'notes',
			'20260102_seed.sql',
			"INSERT INTO notes (title) VALUES ('hello');"
		);

		const db = openSqliteDb(cwd, join(cwd, 'data', 'app.db'), { requireFrom: import.meta.url });

		// Initially empty
		expect([...getApplied(db)]).toEqual([]);

		const all = listMigrations(cwd);
		const applied = applyMigrations(db, all);
		expect(applied).toEqual(['notes/20260101_init', 'notes/20260102_seed']);

		// Now both tracked
		expect([...getApplied(db)].sort()).toEqual(['notes/20260101_init', 'notes/20260102_seed']);

		// Schema applied + seeded
		const row = db.prepare('SELECT title FROM notes').get();
		expect(row.title).toBe('hello');

		// Re-running pending is empty
		const stillApplied = getApplied(db);
		const remaining = all.filter((m) => !stillApplied.has(m.id));
		expect(remaining).toEqual([]);

		db.close();
	});

	test('applyMigrations rolls back on SQL error and does not record the migration', () => {
		mkMigration(cwd, 'notes', '20260101_bad.sql', 'CREATE TABLE notes (id INT); BAD SQL HERE;');

		const db = openSqliteDb(cwd, join(cwd, 'data', 'app.db'), { requireFrom: import.meta.url });
		const all = listMigrations(cwd);
		expect(() => applyMigrations(db, all)).toThrow();
		expect([...getApplied(db)]).toEqual([]);
		// And the table should NOT exist (rolled back)
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'")
			.all();
		expect(tables).toEqual([]);
		db.close();
	});
});

describe('createMigration', () => {
	test('writes a timestamp-prefixed sql file under migrations/<feature>/', () => {
		const file = createMigration(cwd, 'notes/add_pinned_column');
		expect(file).toMatch(/\/migrations\/notes\/\d{14}_add_pinned_column\.sql$/);
		expect(existsSync(file)).toBe(true);
	});

	test('accepts any feature name (no $lib filesystem check)', () => {
		const file = createMigration(cwd, 'ghosts/init');
		expect(file).toMatch(/\/migrations\/ghosts\/\d{14}_init\.sql$/);
		expect(existsSync(file)).toBe(true);
	});

	test('rejects malformed arg', () => {
		expect(() => createMigration(cwd, 'noslash')).toThrow(/Usage:/);
	});
});

function mkFeature(cwd, name) {
	const dir = join(cwd, 'src', 'lib', name, 'server');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'module.c'), 'module.exports = (app) ->\n');
}

function mkMigration(cwd, feature, file, content) {
	const dir = join(cwd, 'migrations', feature);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), content);
}
