// One-shot authoring script for the D-01 sample CRM (norns-demo/crm/specs).
// Kept in-repo so the specs can be regenerated canonically if the format evolves.
import { join } from 'node:path';

import { writeSpec } from '@human-synthesis/norns-tron/spec';

const out = process.argv[2];
if (!out) {
	console.error('usage: bun scripts/write-crm-specs.mjs <specs-dir>');
	process.exit(1);
}

const APP = { name: 'crm', dialect: 'd1', modules: ['companies', 'contacts', 'deals', 'activities'] };

const COMPANIES = {
	module: 'companies',
	depends: ['core'],
	entities: {
		Company: {
			owner: 'owner',
			fields: {
				owner: { type: 'ref', ref: 'core.Entity.User' },
				name: { type: 'text' },
				domain: { type: 'url', optional: true },
				industry: { type: 'text', optional: true }
			}
		},
		Tag: {
			fields: { label: { type: 'text', unique: true } }
		}
	},
	queries: {
		all: { from: 'Company', sort: 'name', limit: 100 },
		tags: { from: 'Tag', sort: 'label', limit: 200 }
	},
	policies: {
		Company: { read: 'owner or role:admin', write: 'owner' },
		Tag: { read: 'role:member or role:admin', write: 'role:admin' }
	},
	pages: {
		index: { route: '/companies', components: [{ table: 'companies.Query.all' }] }
	}
};

const CONTACTS = {
	module: 'contacts',
	depends: ['core', 'companies'],
	entities: {
		Contact: {
			owner: 'owner',
			fields: {
				owner: { type: 'ref', ref: 'core.Entity.User' },
				name: { type: 'text' },
				email: { type: 'email' },
				phone: { type: 'text', optional: true },
				company: { type: 'ref', ref: 'companies.Entity.Company', optional: true }
			}
		},
		Note: {
			owner: 'author',
			fields: {
				author: { type: 'ref', ref: 'core.Entity.User' },
				contact: { type: 'ref', ref: 'Contact' },
				body: { type: 'text' }
			}
		}
	},
	queries: {
		all: { from: 'Contact', sort: 'name', limit: 100 },
		notes: { from: 'Note', limit: 200 }
	},
	policies: {
		Contact: { read: 'owner or role:admin', write: 'owner' },
		Note: { read: 'owner or role:admin', write: 'owner' }
	},
	pages: {
		index: { route: '/contacts', components: [{ table: 'contacts.Query.all' }] }
	}
};

const DEALS = {
	module: 'deals',
	depends: ['core', 'companies', 'contacts'],
	entities: {
		Deal: {
			owner: 'owner',
			fields: {
				owner: { type: 'ref', ref: 'core.Entity.User' },
				title: { type: 'text' },
				amount: { type: 'money' },
				company: { type: 'ref', ref: 'companies.Entity.Company' },
				contact: { type: 'ref', ref: 'contacts.Entity.Contact', optional: true },
				closeDate: { type: 'date', optional: true }
			},
			status: { open: ['won', 'lost'], won: [], lost: [] }
		},
		Lead: {
			owner: 'owner',
			fields: {
				owner: { type: 'ref', ref: 'core.Entity.User' },
				name: { type: 'text' },
				email: { type: 'email' },
				source: { type: 'text', optional: true }
			},
			status: { new: ['qualified', 'discarded'], qualified: [], discarded: [] }
		}
	},
	queries: {
		pipeline: { from: 'Deal', live: true, groupBy: 'status' },
		inbox: { from: 'Lead', sort: 'name', limit: 100 }
	},
	actions: {
		win: {
			input: { id: 'Deal.id' },
			requires: 'status == open',
			steps: [{ set: { entity: 'Deal', status: 'won' } }, { emit: 'deal.won' }],
			refresh: ['deals.Query.pipeline'],
			examples: [{ input: { id: '$open' }, expect: { status: 'won' } }]
		},
		lose: {
			input: { id: 'Deal.id' },
			requires: 'status == open',
			steps: [{ set: { entity: 'Deal', status: 'lost' } }],
			refresh: ['deals.Query.pipeline'],
			examples: [{ input: { id: '$open' }, expect: { status: 'lost' } }]
		},
		reprice: {
			input: { id: 'Deal.id', amount: 'Deal.amount' },
			impl: 'custom',
			examples: [{ input: { id: '$open', amount: 1000 }, expect: { amount: 900 } }]
		},
		qualify: {
			input: { id: 'Lead.id' },
			requires: 'status == new',
			steps: [{ set: { entity: 'Lead', status: 'qualified' } }, { emit: 'lead.qualified' }],
			refresh: ['deals.Query.inbox'],
			examples: [{ input: { id: '$new' }, expect: { status: 'qualified' } }]
		}
	},
	policies: {
		Deal: { read: 'owner or role:admin', write: 'owner' },
		Lead: { read: 'owner or role:admin', write: 'owner' }
	},
	pages: {
		pipeline: {
			route: '/deals',
			state: { selected: 'Deal.id?' },
			components: [{ kanban: 'deals.Query.pipeline', onMove: 'deals.Action.win' }]
		},
		leads: { route: '/leads', components: [{ table: 'deals.Query.inbox' }] }
	}
};

