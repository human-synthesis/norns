/**
 * CEL-style expression subset (PLAN §4.8) — used by Action `requires`,
 * Query filters and Policy rules. One parser everywhere: the text form is
 * what humans and agents write; the JSON AST is what gets stored and
 * compiled (to Civet guards and Drizzle `where` clauses).
 *
 * Grammar:
 *   expr    := or
 *   or      := and ( "or" and )*
 *   and     := not ( "and" not )*
 *   not     := [ "not" ] cmp
 *   cmp     := operand [ ( "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" ) operand ]
 *   operand := literal | list | path | "owner" | "role:" ident | "(" expr ")"
 *   path    := ident ( "." ident )*
 *   literal := number | string | true | false | null
 *   list    := "[" [ literal ( "," literal )* ] "]"
 *
 * AST nodes:
 *   { op: 'or'|'and', args: [node, node, ...] }     n-ary, flattened
 *   { op: 'not', args: [node] }
 *   { op: '=='|'!='|'<'|'<='|'>'|'>='|'in', args: [node, node] }
 *   { lit: number|string|boolean|null|literal[] }
 *   { path: [segment, ...] }
 *   { owner: true }
 *   { role: name }
 *
 * No side effects, no user-defined functions, no loops.
 */

export const CMP_OPS = ['==', '!=', '<=', '>=', '<', '>', 'in'];

const KEYWORDS = new Set(['or', 'and', 'not', 'in', 'true', 'false', 'null', 'owner', 'role']);
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const NUMBER_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/;

class ExprError extends Error {
	constructor(message, pos, text) {
		super(`${message} at position ${pos} in ${JSON.stringify(text)}`);
		this.name = 'ExprError';
		this.pos = pos;
	}
}

function tokenize(text) {
	const tokens = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
			i++;
			continue;
		}
		if ('()[],.:'.includes(ch)) {
			tokens.push({ type: ch, pos: i });
			i++;
			continue;
		}
		if (ch === '=' || ch === '!' || ch === '<' || ch === '>') {
			const two = text.slice(i, i + 2);
			if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
				tokens.push({ type: 'cmp', value: two, pos: i });
				i += 2;
				continue;
			}
			if (ch === '<' || ch === '>') {
				tokens.push({ type: 'cmp', value: ch, pos: i });
				i++;
				continue;
			}
			throw new ExprError(`unexpected "${ch}"`, i, text);
		}
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') {
				j += text[j] === '\\' ? 2 : 1;
			}
			if (j >= text.length) throw new ExprError('unterminated string', i, text);
			let value;
			try {
				value = JSON.parse(text.slice(i, j + 1));
			} catch {
				throw new ExprError('invalid string escape', i, text);
			}
			tokens.push({ type: 'string', value, pos: i });
			i = j + 1;
			continue;
		}
		const num = NUMBER_RE.exec(text.slice(i));
		if (num && (ch !== '-' || /\d/.test(text[i + 1] ?? ''))) {
			tokens.push({ type: 'number', value: Number(num[0]), pos: i });
			i += num[0].length;
			continue;
		}
		const ident = IDENT_RE.exec(text.slice(i));
		if (ident) {
			const word = ident[0];
			tokens.push({ type: KEYWORDS.has(word) ? word : 'ident', value: word, pos: i });
			i += word.length;
			continue;
		}
		throw new ExprError(`unexpected "${ch}"`, i, text);
	}
	tokens.push({ type: 'eof', pos: text.length });
	return tokens;
}

/**
 * Parse an expression to its JSON AST.
 *
 * @param {string} text
 * @returns {*} AST node
 */
