import { type Document, type DocumentFragment, Element, Node } from "./core";

interface AttributeTest {
	name: string;
	operator: string | undefined;
	value: string;
	ignoreCase: boolean;
}

type NthTest =
	| { kind: "odd" | "even" | "invalid" }
	| { kind: "index"; index: number }
	| { kind: "formula"; coefficient: number; offset: number };

interface PseudoTest {
	name: string;
	/** Compiled argument for `:not`, `:is`, `:where`. */
	list: SelectorList | null;
	nth: NthTest | null;
}

interface CompoundSelector {
	/** Lower-cased tag name, or null for any element. */
	tag: string | null;
	ids: string[];
	classes: string[];
	attributes: AttributeTest[];
	pseudos: PseudoTest[];
	/** Malformed or unsupported compounds never match. */
	invalid: boolean;
	/** Whether only `tag` (or nothing) constrains the compound. */
	bare: boolean;
}

interface ComplexSelector {
	compounds: CompoundSelector[];
	combinators: string[];
}

interface SelectorList {
	/** A bare `*` part matches every element. */
	universal: boolean;
	/** Bare tag parts, matched by `localName`. */
	tags: Set<string> | null;
	complexes: ComplexSelector[];
}

const SUPPORTED_PSEUDOS: Record<string, true> = {
	not: true,
	is: true,
	where: true,
	"first-child": true,
	"last-child": true,
	"only-child": true,
	empty: true,
	root: true,
	"nth-child": true,
	"first-of-type": true,
	"last-of-type": true,
};
const ATTRIBUTE_PATTERN =
	/^\s*([^\s~|^$*!=]+)\s*(?:(\^=|\$=|\*=|~=|\|=|=)\s*(?:(["'])(.*?)\3|([^\s]+))\s*([isIS])?)?\s*$/;
const IDENTIFIER_CHARACTER = /[a-zA-Z0-9_-]/;
const MAX_CACHED_SELECTORS = 512;
const compiledSelectors = new Map<string, SelectorList>();

function splitTopLevel(value: string, delimiter: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let brackets = 0;
	let parentheses = 0;
	let quote = "";
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (quote) {
			if (character === quote && value[index - 1] !== "\\") quote = "";
			continue;
		}
		if (character === '"' || character === "'") quote = character;
		else if (character === "[") brackets++;
		else if (character === "]") brackets--;
		else if (character === "(") parentheses++;
		else if (character === ")") parentheses--;
		else if (character === delimiter && brackets === 0 && parentheses === 0) {
			parts.push(value.slice(start, index).trim());
			start = index + 1;
		}
	}
	parts.push(value.slice(start).trim());
	return parts.filter(Boolean);
}

function splitComplex(selector: string): { simples: string[]; combinators: string[] } {
	const simples: string[] = [];
	const combinators: string[] = [];
	let current = "";
	let brackets = 0;
	let parentheses = 0;
	let quote = "";
	for (let index = 0; index < selector.length; index++) {
		const character = selector[index];
		if (quote) {
			current += character;
			if (character === quote && selector[index - 1] !== "\\") quote = "";
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			current += character;
			continue;
		}
		if (character === "[") brackets++;
		else if (character === "]") brackets--;
		else if (character === "(") parentheses++;
		else if (character === ")") parentheses--;
		if (brackets || parentheses) {
			current += character;
			continue;
		}
		if (character === ">" || character === "+" || character === "~") {
			if (current.trim()) simples.push(current.trim());
			current = "";
			combinators.push(character);
			while (/\s/.test(selector[index + 1] ?? "")) index++;
			continue;
		}
		if (/\s/.test(character)) {
			while (/\s/.test(selector[index + 1] ?? "")) index++;
			const next = selector[index + 1];
			if (current.trim()) {
				simples.push(current.trim());
				current = "";
				if (next !== ">" && next !== "+" && next !== "~" && next !== undefined) combinators.push(" ");
			}
			continue;
		}
		current += character;
	}
	if (current.trim()) simples.push(current.trim());
	while (combinators.length >= simples.length) combinators.pop();
	return { simples, combinators };
}

function readIdentifier(source: string, start: number): { value: string; end: number } {
	let value = "";
	let index = start;
	while (index < source.length) {
		const character = source[index];
		if (character === "\\" && index + 1 < source.length) {
			value += source[index + 1];
			index += 2;
			continue;
		}
		if (!IDENTIFIER_CHARACTER.test(character)) break;
		value += character;
		index++;
	}
	return { value, end: index };
}

function findClosing(source: string, start: number, opener: string, closer: string): number {
	let depth = 1;
	let quote = "";
	for (let index = start + 1; index < source.length; index++) {
		const character = source[index];
		if (quote) {
			if (character === quote && source[index - 1] !== "\\") quote = "";
		} else if (character === '"' || character === "'") quote = character;
		else if (character === opener) depth++;
		else if (character === closer && --depth === 0) return index;
	}
	return source.length - 1;
}

function compileAttribute(expression: string): AttributeTest | null {
	const match = ATTRIBUTE_PATTERN.exec(expression);
	if (!match) return null;
	const [, name, operator, , quotedValue, bareValue, flag] = match;
	const ignoreCase = flag?.toLowerCase() === "i";
	const value = (quotedValue ?? bareValue ?? "").replace(/\\(.)/g, "$1");
	return { name, operator, value: ignoreCase ? value.toLowerCase() : value, ignoreCase };
}

function compileNth(expression: string): NthTest {
	const normalized = expression.trim().toLowerCase().replace(/\s+/g, "");
	if (normalized === "odd" || normalized === "even") return { kind: normalized };
	if (/^[+-]?\d+$/.test(normalized)) return { kind: "index", index: Number(normalized) };
	const match = /^([+-]?\d*)n([+-]\d+)?$/.exec(normalized);
	if (!match) return { kind: "invalid" };
	const coefficient = match[1] === "" || match[1] === "+" ? 1 : match[1] === "-" ? -1 : Number(match[1]);
	return { kind: "formula", coefficient, offset: Number(match[2] ?? 0) };
}

function compilePseudo(name: string, argument: string | undefined): PseudoTest | null {
	if (!SUPPORTED_PSEUDOS[name]) return null;
	if (name === "not" || name === "is" || name === "where") {
		return argument === undefined ? null : { name, list: compileSelector(argument), nth: null };
	}
	if (name === "nth-child") return argument === undefined ? null : { name, list: null, nth: compileNth(argument) };
	return { name, list: null, nth: null };
}

function compileCompound(selector: string): CompoundSelector {
	const compound: CompoundSelector = {
		tag: null,
		ids: [],
		classes: [],
		attributes: [],
		pseudos: [],
		invalid: false,
		bare: false,
	};
	let index = 0;
	if (selector[index] === "*") index++;
	else if (/[a-zA-Z_]/.test(selector[index] ?? "")) {
		const tag = readIdentifier(selector, index);
		compound.tag = tag.value.toLowerCase();
		index = tag.end;
	}
	while (index < selector.length) {
		const marker = selector[index];
		if (marker === "#" || marker === ".") {
			const identifier = readIdentifier(selector, index + 1);
			if (!identifier.value) {
				compound.invalid = true;
				break;
			}
			(marker === "#" ? compound.ids : compound.classes).push(identifier.value);
			index = identifier.end;
			continue;
		}
		if (marker === "[") {
			const end = findClosing(selector, index, "[", "]");
			const attribute = compileAttribute(selector.slice(index + 1, end));
			if (!attribute) {
				compound.invalid = true;
				break;
			}
			compound.attributes.push(attribute);
			index = end + 1;
			continue;
		}
		if (marker === ":") {
			const identifier = readIdentifier(selector, index + 1);
			let argument: string | undefined;
			index = identifier.end;
			if (selector[index] === "(") {
				const end = findClosing(selector, index, "(", ")");
				argument = selector.slice(index + 1, end);
				index = end + 1;
			}
			const pseudo = compilePseudo(identifier.value.toLowerCase(), argument);
			if (!pseudo) {
				compound.invalid = true;
				break;
			}
			compound.pseudos.push(pseudo);
			continue;
		}
		compound.invalid = true;
		break;
	}
	compound.bare =
		!compound.invalid &&
		compound.ids.length === 0 &&
		compound.classes.length === 0 &&
		compound.attributes.length === 0 &&
		compound.pseudos.length === 0;
	return compound;
}

function compileSelector(selector: string): SelectorList {
	const cached = compiledSelectors.get(selector);
	if (cached) return cached;
	const list: SelectorList = { universal: false, tags: null, complexes: [] };
	for (const part of splitTopLevel(selector, ",")) {
		const { simples, combinators } = splitComplex(part);
		if (!simples.length) continue;
		const compounds = simples.map(compileCompound);
		const only = compounds[0];
		if (compounds.length === 1 && only.bare) {
			if (only.tag === null) list.universal = true;
			else (list.tags ??= new Set()).add(only.tag);
			continue;
		}
		list.complexes.push({ compounds, combinators });
	}
	if (compiledSelectors.size >= MAX_CACHED_SELECTORS) compiledSelectors.clear();
	compiledSelectors.set(selector, list);
	return list;
}

function isWhitespace(code: number): boolean {
	return (
		code === 0x20 ||
		(code >= 0x09 && code <= 0x0d) ||
		code === 0xa0 ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff
	);
}

/** Whether a whitespace-separated class string contains a token, without splitting it. */
export function hasClassToken(className: string, token: string): boolean {
	if (!token) return false;
	for (let index = 0; index < token.length; index++) if (isWhitespace(token.charCodeAt(index))) return false;
	let from = 0;
	while (true) {
		const found = className.indexOf(token, from);
		if (found < 0) return false;
		const end = found + token.length;
		if (
			(found === 0 || isWhitespace(className.charCodeAt(found - 1))) &&
			(end === className.length || isWhitespace(className.charCodeAt(end)))
		) {
			return true;
		}
		from = found + 1;
	}
}

function matchAttribute(element: Element, test: AttributeTest): boolean {
	const actual = element.getAttribute(test.name);
	if (!test.operator) return actual !== null;
	if (actual === null) return false;
	const left = test.ignoreCase ? actual.toLowerCase() : actual;
	const right = test.value;
	switch (test.operator) {
		case "=":
			return left === right;
		case "^=":
			return left.startsWith(right);
		case "$=":
			return left.endsWith(right);
		case "*=":
			return left.includes(right);
		case "~=":
			return left.split(/\s+/).includes(right);
		case "|=":
			return left === right || left.startsWith(`${right}-`);
		default:
			return false;
	}
}

/** One-based position among element siblings, or 0 without a parent element. */
function elementIndex(element: Element): number {
	const parent = element.parentElement;
	if (!parent) return 0;
	let index = 0;
	for (const sibling of parent.childNodes) {
		if (!(sibling instanceof Element)) continue;
		index++;
		if (sibling === element) return index;
	}
	return 0;
}

function matchNth(element: Element, test: NthTest): boolean {
	if (test.kind === "invalid") return false;
	const index = elementIndex(element);
	switch (test.kind) {
		case "odd":
			return index % 2 === 1;
		case "even":
			return index % 2 === 0;
		case "index":
			return index === test.index;
		case "formula":
			return test.coefficient === 0
				? index === test.offset
				: (index - test.offset) / test.coefficient >= 0 &&
						Number.isInteger((index - test.offset) / test.coefficient);
	}
}

function hasSingleElementChild(parent: Element): boolean {
	let count = 0;
	for (const child of parent.childNodes) if (child instanceof Element && ++count > 1) return false;
	return count === 1;
}

function matchPseudo(element: Element, pseudo: PseudoTest): boolean {
	switch (pseudo.name) {
		case "not":
			return !matchesList(element, pseudo.list as SelectorList);
		case "is":
		case "where":
			return matchesList(element, pseudo.list as SelectorList);
		case "first-child":
			return element.parentElement?.firstElementChild === element;
		case "last-child":
			return element.parentElement?.lastElementChild === element;
		case "only-child": {
			const parent = element.parentElement;
			return parent !== null && hasSingleElementChild(parent);
		}
		case "empty":
			return (
				!element.hasChildNodes() ||
				element.childNodes.every(child => child.nodeType === Node.COMMENT_NODE || child.textContent === "")
			);
		case "root":
			return element.ownerDocument?.documentElement === element;
		case "nth-child":
			return matchNth(element, pseudo.nth as NthTest);
		case "first-of-type": {
			for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
				if (sibling.tagName === element.tagName) return false;
			}
			return true;
		}
		case "last-of-type": {
			for (let sibling = element.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
				if (sibling.tagName === element.tagName) return false;
			}
			return true;
		}
		default:
			return false;
	}
}

function matchCompound(element: Element, compound: CompoundSelector): boolean {
	if (compound.invalid) return false;
	if (compound.tag !== null && element.localName !== compound.tag) return false;
	if (compound.bare) return true;
	for (const id of compound.ids) if (element.id !== id) return false;
	if (compound.classes.length) {
		const className = element.className;
		for (const token of compound.classes) if (!hasClassToken(className, token)) return false;
	}
	for (const attribute of compound.attributes) if (!matchAttribute(element, attribute)) return false;
	for (const pseudo of compound.pseudos) if (!matchPseudo(element, pseudo)) return false;
	return true;
}

function matchComplexAt(element: Element, complex: ComplexSelector, index: number): boolean {
	if (!matchCompound(element, complex.compounds[index])) return false;
	if (index === 0) return true;
	const combinator = complex.combinators[index - 1] ?? " ";
	if (combinator === ">")
		return element.parentElement !== null && matchComplexAt(element.parentElement, complex, index - 1);
	if (combinator === "+") {
		const previous = element.previousElementSibling;
		return previous !== null && matchComplexAt(previous, complex, index - 1);
	}
	if (combinator === "~") {
		for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
			if (matchComplexAt(sibling, complex, index - 1)) return true;
		}
		return false;
	}
	for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
		if (matchComplexAt(ancestor, complex, index - 1)) return true;
	}
	return false;
}

