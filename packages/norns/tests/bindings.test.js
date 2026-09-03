import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { checkBindings, checkGenerate, checkLiveBindings, checkSnippetBindings } from '../src/kernel/generate.js';
import { emitModulePages } from '../src/kernel/emit-units.js';

/** Minimal stand-in for @human-synthesis/norns-ui/contracts (same shape). */
const query = v.pipe(v.string(), v.regex(/^\w+\.Query\.\w+$/, 'expected a Query address'));
const action = v.pipe(v.string(), v.regex(/^\w+\.Action\.\w+$/, 'expected an Action address'));
const literal = v.union([v.string(), v.number(), v.boolean()]);
const CONTRACTS = {
	Table: v.strictObject({
		data: query,
		columns: v.optional(literal),
		pageSize: v.optional(literal)
	}),
	Form: v.strictObject({ action, method: v.optional(literal) })
};

const specsWith = (components) => ({
	modules: {
		crm: {
			module: 'crm',
			pages: { deals: { route: '/deals', components } }
		}
	}
});

describe('checkBindings (U-02)', () => {
	test('valid palette bindings pass', () => {
		const specs = specsWith([
			{ table: 'crm.Query.listDeals', columns: 'name,amount', pageSize: 10 },
			{ form: 'crm.Action.createDeal', method: 'POST' }
		]);
		expect(checkBindings(specs, CONTRACTS)).toEqual([]);
	});

	test('unknown prop is refused with a pointed path', () => {
		const specs = specsWith([{ table: 'crm.Query.listDeals', rows: 'nope' }]);
		const [r] = checkBindings(specs, CONTRACTS);
		expect(r.code).toBe('INVALID_BINDING');
		expect(r.address).toBe('crm.Page.deals');
		expect(r.path).toBe('crm.Page.deals.components[0].rows');
		expect(r.fix).toContain('Table');
	});

	test('an Action where the contract wants a Query is refused', () => {
		const specs = specsWith([{ table: 'crm.Action.reprice' }]);
		const [r] = checkBindings(specs, CONTRACTS);
		expect(r.code).toBe('INVALID_BINDING');
		expect(r.message).toContain('<Table>');
	});

	test('a Query where the contract wants an Action is refused', () => {
		const specs = specsWith([{ form: 'crm.Query.listDeals' }]);
		expect(checkBindings(specs, CONTRACTS)).toHaveLength(1);
	});

	// K-50: TRON sorts keys on write, so with two same-kind address keys the
	// tag pick would be alphabetical luck — refuse instead of guessing.
	test('two Query-address keys are refused as ambiguous, not silently picked', () => {
		const specs = specsWith([{ rows: 'crm.Query.listDeals', simpleTable: 'crm.Query.listDeals' }]);
		const [r] = checkBindings(specs, CONTRACTS);
		expect(r.code).toBe('AMBIGUOUS_COMPONENT');
		expect(r.message).toContain('rows');
		expect(r.message).toContain('simpleTable');
		expect(r.fix).toContain('component:');
	});

	test('two Action-address keys with no Query are ambiguous too; one of each is fine', () => {
		const two = specsWith([{ form: 'crm.Action.createDeal', other: 'crm.Action.reprice' }]);
		expect(checkBindings(two, CONTRACTS)[0]?.code).toBe('AMBIGUOUS_COMPONENT');
		// one Query + one Action = the Kanban/onMove pattern — never ambiguous
		const mixed = specsWith([{ table: 'crm.Query.listDeals', onMove: 'crm.Action.reprice' }]);
		expect(checkBindings(mixed, CONTRACTS).filter((r) => r.code === 'AMBIGUOUS_COMPONENT')).toEqual([]);
	});

	test('tags without a contract are left alone (custom components)', () => {
		const specs = specsWith([{ dealChart: 'crm.Query.listDeals', anything: 'goes' }]);
		expect(checkBindings(specs, CONTRACTS)).toEqual([]);
	});

	test('checkGenerate only validates bindings when contracts are supplied', () => {
		const specs = specsWith([{ table: 'crm.Action.reprice' }]);
		expect(checkGenerate(specs).find((r) => r.code === 'INVALID_BINDING')).toBeUndefined();
		expect(
			checkGenerate(specs, { contracts: CONTRACTS }).find((r) => r.code === 'INVALID_BINDING')
		).toBeDefined();
	});
});

describe('pageBindings emission for palette props', () => {
	test('an Action in the component slot binds the `action` prop', () => {
		const spec = {
			module: 'crm',
			pages: {
				create: { route: '/deals/new', components: [{ form: 'crm.Action.createDeal' }] }
			}
		};
		const tpl = emitModulePages('crm', spec).find((f) => f.path.endsWith('+page.n'));
		expect(tpl.text).toContain('Form(action="?/createDeal")');
	});

	test('number and boolean literals pass through as expressions', () => {
		const spec = {
			module: 'crm',
			pages: {
				deals: {
					route: '/deals',
					components: [{ table: 'crm.Query.listDeals', pageSize: 10, striped: true }]
				}
			}
		};
		const tpl = emitModulePages('crm', spec).find((f) => f.path.endsWith('+page.n'));
		expect(tpl.text).toContain('Table(data!="{data.listDeals}" pageSize!="{10}" striped!="{true}")');
	});
});

