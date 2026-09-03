/** Shared golden fixture — the PLAN §5.2 orders example, completed so every
 * reference resolves (added open/cancelLineItems actions and the catalog
 * module; examples added to `price` since impl:custom requires them). */

export const UID = '01J8QF0000AAAAAAAAAAAAAAAA';

export const APP = { name: 'shop', dialect: 'd1', modules: ['orders', 'catalog'] };

export const CATALOG = {
	module: 'catalog',
	entities: {
		Product: { fields: { title: { type: 'text' } } }
	},
	policies: {
		Product: { read: 'role:admin', write: 'role:admin' }
	}
};

export const ORDERS = {
	module: 'orders',
	depends: ['core', 'catalog'],
	entities: {
		Order: {
			uid: UID,
			owner: 'customer',
			fields: {
				customer: { type: 'ref', ref: 'core.Entity.User' },
				total: { type: 'money' },
				note: { type: 'text', optional: true }
			},
			status: { draft: ['submitted'], submitted: ['paid', 'cancelled'], paid: [], cancelled: [] }
		}
	},
	queries: {
		board: { from: 'Order', live: true, groupBy: 'status' }
	},
	actions: {
		submit: {
			input: { id: 'Order.id' },
			requires: 'status == draft',
			steps: [{ set: { entity: 'Order', status: 'submitted' } }, { emit: 'order.submitted' }],
			refresh: ['orders.Query.board'],
			examples: [{ input: { id: '$draft' }, expect: { status: 'submitted' } }]
		},
		price: {
			input: { id: 'Order.id' },
			impl: 'custom',
			examples: [{ input: { id: '$draft' }, expect: { total: 100 } }]
		},
		open: { input: { id: 'Order.id' } },
		cancelLineItems: { input: { id: 'Order.id' } }
	},
	policies: {
		Order: { read: 'owner or role:admin', write: 'owner' }
	},
	pages: {
		board: {
			route: '/orders',
			// K-49: verbatim page-title override (would be humanized to "Board").
			title: 'Order Board',
			state: { selected: 'Order.id?' },
			components: [{ kanban: 'orders.Query.board', onMove: 'orders.Action.submit' }]
		}
	},
	components: {
		OrderTimeline: { props: { order: 'Order' }, events: { select: 'orders.Action.open' } }
	},
	triggers: { 'catalog.Product.deleted': 'orders.Action.cancelLineItems' }
};