function matchesList(element: Element, list: SelectorList): boolean {
	if (list.universal) return true;
	if (list.tags?.has(element.localName)) return true;
	for (const complex of list.complexes) {
		if (matchComplexAt(element, complex, complex.compounds.length - 1)) return true;
	}
	return false;
}

function collectMatches(nodes: Node[], list: SelectorList, result: Element[]): void {
	for (let index = 0; index < nodes.length; index++) {
		const node = nodes[index];
		if (node instanceof Element && matchesList(node, list)) result.push(node);
		if (node.hasChildNodes()) collectMatches(node.childNodes, list, result);
	}
}

function findMatch(nodes: Node[], list: SelectorList): Element | null {
	for (let index = 0; index < nodes.length; index++) {
		const node = nodes[index];
		if (node instanceof Element && matchesList(node, list)) return node;
		if (node.hasChildNodes()) {
			const found = findMatch(node.childNodes, list);
			if (found) return found;
		}
	}
	return null;
}

/** Whether an element matches a CSS selector list. */
export function matchesSelector(element: Element, selector: string): boolean {
	return matchesList(element, compileSelector(selector));
}

/** Nearest inclusive ancestor of an element matching a CSS selector list. */
export function closestMatching(element: Element, selector: string): Element | null {
	const list = compileSelector(selector);
	for (let current: Element | null = element; current; current = current.parentElement) {
		if (matchesList(current, list)) return current;
	}
	return null;
}

/** Query descendants of a node in document order. */
export function querySelectorAllFrom(
	root: Document | DocumentFragment | Element,
	selector: string,
	_includeRoot: boolean,
): Element[] {
	const result: Element[] = [];
	if (root.hasChildNodes()) collectMatches(root.childNodes, compileSelector(selector), result);
	return result;
}

/** First descendant of a node in document order matching a selector, stopping at the first match. */
export function querySelectorFrom(root: Document | DocumentFragment | Element, selector: string): Element | null {
	return root.hasChildNodes() ? findMatch(root.childNodes, compileSelector(selector)) : null;
}