/** games module with a streaming Endpoint + Room Worker (K-27 fixtures). */
const liveSpecs = (components) => ({
	modules: {
		games: {
			module: 'games',
			endpoints: {
				chat: {
					route: '/api/chat',
					method: 'POST',
					auth: { mode: 'none' },
					input: { prompt: 'text' },
					stream: { frame: { delta: 'text' } },
					impl: 'custom'
				},
				scores: {
					route: '/api/scores',
					method: 'GET',
					auth: { mode: 'none' },
					output: { top: 'json' },
					impl: 'custom'
				}
			},
			workers: {
				matchRoom: {
					source: './src/games/workers/match.c',
					auth: 'session',
					room: true,
					messages: {
						chat: { in: { text: 'text' }, out: { text: 'text', from: 'text' } },
						move: { in: { square: 'text' } }
					}
				},
				mailer: { source: './src/games/workers/mailer.c', auth: 'session' }
			},
			pages: { play: { route: '/play', components } }
		}
	}
});

describe('checkLiveBindings (K-27)', () => {
	test('valid stream and room bindings pass', () => {
		const refusals = checkLiveBindings(
			liveSpecs([
				{ streamText: { stream: 'games.Endpoint.chat' } },
				{ chatThread: { room: 'games.Worker.matchRoom', sends: ['chat'], receives: ['chat'] } },
				{ presenceAvatars: { room: 'games.Worker.matchRoom' } },
				{ table: 'games.Query.leaderboard' }
			])
		);
		expect(refusals).toEqual([]);
	});

	test('stream binding must target an Endpoint with a stream output mode', () => {
		const [nonStream] = checkLiveBindings(
			liveSpecs([{ streamText: { stream: 'games.Endpoint.scores' } }])
		);
		expect(nonStream.code).toBe('INVALID_BINDING');
		expect(nonStream.path).toBe('games.Page.play.components[0].streamText.stream');
		expect(nonStream.message).toContain('no `stream` output mode');

		const [missing] = checkLiveBindings(
			liveSpecs([{ streamText: { stream: 'games.Endpoint.nope' } }])
		);
		expect(missing.message).toContain('existing Endpoint address');

		const [wrongKind] = checkLiveBindings(
			liveSpecs([{ streamText: { stream: 'games.Worker.matchRoom' } }])
		);
		expect(wrongKind.code).toBe('INVALID_BINDING');
	});

	test('room binding must target a Worker declared room: true', () => {
		const [notRoom] = checkLiveBindings(
			liveSpecs([{ chatThread: { room: 'games.Worker.mailer' } }])
		);
		expect(notRoom.code).toBe('INVALID_BINDING');
		expect(notRoom.message).toContain('`room: true`');

		const [missing] = checkLiveBindings(liveSpecs([{ chatThread: { room: 'games.Worker.nope' } }]));
		expect(missing.message).toContain('existing Worker address');
	});

	test('sends/receives are cross-checked against the message schemas', () => {
		const refusals = checkLiveBindings(
			liveSpecs([
				{
					chatThread: {
						room: 'games.Worker.matchRoom',
						sends: ['chat', 'undeclared'],
						receives: ['move'] // move has `in` but no `out`
					}
				}
			])
		);
		expect(refusals.map((r) => r.path)).toEqual([
			'games.Page.play.components[0].chatThread.sends',
			'games.Page.play.components[0].chatThread.receives'
		]);
		expect(refusals[0].message).toContain('"undeclared"');
		expect(refusals[1].message).toContain('no `out` schema');
	});

	test('checkGenerate runs the live-binding check without contracts', () => {
		const specs = liveSpecs([{ streamText: { stream: 'games.Endpoint.scores' } }]);
		const refusals = checkGenerate(specs);
		expect(refusals.some((r) => r.code === 'INVALID_BINDING')).toBe(true);
	});
});

describe('page emitter realtime props (K-27)', () => {
	test('wires streamSource (endpoint route) and roomChannel (address) props', () => {
		const specs = liveSpecs([
			{ streamText: { stream: 'games.Endpoint.chat' } },
			{ chatThread: { room: 'games.Worker.matchRoom', sends: ['chat'], receives: ['chat'] } }
		]);
		const tpl = emitModulePages('games', specs.modules.games, specs).find((f) =>
			f.path.endsWith('+page.n')
		);
		expect(tpl.text).toContain('StreamText(streamSource="/api/chat")');
		expect(tpl.text).toContain('ChatThread(roomChannel="games.Worker.matchRoom")');
	});
});

/** crm module with declared Snippet units (U-07 fixtures). */
const snippetSpecs = (components, snippets = {}) => ({
	modules: {
		crm: {
			module: 'crm',
			snippets,
			pages: { deals: { route: '/deals', components } }
		}
	}
});

const SLOTS = { Table: { cell: ['row', 'column', 'value'], empty: [] } };

