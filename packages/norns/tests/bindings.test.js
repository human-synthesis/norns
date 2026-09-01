import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { checkBindings, checkGenerate } from '../src/kernel/generate.js';
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
