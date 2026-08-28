import { type Document, type DocumentFragment, Element, Node } from "./core";

interface ComplexSelector {
	simples: string[];
	combinators: string[];
}

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

function parseComplex(selector: string): ComplexSelector {
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
		if (!/[a-zA-Z0-9_-]/.test(character)) break;
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

function matchAttribute(element: Element, expression: string): boolean {
	const match = /^\s*([^\s~|^$*!=]+)\s*(?:(\^=|\$=|\*=|~=|\|=|=)\s*(?:(["'])(.*?)\3|([^\s]+))\s*([isIS])?)?\s*$/.exec(
		expression,
	);
	if (!match) return false;
	const [, name, operator, , quotedValue, bareValue, flag] = match;
	const actual = element.getAttribute(name);
	if (!operator) return actual !== null;
	if (actual === null) return false;
	let left = actual;
	let right = (quotedValue ?? bareValue ?? "").replace(/\\(.)/g, "$1");
	if (flag?.toLowerCase() === "i") {
		left = left.toLowerCase();
		right = right.toLowerCase();
	}
	switch (operator) {
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

function matchNth(element: Element, expression: string): boolean {
	const siblings = element.parentElement?.children ?? [];
	const index = siblings.indexOf(element) + 1;
	const normalized = expression.trim().toLowerCase().replace(/\s+/g, "");
	if (normalized === "odd") return index % 2 === 1;
	if (normalized === "even") return index % 2 === 0;
	if (/^[+-]?\d+$/.test(normalized)) return index === Number(normalized);
	const match = /^([+-]?\d*)n([+-]\d+)?$/.exec(normalized);
	if (!match) return false;
	const coefficient = match[1] === "" || match[1] === "+" ? 1 : match[1] === "-" ? -1 : Number(match[1]);
	const offset = Number(match[2] ?? 0);
	return coefficient === 0
		? index === offset
		: (index - offset) / coefficient >= 0 && Number.isInteger((index - offset) / coefficient);
}

function matchPseudo(element: Element, name: string, argument: string | undefined): boolean {
	switch (name) {
		case "not":
			return argument !== undefined && !matchesSelector(element, argument);
		case "is":
		case "where":
			return argument !== undefined && matchesSelector(element, argument);
		case "first-child":
			return element.parentElement?.firstElementChild === element;
		case "last-child":
			return element.parentElement?.lastElementChild === element;
		case "only-child":
			return element.parentElement?.children.length === 1;
		case "empty":
			return element.childNodes.every(child => child.nodeType === Node.COMMENT_NODE || child.textContent === "");
		case "root":
			return element.ownerDocument?.documentElement === element;
		case "nth-child":
			return argument !== undefined && matchNth(element, argument);
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

function matchSimple(element: Element, selector: string): boolean {
	let index = 0;
	if (selector[index] === "*") index++;
	else if (/[a-zA-Z_]/.test(selector[index] ?? "")) {
		const tag = readIdentifier(selector, index);
		if (element.localName !== tag.value.toLowerCase()) return false;
		index = tag.end;
	}
	while (index < selector.length) {
		const marker = selector[index];
		if (marker === "#" || marker === ".") {
			const identifier = readIdentifier(selector, index + 1);
			if (!identifier.value) return false;
			if (marker === "#" ? element.id !== identifier.value : !element.classList.contains(identifier.value))
				return false;
			index = identifier.end;
			continue;
		}
		if (marker === "[") {
			const end = findClosing(selector, index, "[", "]");
			if (!matchAttribute(element, selector.slice(index + 1, end))) return false;
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
			if (!matchPseudo(element, identifier.value.toLowerCase(), argument)) return false;
			continue;
		}
		return false;
	}
	return true;
}

function matchComplexAt(element: Element, complex: ComplexSelector, index: number): boolean {
	if (!matchSimple(element, complex.simples[index])) return false;
	if (index === 0) return true;
	const combinator = complex.combinators[index - 1] ?? " ";
	if (combinator === ">")
		return element.parentElement !== null && matchComplexAt(element.parentElement, complex, index - 1);
	if (combinator === "+")
		return (
			element.previousElementSibling !== null && matchComplexAt(element.previousElementSibling, complex, index - 1)
		);
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

/** Whether an element matches a CSS selector list. */
export function matchesSelector(element: Element, selector: string): boolean {
	for (const part of splitTopLevel(selector, ",")) {
		const complex = parseComplex(part);
		if (complex.simples.length && matchComplexAt(element, complex, complex.simples.length - 1)) return true;
	}
	return false;
}

/** Query descendants of a node in document order. */
export function querySelectorAllFrom(
	root: Document | DocumentFragment | Element,
	selector: string,
	includeRoot: boolean,
): Element[] {
	const result: Element[] = [];
	const visit = (node: Node): void => {
		if (node instanceof Element && matchesSelector(node, selector)) result.push(node);
		for (const child of node.childNodes) visit(child);
	};
	if (includeRoot) {
		for (const child of root.childNodes) visit(child);
	} else {
		for (const child of root.childNodes) visit(child);
	}
	return result;
}