const ACTIVITIES = {
	module: 'activities',
	depends: ['core', 'contacts', 'deals'],
	entities: {
		Activity: {
			owner: 'owner',
			fields: {
				owner: { type: 'ref', ref: 'core.Entity.User' },
				kind: { type: 'text' },
				subject: { type: 'text' },
				due: { type: 'datetime', optional: true },
				contact: { type: 'ref', ref: 'contacts.Entity.Contact' },
				deal: { type: 'ref', ref: 'deals.Entity.Deal', optional: true }
			},
			status: { planned: ['done', 'cancelled'], done: [], cancelled: [] }
		},
		Task: {
			owner: 'owner',
			fields: {
				owner: { type: 'ref', ref: 'core.Entity.User' },
				title: { type: 'text' },
				due: { type: 'date', optional: true },
				done: { type: 'bool', default: false }
			}
		}
	},
	queries: {
		agenda: { from: 'Activity', live: true, groupBy: 'status' },
		tasks: { from: 'Task', sort: 'due', limit: 100 }
	},
	actions: {
		complete: {
			input: { id: 'Activity.id' },
			requires: 'status == planned',
			steps: [{ set: { entity: 'Activity', status: 'done' } }, { emit: 'activity.completed' }],
			refresh: ['activities.Query.agenda'],
			examples: [{ input: { id: '$planned' }, expect: { status: 'done' } }]
		},
		cancel: {
			input: { id: 'Activity.id' },
			requires: 'status == planned',
			steps: [{ set: { entity: 'Activity', status: 'cancelled' } }],
			refresh: ['activities.Query.agenda'],
			examples: [{ input: { id: '$planned' }, expect: { status: 'cancelled' } }]
		},
		detachContact: { input: { id: 'Activity.id' } }
	},
	policies: {
		Activity: { read: 'owner or role:admin', write: 'owner' },
		Task: { read: 'owner or role:admin', write: 'owner' }
	},
	pages: {
		agenda: {
			route: '/activities',
			state: { selected: 'Activity.id?' },
			components: [{ kanban: 'activities.Query.agenda', onMove: 'activities.Action.complete' }]
		},
		tasks: { route: '/tasks', components: [{ table: 'activities.Query.tasks' }] }
	},
	triggers: { 'contacts.Contact.deleted': 'activities.Action.detachContact' }
};

writeSpec(join(out, 'app.t'), APP);
writeSpec(join(out, 'companies.t'), COMPANIES);
writeSpec(join(out, 'contacts.t'), CONTACTS);
writeSpec(join(out, 'deals.t'), DEALS);
writeSpec(join(out, 'activities.t'), ACTIVITIES);
console.log(`wrote 5 spec files to ${out}`);