export function parseExpr(text) {
	const tokens = tokenize(text);
	let pos = 0;

	const peek = () => tokens[pos];
	const next = () => tokens[pos++];
	const expect = (type) => {
		const t = next();
		if (t.type !== type) throw new ExprError(`expected "${type}", got "${t.type}"`, t.pos, text);
		return t;
	};

	function parseOr() {
		const args = [parseAnd()];
		while (peek().type === 'or') {
			next();
			args.push(parseAnd());
		}
		return args.length === 1 ? args[0] : { op: 'or', args };
	}

	function parseAnd() {
		const args = [parseNot()];
		while (peek().type === 'and') {
			next();
			args.push(parseNot());
		}
		return args.length === 1 ? args[0] : { op: 'and', args };
	}

	function parseNot() {
		if (peek().type === 'not') {
			next();
			return { op: 'not', args: [parseCmp()] };
		}
		return parseCmp();
	}

	function parseCmp() {
		const left = parseOperand();
		const t = peek();
		if (t.type === 'cmp' || t.type === 'in') {
			next();
			const op = t.type === 'in' ? 'in' : t.value;
			return { op, args: [left, parseOperand()] };
		}
		return left;
	}

	function parseLiteral() {
		const t = next();
		if (t.type === 'number' || t.type === 'string') return { lit: t.value };
		if (t.type === 'true') return { lit: true };
		if (t.type === 'false') return { lit: false };
		if (t.type === 'null') return { lit: null };
		throw new ExprError(`expected literal, got "${t.type}"`, t.pos, text);
	}

	function parseOperand() {
		const t = peek();
		switch (t.type) {
			case '(': {
				next();
				const inner = parseOr();
				expect(')');
				return inner;
			}
			case '[': {
				next();
				const items = [];
				if (peek().type !== ']') {
					items.push(parseLiteral().lit);
					while (peek().type === ',') {
						next();
						items.push(parseLiteral().lit);
					}
				}
				expect(']');
				return { lit: items };
			}
			case 'owner':
				next();
				return { owner: true };
			case 'role': {
				next();
				expect(':');
				const name = next();
				if (name.type !== 'ident') {
					throw new ExprError('expected role name after "role:"', name.pos, text);
				}
				return { role: name.value };
			}
			case 'ident': {
				const segments = [next().value];
				while (peek().type === '.') {
					next();
					const seg = next();
					if (seg.type !== 'ident') {
						throw new ExprError('expected path segment after "."', seg.pos, text);
					}
					segments.push(seg.value);
				}
				return { path: segments };
			}
			case 'number':
			case 'string':
			case 'true':
			case 'false':
			case 'null':
				return parseLiteral();
			default:
				throw new ExprError(`unexpected "${t.type}"`, t.pos, text);
		}
	}

	const ast = parseOr();
	const end = peek();
	if (end.type !== 'eof') throw new ExprError(`unexpected trailing "${end.type}"`, end.pos, text);
	return ast;
}

// Precedence levels: 1 or · 2 and · 3 not · 4 cmp · 5 atom.
function levelOf(node) {
	if (node.op === 'or') return 1;
	if (node.op === 'and') return 2;
	if (node.op === 'not') return 3;
	if (CMP_OPS.includes(node.op)) return 4;
	return 5;
}

/**
 * Print an AST back to canonical text. `parseExpr(printExpr(ast))` is the
 * identity on canonical ASTs; parens are emitted only where the grammar
 * demands them.
 *
 * @param {*} node AST node
 * @returns {string}
 */
export function printExpr(node, min = 1) {
	const wrap = (text, level) => (level < min ? `(${text})` : text);
	if (node === null || typeof node !== 'object') {
		throw new Error(`invalid expression node: ${JSON.stringify(node)}`);
	}
	if ('lit' in node) {
		return Array.isArray(node.lit)
			? `[${node.lit.map((v) => JSON.stringify(v)).join(', ')}]`
			: JSON.stringify(node.lit);
	}
	if ('path' in node) return node.path.join('.');
	if (node.owner === true) return 'owner';
	if ('role' in node) return `role:${node.role}`;
	switch (node.op) {
		case 'or':
			return wrap(node.args.map((a) => printExpr(a, 2)).join(' or '), 1);
		case 'and':
			return wrap(node.args.map((a) => printExpr(a, 3)).join(' and '), 2);
		case 'not':
			return wrap(`not ${printExpr(node.args[0], 4)}`, 3);
		default:
			if (!CMP_OPS.includes(node.op)) {
				throw new Error(`invalid expression node: ${JSON.stringify(node)}`);
			}
			return wrap(
				`${printExpr(node.args[0], 5)} ${node.op} ${printExpr(node.args[1], 5)}`,
				4
			);
	}
}

/** True when `text` parses as a valid expression. */
export function isExpr(text) {
	try {
		parseExpr(text);
		return true;
	} catch {
		return false;
	}
}