describe('checkSnippetBindings (U-07)', () => {
	test('declared snippet with a matching slot signature passes', () => {
		const specs = snippetSpecs(
			[{ table: 'crm.Query.listDeals', cell: 'crm.Snippet.statusCell' }],
			{ statusCell: { args: ['row', 'column', 'value'] } }
		);
		expect(checkSnippetBindings(specs, SLOTS)).toEqual([]);
	});

	test('undeclared Snippet unit is refused even without slot metadata', () => {
		const specs = snippetSpecs([{ table: 'crm.Query.listDeals', cell: 'crm.Snippet.nope' }]);
		const [r] = checkSnippetBindings(specs);
		expect(r.code).toBe('INVALID_BINDING');
		expect(r.path).toBe('crm.Page.deals.components[0].cell');
		expect(r.message).toContain('no Snippet declared at crm.Snippet.nope');
		expect(r.fix).toContain('src/crm/snippets/nope.n');
	});

	test('slot signature mismatch is refused with both signatures spelled out', () => {
		const specs = snippetSpecs(
			[{ table: 'crm.Query.listDeals', cell: 'crm.Snippet.statusCell' }],
			{ statusCell: { args: ['deal'] } }
		);
		const [r] = checkSnippetBindings(specs, SLOTS);
		expect(r.message).toContain('passes (row, column, value)');
		expect(r.message).toContain('declares args (deal)');
	});

	test('without slot metadata only existence is checked', () => {
		const specs = snippetSpecs(
			[{ table: 'crm.Query.listDeals', cell: 'crm.Snippet.statusCell' }],
			{ statusCell: { args: ['deal'] } }
		);
		expect(checkSnippetBindings(specs)).toEqual([]);
	});

	test('checkGenerate wires snippetSlots through', () => {
		const specs = snippetSpecs(
			[{ table: 'crm.Query.listDeals', cell: 'crm.Snippet.statusCell' }],
			{ statusCell: { args: ['deal'] } }
		);
		const refusals = checkGenerate(specs, { snippetSlots: SLOTS });
		expect(refusals.some((r) => r.code === 'INVALID_BINDING')).toBe(true);
	});
});

describe('page emitter snippet wrappers (U-07)', () => {
	test('binds the slot prop and wraps the custom body in +snippet', () => {
		const specs = snippetSpecs(
			[{ table: 'crm.Query.listDeals', cell: 'crm.Snippet.statusCell' }],
			{ statusCell: { args: ['row', 'column', 'value'] } }
		);
		const tpl = emitModulePages('crm', specs.modules.crm, specs).find((f) =>
			f.path.endsWith('+page.n')
		);
		expect(tpl.text).toContain('cell!="{statusCell}"');
		expect(tpl.text).toContain("+snippet('statusCell', row, column, value)");
		expect(tpl.text).toContain('StatusCell(row!="{row}" column!="{column}" value!="{value}")');
		expect(tpl.text).toContain("import StatusCell from '$custom/crm/snippets/statusCell.n'");
	});

	test('argless snippet gets a bare wrapper', () => {
		const specs = snippetSpecs(
			[{ table: 'crm.Query.listDeals', empty: 'crm.Snippet.noDeals' }],
			{ noDeals: {} }
		);
		const tpl = emitModulePages('crm', specs.modules.crm, specs).find((f) =>
			f.path.endsWith('+page.n')
		);
		expect(tpl.text).toContain('empty!="{noDeals}"');
		expect(tpl.text).toContain("+snippet('noDeals')");
		expect(tpl.text).toContain('NoDeals\n');
	});
});

describe('componentKey: tag survives TRON key sorting', () => {
	test('sorted { cell, table } entry still emits <Table> with the cell slot bound', () => {
		const specs = snippetSpecs(
			[{ cell: 'crm.Snippet.statusCell', table: 'crm.Query.listDeals' }],
			{ statusCell: { args: ['row', 'column', 'value'] } }
		);
		const tpl = emitModulePages('crm', specs.modules.crm, specs).find((f) =>
			f.path.endsWith('+page.n')
		);
		expect(tpl.text).toContain('\tTable(');
		expect(tpl.text).not.toContain('\tCell(');
		expect(tpl.text).toContain('cell!="{statusCell}"');
		expect(tpl.text).toContain('data!="{data.listDeals}"');
	});

	test('checkSnippetBindings resolves the slot owner from the semantic primary', () => {
		const specs = snippetSpecs(
			[{ cell: 'crm.Snippet.statusCell', table: 'crm.Query.listDeals' }],
			{ statusCell: { args: ['deal'] } }
		);
		const [r] = checkSnippetBindings(specs, SLOTS);
		expect(r.message).toContain('`cell` slot passes (row, column, value)');
		expect(r.message).toContain('<Table>');
	});

	test('checkLiveBindings finds an object binding behind an earlier literal key', () => {
		const refusals = checkLiveBindings(
			liveSpecs([{ autoplay: true, streamText: { stream: 'games.Endpoint.nope' } }])
		);
		expect(refusals).toHaveLength(1);
		expect(refusals[0].path).toBe('games.Page.play.components[0].streamText.stream');
	});
});
