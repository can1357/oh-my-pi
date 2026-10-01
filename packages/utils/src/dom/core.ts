/** Behavior-compatible reimplementation of linkedom's used surface. */

import { parseFragment } from "./parser";
import { matchesSelector, querySelectorAllFrom } from "./selector";

/** DOM node type constants. */
export const enum NodeType {
	ELEMENT = 1,
	ATTRIBUTE = 2,
	TEXT = 3,
	COMMENT = 8,
	DOCUMENT = 9,
	DOCUMENT_FRAGMENT = 11,
}

interface EventInit {
	bubbles?: boolean;
	cancelable?: boolean;
	composed?: boolean;
}

interface CustomEventInit<T> extends EventInit {
	detail?: T;
}

interface ElementCreationOptions {
	is?: string;
}

type FrameRequestCallback = (time: number) => void;

/** Minimal browser event implementation. */
export class Event {
	type: string;
	bubbles: boolean;
	cancelable: boolean;
	target: EventTarget | null = null;
	currentTarget: EventTarget | null = null;
	defaultPrevented = false;
	#stopped = false;

	constructor(type: string, init: EventInit = {}) {
		this.type = type;
		this.bubbles = init.bubbles ?? false;
		this.cancelable = init.cancelable ?? false;
	}

	/** Initialize an event created through Document.createEvent. */
	initEvent(type: string, bubbles = false, cancelable = false): void {
		this.type = type;
		this.bubbles = bubbles;
		this.cancelable = cancelable;
		this.defaultPrevented = false;
	}

	/** Cancel this event when it is cancelable. */
	preventDefault(): void {
		if (this.cancelable) this.defaultPrevented = true;
	}

	/** Stop bubbling this event. */
	stopPropagation(): void {
		this.#stopped = true;
	}

	/** Whether propagation has been stopped. */
	get propagationStopped(): boolean {
		return this.#stopped;
	}
}

/** Browser custom event carrying a detail value. */
export class CustomEvent<T = unknown> extends Event {
	readonly detail: T | undefined;

	constructor(type: string, init: CustomEventInit<T> = {}) {
		super(type, init);
		this.detail = init.detail;
	}
}

type EventListener = ((event: Event) => void) | { handleEvent(event: Event): void };

/** Minimal event-target implementation used by DOM nodes and window. */
export class EventTarget {
	#listeners = new Map<string, Set<EventListener>>();

	/** Register an event listener. */
	addEventListener(type: string, listener: EventListener | null): void {
		if (!listener) return;
		let listeners = this.#listeners.get(type);
		if (!listeners) {
			listeners = new Set();
			this.#listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	/** Remove an event listener. */
	removeEventListener(type: string, listener: EventListener | null): void {
		if (listener) this.#listeners.get(type)?.delete(listener);
	}

	/** Dispatch an event to listeners and optionally through node ancestors. */
	dispatchEvent(event: Event): boolean {
		if (!event.target) event.target = this;
		event.currentTarget = this;
		for (const listener of Array.from(this.#listeners.get(event.type) ?? [])) {
			if (typeof listener === "function") listener.call(this, event);
			else listener.handleEvent(event);
			if (event.propagationStopped) break;
		}
		if (event.bubbles && !event.propagationStopped && this instanceof Node && this.parentNode) {
			this.parentNode.dispatchEvent(event);
		}
		return !event.defaultPrevented;
	}
}

/** Base class for the implemented DOM tree. */
export class Node extends EventTarget {
	static readonly ELEMENT_NODE = NodeType.ELEMENT;
	static readonly ATTRIBUTE_NODE = NodeType.ATTRIBUTE;
	static readonly TEXT_NODE = NodeType.TEXT;
	static readonly COMMENT_NODE = NodeType.COMMENT;
	static readonly DOCUMENT_NODE = NodeType.DOCUMENT;
	static readonly DOCUMENT_FRAGMENT_NODE = NodeType.DOCUMENT_FRAGMENT;
	readonly nodeType: number;
	readonly nodeName: string;
	parentNode: Node | null = null;
	ownerDocument: Document | null;
	childNodes: Node[] = [];

	constructor(nodeType: number, nodeName: string, ownerDocument: Document | null = null) {
		super();
		this.nodeType = nodeType;
		this.nodeName = nodeName;
		this.ownerDocument = ownerDocument;
	}

	/** First child node, if present. */
	get firstChild(): Node | null {
		return this.childNodes[0] ?? null;
	}

	/** Last child node, if present. */
	get lastChild(): Node | null {
		return this.childNodes[this.childNodes.length - 1] ?? null;
	}

	/** Previous node with the same parent. */
	get previousSibling(): Node | null {
		if (!this.parentNode) return null;
		const index = this.parentNode.childNodes.indexOf(this);
		return index > 0 ? this.parentNode.childNodes[index - 1] : null;
	}

	/** Next node with the same parent. */
	get nextSibling(): Node | null {
		if (!this.parentNode) return null;
		const index = this.parentNode.childNodes.indexOf(this);
		return index >= 0 ? (this.parentNode.childNodes[index + 1] ?? null) : null;
	}

	/** Connectedness to a document. */
	get isConnected(): boolean {
		let node: Node | null = this;
		while (node?.parentNode) node = node.parentNode;
		return node?.nodeType === NodeType.DOCUMENT;
	}

	/** Node value for character-data nodes. */
	get nodeValue(): string | null {
		return null;
	}

	set nodeValue(_value: string | null) {}

	/** Text contained by this node. */
	get textContent(): string | null {
		return this.childNodes.map(child => child.textContent ?? "").join("");
	}

	set textContent(value: string | null) {
		this.replaceChildren();
		if (value) this.appendChild(this.documentForCreation().createTextNode(value));
	}

	/** Parent element, excluding document and fragments. */
	get parentElement(): Element | null {
		return this.parentNode instanceof Element ? this.parentNode : null;
	}

	/** Append a node, moving it from its old parent. */
	appendChild<T extends Node>(child: T): T {
		const node: Node = child;
		if (node === this || node.contains(this)) throw new Error("The new child is an ancestor of this node");
		if (child instanceof DocumentFragment) {
			for (const nested of Array.from(child.childNodes)) this.appendChild(nested);
			return child;
		}
		child.parentNode?.removeChild(child);
		child.parentNode = this;
		child.setOwnerDocument(this.documentForCreation());
		this.childNodes.push(child);
		return child;
	}

	/** Insert a node before a current child, or append for null. */
	insertBefore<T extends Node>(child: T, reference: Node | null): T {
		if (reference === null) return this.appendChild(child);
		const index = this.childNodes.indexOf(reference);
		if (index < 0) throw new Error("The reference node is not a child of this node");
		if (child instanceof DocumentFragment) {
			for (const nested of Array.from(child.childNodes)) this.insertBefore(nested, reference);
			return child;
		}
		child.parentNode?.removeChild(child);
		child.parentNode = this;
		child.setOwnerDocument(this.documentForCreation());
		this.childNodes.splice(index, 0, child);
		return child;
	}

	/** Replace a current child with another node. */
	replaceChild<T extends Node>(child: Node, previous: T): T {
		const index = this.childNodes.indexOf(previous);
		if (index < 0) throw new Error("The node to replace is not a child of this node");
		this.removeChild(previous);
		this.insertBefore(child, this.childNodes[index] ?? null);
		return previous;
	}

	/** Remove a current child. */
	removeChild<T extends Node>(child: T): T {
		const index = this.childNodes.indexOf(child);
		if (index < 0) throw new Error("The node to remove is not a child of this node");
		this.childNodes.splice(index, 1);
		child.parentNode = null;
		return child;
	}

	/** Replace all children with nodes or strings. */
	replaceChildren(...children: Array<Node | string>): void {
		for (const child of this.childNodes) child.parentNode = null;
		this.childNodes = [];
		this.append(...children);
	}

	/** Append nodes or strings. */
	append(...children: Array<Node | string>): void {
		for (const child of children) {
			this.appendChild(typeof child === "string" ? this.documentForCreation().createTextNode(child) : child);
		}
	}

	/** Prepend nodes or strings. */
	prepend(...children: Array<Node | string>): void {
		const reference = this.firstChild;
		for (const child of children) {
			this.insertBefore(
				typeof child === "string" ? this.documentForCreation().createTextNode(child) : child,
				reference,
			);
		}
	}

	/** Remove this node from its parent. */
	remove(): void {
		this.parentNode?.removeChild(this);
	}

	/** Replace this node in its parent. */
	replaceWith(...nodes: Array<Node | string>): void {
		const parent = this.parentNode;
		if (!parent) return;
		for (const node of nodes) {
			parent.insertBefore(typeof node === "string" ? this.documentForCreation().createTextNode(node) : node, this);
		}
		parent.removeChild(this);
	}

	/** Whether this node contains another node. */
	contains(other: Node | null): boolean {
		for (let node = other; node; node = node.parentNode) if (node === this) return true;
		return false;
	}

	/** Clone this node, optionally including descendants. */
	cloneNode(deep = false): Node {
		const clone = new Node(this.nodeType, this.nodeName, this.ownerDocument);
		if (deep) for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
		return clone;
	}

	/** Compare tree position sufficiently for document-order consumers. */
	compareDocumentPosition(other: Node): number {
		if (this === other) return 0;
		if (this.contains(other)) return 20;
		if (other.contains(this)) return 10;
		const root = this.ownerDocument ?? this;
		const nodes: Node[] = [];
		const visit = (node: Node): void => {
			nodes.push(node);
			for (const child of node.childNodes) visit(child);
		};
		visit(root);
		return nodes.indexOf(this) < nodes.indexOf(other) ? 4 : 2;
	}

	setOwnerDocument(document: Document): void {
		if (this.nodeType !== NodeType.DOCUMENT) this.ownerDocument = document;
		for (const child of this.childNodes) child.setOwnerDocument(document);
	}

	documentForCreation(): Document {
		if (this instanceof Document) return this;
		if (!this.ownerDocument) throw new Error("This node has no owner document");
		return this.ownerDocument;
	}
}

/** Text node. */
export class Text extends Node {
	data: string;
	serializeRaw: boolean;

	constructor(data: string, ownerDocument: Document | null = null, serializeRaw = false) {
		super(NodeType.TEXT, "#text", ownerDocument);
		this.data = data;
		this.serializeRaw = serializeRaw;
	}

	/** Number of UTF-16 code units. */
	get length(): number {
		return this.data.length;
	}

	override get nodeValue(): string {
		return this.data;
	}

	override set nodeValue(value: string | null) {
		this.data = value ?? "";
	}

	override get textContent(): string {
		return this.data;
	}

	override set textContent(value: string | null) {
		this.data = value ?? "";
	}

	/** Split this text node at an offset. */
	splitText(offset: number): Text {
		const tail = new Text(this.data.slice(offset), this.ownerDocument, this.serializeRaw);
		this.data = this.data.slice(0, offset);
		this.parentNode?.insertBefore(tail, this.nextSibling);
		return tail;
	}

	override cloneNode(): Text {
		return new Text(this.data, this.ownerDocument, this.serializeRaw);
	}
}

/** Comment node. */
export class Comment extends Text {
	constructor(data: string, ownerDocument: Document | null = null) {
		super(data, ownerDocument);
		Object.defineProperty(this, "nodeType", { value: NodeType.COMMENT });
		Object.defineProperty(this, "nodeName", { value: "#comment" });
	}

	override cloneNode(): Comment {
		return new Comment(this.data, this.ownerDocument);
	}
}

/** DOM attribute value object. */
export class Attr extends Node {
	readonly name: string;
	value: string;
	readonly namespaceURI: string | null;

	constructor(name: string, value: string, ownerDocument: Document | null = null, namespaceURI: string | null = null) {
		super(NodeType.ATTRIBUTE, name, ownerDocument);
		this.name = name;
		this.value = value;
		this.namespaceURI = namespaceURI;
	}

	override get nodeValue(): string {
		return this.value;
	}

	override set nodeValue(value: string | null) {
		this.value = value ?? "";
	}

	override get textContent(): string {
		return this.value;
	}

	override set textContent(value: string | null) {
		this.value = value ?? "";
	}

	override cloneNode(): Attr {
		return new Attr(this.name, this.value, this.ownerDocument, this.namespaceURI);
	}
}

/** Array-like attribute collection. */
export class NamedNodeMap extends Array<Attr> {
	/** Find an attribute case-insensitively. */
	getNamedItem(name: string): Attr | null {
		const normalized = name.toLowerCase();
		return this.find(attr => attr.name.toLowerCase() === normalized) ?? null;
	}

	/** Set an attribute object and return the prior one. */
	setNamedItem(attr: Attr): Attr | null {
		const previous = this.getNamedItem(attr.name);
		if (previous) this.splice(this.indexOf(previous), 1, attr);
		else this.push(attr);
		return previous;
	}

	/** Remove and return a named attribute. */
	removeNamedItem(name: string): Attr {
		const attr = this.getNamedItem(name);
		if (!attr) throw new Error(`Attribute not found: ${name}`);
		this.splice(this.indexOf(attr), 1);
		return attr;
	}
}

/** Token-list view over an element class attribute. */
export class DOMTokenList implements Iterable<string> {
	#element: Element;

	constructor(element: Element) {
		this.#element = element;
	}

	#tokens(): string[] {
		return this.#element.className.trim() ? this.#element.className.trim().split(/\s+/) : [];
	}

	#write(tokens: string[]): void {
		this.#element.className = [...new Set(tokens)].join(" ");
	}

	/** Token count. */
	get length(): number {
		return this.#tokens().length;
	}

	/** String representation. */
	get value(): string {
		return this.#element.className;
	}

	set value(value: string) {
		this.#element.className = value;
	}

	/** Add class tokens. */
	add(...tokens: string[]): void {
		this.#write([...this.#tokens(), ...tokens]);
	}

	/** Remove class tokens. */
	remove(...tokens: string[]): void {
		const removed = new Set(tokens);
		this.#write(this.#tokens().filter(token => !removed.has(token)));
	}

	/** Whether a class token exists. */
	contains(token: string): boolean {
		return this.#tokens().includes(token);
	}

	/** Toggle a class token. */
	toggle(token: string, force?: boolean): boolean {
		const present = this.contains(token);
		const enabled = force ?? !present;
		if (enabled && !present) this.add(token);
		else if (!enabled && present) this.remove(token);
		return enabled;
	}

	/** Replace one class token with another. */
	replace(previous: string, next: string): boolean {
		const tokens = this.#tokens();
		const index = tokens.indexOf(previous);
		if (index < 0) return false;
		tokens[index] = next;
		this.#write(tokens);
		return true;
	}

	/** Token at an index. */
	item(index: number): string | null {
		return this.#tokens()[index] ?? null;
	}

	[Symbol.iterator](): Iterator<string> {
		return this.#tokens()[Symbol.iterator]();
	}

	toString(): string {
		return this.value;
	}
}

/** Mutable inline style declaration. */
export class CSSStyleDeclaration {
	#values = new Map<string, string>();

	/** Serialized declarations. */
	get cssText(): string {
		return [...this.#values].map(([name, value]) => `${name}: ${value};`).join(" ");
	}

	set cssText(value: string) {
		this.#values.clear();
		for (const declaration of value.split(";")) {
			const colon = declaration.indexOf(":");
			if (colon > 0) this.setProperty(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
		}
	}

	/** Read a CSS property. */
	getPropertyValue(name: string): string {
		return this.#values.get(name) ?? "";
	}

	/** Set a CSS property. */
	setProperty(name: string, value: string | null, _priority?: string): void {
		if (value === null || value === "") this.#values.delete(name);
		else this.#values.set(name, String(value));
	}

	/** Remove and return a CSS property. */
	removeProperty(name: string): string {
		const value = this.getPropertyValue(name);
		this.#values.delete(name);
		return value;
	}
}

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** DOM element with attributes, selectors, and HTML serialization. */
export class Element extends Node {
	readonly localName: string;
	readonly tagName: string;
	readonly namespaceURI: string | null;
	readonly qualifiedName: string;
	readonly attributes = new NamedNodeMap();
	readonly classList: DOMTokenList;
	readonly style = new CSSStyleDeclaration();

	constructor(tagName: string, ownerDocument: Document | null = null, namespaceURI: string | null = HTML_NAMESPACE) {
		const localName = tagName.toLowerCase();
		const qualified = namespaceURI === HTML_NAMESPACE ? localName.toUpperCase() : tagName;
		super(NodeType.ELEMENT, qualified, ownerDocument);
		this.localName = localName;
		this.tagName = qualified;
		this.qualifiedName = tagName;
		this.namespaceURI = namespaceURI;
		this.classList = new DOMTokenList(this);
	}

	/** Element children. */
	get children(): Element[] {
		return this.childNodes.filter((child): child is Element => child instanceof Element);
	}

	/** First element child. */
	get firstElementChild(): Element | null {
		return this.children[0] ?? null;
	}

	/** Last element child. */
	get lastElementChild(): Element | null {
		const children = this.children;
		return children[children.length - 1] ?? null;
	}

	/** Previous sibling that is an element. */
	get previousElementSibling(): Element | null {
		for (let node = this.previousSibling; node; node = node.previousSibling) if (node instanceof Element) return node;
		return null;
	}

	/** Next sibling that is an element. */
	get nextElementSibling(): Element | null {
		for (let node = this.nextSibling; node; node = node.nextSibling) if (node instanceof Element) return node;
		return null;
	}

	/** Attribute-backed element id. */
	get id(): string {
		return this.getAttribute("id") ?? "";
	}

	set id(value: string) {
		this.setAttribute("id", value);
	}

	/** Attribute-backed class string. */
	get className(): string {
		return this.getAttribute("class") ?? "";
	}

	set className(value: string) {
		this.setAttribute("class", value);
	}

	/** Data attributes exposed as camel-cased properties. */
	get dataset(): Record<string, string> {
		const element = this;
		return new Proxy<Record<string, string>>(
			{},
			{
				get(_target, property) {
					if (typeof property !== "string") return undefined;
					return (
						element.getAttribute(`data-${property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`) ??
						undefined
					);
				},
				set(_target, property, value) {
					if (typeof property === "string") {
						element.setAttribute(
							`data-${property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`,
							String(value),
						);
					}
					return true;
				},
				ownKeys() {
					return element.attributes
						.filter(attr => attr.name.startsWith("data-"))
						.map(attr => attr.name.slice(5).replace(/-([a-z])/g, (_m, letter: string) => letter.toUpperCase()));
				},
				getOwnPropertyDescriptor() {
					return { configurable: true, enumerable: true };
				},
			},
		);
	}

	/** Linkedom-compatible legacy text property (only specialized elements define a value). */
	get text(): string | undefined {
		return undefined;
	}

	/** HTML contained inside this element. */
	get innerHTML(): string {
		return this.childNodes.map(serializeNode).join("");
	}

	set innerHTML(value: string) {
		this.replaceChildren();
		for (const child of parseFragment(value, this.documentForCreation(), this.localName).childNodes.slice())
			this.appendChild(child);
	}

	/** Serialized element and descendants. */
	get outerHTML(): string {
		return serializeNode(this);
	}

	set outerHTML(value: string) {
		const parent = this.parentNode;
		if (!parent) return;
		const fragment = parseFragment(value, this.documentForCreation(), this.parentElement?.localName);
		for (const child of Array.from(fragment.childNodes)) parent.insertBefore(child, this);
		parent.removeChild(this);
	}

	/** Read an attribute. */
	getAttribute(name: string): string | null {
		if (name.toLowerCase() === "style" && this.style.cssText) return this.style.cssText;
		return this.attributes.getNamedItem(name)?.value ?? null;
	}

	/** Read an attribute object. */
	getAttributeNode(name: string): Attr | null {
		return this.attributes.getNamedItem(name);
	}

	/** Whether an attribute exists. */
	hasAttribute(name: string): boolean {
		return (
			this.attributes.getNamedItem(name) !== null || (name.toLowerCase() === "style" && Boolean(this.style.cssText))
		);
	}

	/** Set an attribute. */
	setAttribute(name: string, value: string): void {
		const normalized = name.toLowerCase();
		if (normalized === "style") this.style.cssText = String(value);
		const existing = this.attributes.getNamedItem(normalized);
		if (existing) existing.value = String(value);
		else this.attributes.unshift(new Attr(name, String(value), this.ownerDocument));
	}

	/** Set a namespaced attribute. */
	setAttributeNS(_namespace: string | null, name: string, value: string): void {
		this.setAttribute(name, value);
	}

	/** Remove an attribute. */
	removeAttribute(name: string): void {
		const existing = this.attributes.getNamedItem(name);
		if (existing) this.attributes.splice(this.attributes.indexOf(existing), 1);
		if (name.toLowerCase() === "style") this.style.cssText = "";
	}

	/** Find the first descendant matching a selector. */
	querySelector(selector: string): Element | null {
		return querySelectorAllFrom(this, selector, false)[0] ?? null;
	}

	/** Find all descendants matching a selector. */
	querySelectorAll(selector: string): Element[] {
		return querySelectorAllFrom(this, selector, false);
	}

	/** Whether this element matches a selector. */
	matches(selector: string): boolean {
		return matchesSelector(this, selector);
	}

	/** Find the nearest matching ancestor including this element. */
	closest(selector: string): Element | null {
		for (let element: Element | null = this; element; element = element.parentElement) {
			if (element.matches(selector)) return element;
		}
		return null;
	}

	/** Descendant elements with a tag name. */
	getElementsByTagName(tagName: string): Element[] {
		return this.querySelectorAll(tagName === "*" ? "*" : tagName);
	}

	/** Descendant elements containing all requested class tokens. */
	getElementsByClassName(classNames: string): Element[] {
		const tokens = classNames.trim().split(/\s+/).filter(Boolean);
		return querySelectorAllFrom(this, "*", false).filter(element =>
			tokens.every(token => element.classList.contains(token)),
		);
	}

	/**
	 * Return a zero-sized rectangle because this parser DOM has no layout.
	 * Browser-side scripts only use this method's standard shape.
	 */
	getBoundingClientRect(): {
		x: number;
		y: number;
		bottom: number;
		height: number;
		left: number;
		right: number;
		top: number;
		width: number;
	} {
		return { x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 };
	}

	/** Focus this element in its owner document. */
	focus(): void {
		if (this.ownerDocument) this.ownerDocument.activeElement = this;
		this.dispatchEvent(new Event("focus"));
	}

	/** Clear focus from this element. */
	blur(): void {
		if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
		this.dispatchEvent(new Event("blur"));
	}

	/** Trigger a synthetic click event. */
	click(): void {
		this.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	}

	override cloneNode(deep = false): Element {
		const clone =
			this.ownerDocument?.createElementNS(this.namespaceURI, this.qualifiedName) ??
			new Element(this.qualifiedName, null, this.namespaceURI);
		for (let index = this.attributes.length - 1; index >= 0; index--) {
			const attr = this.attributes[index];
			clone.setAttribute(attr.name, attr.value);
		}
		if (deep) for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
		return clone;
	}
}

/** HTML element implementation. */
export class HTMLElement extends Element {
	value = "";
	checked = false;
	selected = false;
	disabled = false;
	multiple = false;
	defaultValue = "";
	defaultChecked = false;

	/** Reflected title attribute. */
	get title(): string {
		return this.getAttribute("title") ?? "";
	}

	set title(value: string) {
		this.setAttribute("title", value);
	}

	/** Reflected href attribute. */
	get href(): string {
		const value = this.getAttribute("href") ?? "";
		try {
			return new URL(value, this.ownerDocument?.URL || "about:blank").href;
		} catch {
			return value;
		}
	}

	set href(value: string) {
		this.setAttribute("href", value);
	}

	/** Reflected input type. */
	get type(): string {
		return this.getAttribute("type") ?? "";
	}

	set type(value: string) {
		this.setAttribute("type", value);
	}

	/** Reflected name. */
	get name(): string {
		return this.getAttribute("name") ?? "";
	}

	set name(value: string) {
		this.setAttribute("name", value);
	}
}

/** HTML meta element with a reflected content attribute. */
export class HTMLMetaElement extends HTMLElement {
	/** Reflected metadata content. */
	get content(): string {
		return this.getAttribute("content") ?? "";
	}

	set content(value: string) {
		this.setAttribute("content", value);
	}
}

/** SVG element marker used by React feature checks. */
export class SVGElement extends Element {}

/** Iframe element marker used by React selection restoration. */
export class HTMLIFrameElement extends HTMLElement {}

/** Document fragment. */
export class DocumentFragment extends Node {
	constructor(ownerDocument: Document | null = null) {
		super(NodeType.DOCUMENT_FRAGMENT, "#document-fragment", ownerDocument);
	}

	/** Element children. */
	get children(): Element[] {
		return this.childNodes.filter((child): child is Element => child instanceof Element);
	}

	/** First element child. */
	get firstElementChild(): Element | null {
		return this.children[0] ?? null;
	}

	/** Last element child. */
	get lastElementChild(): Element | null {
		const children = this.children;
		return children[children.length - 1] ?? null;
	}

	/** First matching descendant. */
	querySelector(selector: string): Element | null {
		return querySelectorAllFrom(this, selector, false)[0] ?? null;
	}

	/** All matching descendants. */
	querySelectorAll(selector: string): Element[] {
		return querySelectorAllFrom(this, selector, false);
	}

	override cloneNode(deep = false): DocumentFragment {
		const clone = new DocumentFragment(this.ownerDocument);
		if (deep) for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
		return clone;
	}
}

/** HTML template whose parsed descendants live in a document fragment. */
export class HTMLTemplateElement extends HTMLElement {
	readonly content: DocumentFragment;

	constructor(tagName: string, ownerDocument: Document | null = null, namespaceURI: string | null = HTML_NAMESPACE) {
		super(tagName, ownerDocument, namespaceURI);
		this.content = new DocumentFragment(ownerDocument);
	}

	override get innerHTML(): string {
		return this.content.childNodes.map(serializeNode).join("");
	}

	override set innerHTML(value: string) {
		this.content.replaceChildren();
		for (const child of parseFragment(value, this.documentForCreation(), "template").childNodes.slice()) {
			this.content.appendChild(child);
		}
	}

	override get textContent(): string {
		return this.content.textContent ?? "";
	}

	override set textContent(value: string | null) {
		this.content.textContent = value;
	}

	override appendChild<T extends Node>(child: T): T {
		return this.content.appendChild(child);
	}

	override insertBefore<T extends Node>(child: T, reference: Node | null): T {
		return this.content.insertBefore(child, reference);
	}

	override replaceChild<T extends Node>(child: Node, previous: T): T {
		return this.content.replaceChild(child, previous);
	}

	override removeChild<T extends Node>(child: T): T {
		return this.content.removeChild(child);
	}

	override cloneNode(deep = false): HTMLTemplateElement {
		const clone = new HTMLTemplateElement(this.qualifiedName, this.ownerDocument, this.namespaceURI);
		for (let index = this.attributes.length - 1; index >= 0; index--) {
			const attr = this.attributes[index];
			clone.setAttribute(attr.name, attr.value);
		}
		if (deep) for (const child of this.content.childNodes) clone.content.appendChild(child.cloneNode(true));
		return clone;
	}
}

/** Minimal HTML document. */
export class Document extends Node {
	defaultView: DOMWindow | null = null;
	URL = "about:blank";
	activeElement: Element | null = null;

	constructor() {
		super(NodeType.DOCUMENT, "#document", null);
		this.ownerDocument = null;
	}

	/** Root element of the document. */
	get documentElement(): Element | null {
		return this.children[0] ?? null;
	}

	/** Element children. */
	get children(): Element[] {
		return this.childNodes.filter((child): child is Element => child instanceof Element);
	}

	/** HTML body, or a detached empty body when absent like linkedom. */
	get body(): HTMLElement {
		const body = this.querySelector("body");
		return body instanceof HTMLElement ? body : this.createElement("body");
	}

	/** HTML head, or a detached empty head when absent. */
	get head(): HTMLElement {
		const head = this.querySelector("head");
		return head instanceof HTMLElement ? head : this.createElement("head");
	}

	/** Document title text. */
	get title(): string {
		return this.querySelector("title")?.textContent ?? "";
	}

	set title(value: string) {
		let title = this.querySelector("title");
		if (!title) {
			title = this.createElement("title");
			this.head.appendChild(title);
		}
		title.textContent = value;
	}

	override get textContent(): null {
		return null;
	}

	override set textContent(_value: string | null) {}

	/** Create an HTML element. */
	createElement(tagName: string, _options?: ElementCreationOptions): HTMLElement {
		switch (tagName.toLowerCase()) {
			case "iframe":
				return new HTMLIFrameElement(tagName, this, HTML_NAMESPACE);
			case "meta":
				return new HTMLMetaElement(tagName, this, HTML_NAMESPACE);
			case "template":
				return new HTMLTemplateElement(tagName, this, HTML_NAMESPACE);
			default:
				return new HTMLElement(tagName, this, HTML_NAMESPACE);
		}
	}

	/** Create a namespaced element. */
	createElementNS(namespace: string | null, tagName: string): Element {
		if (namespace === SVG_NAMESPACE) return new SVGElement(tagName, this, namespace);
		if (namespace === null || namespace === HTML_NAMESPACE) return this.createElement(tagName);
		return new HTMLElement(tagName, this, namespace);
	}

	/** Create a text node. */
	createTextNode(data: string): Text {
		return new Text(data, this);
	}

	/** Create a comment. */
	createComment(data: string): Comment {
		return new Comment(data, this);
	}

	/** Create an attribute. */
	createAttribute(name: string): Attr {
		return new Attr(name.toLowerCase(), "", this);
	}

	/** Create a document fragment. */
	createDocumentFragment(): DocumentFragment {
		return new DocumentFragment(this);
	}

	/** Find the first element by id. */
	getElementById(id: string): HTMLElement | null {
		const element = this.querySelector(`#${cssEscapeIdentifier(id)}`);
		return element instanceof HTMLElement ? element : null;
	}

	/** Find the first matching descendant. */
	querySelector(selector: string): Element | null {
		return querySelectorAllFrom(this, selector, true)[0] ?? null;
	}

	/** Find all matching descendants. */
	querySelectorAll(selector: string): Element[] {
		return querySelectorAllFrom(this, selector, true);
	}

	/** Descendant elements with a tag name. */
	getElementsByTagName(tagName: string): Element[] {
		return this.querySelectorAll(tagName === "*" ? "*" : tagName);
	}

	/** Descendant elements containing all class tokens. */
	getElementsByClassName(classNames: string): Element[] {
		const tokens = classNames.trim().split(/\s+/).filter(Boolean);
		return this.querySelectorAll("*").filter(element => tokens.every(token => element.classList.contains(token)));
	}

	/** Adopt a node into this document. */
	adoptNode<T extends Node>(node: T): T {
		node.parentNode?.removeChild(node);
		node.setOwnerDocument(this);
		return node;
	}

	/** Import a cloned node into this document. */
	importNode<T extends Node>(node: T, deep = false): T {
		const clone = node.cloneNode(deep) as T;
		clone.setOwnerDocument(this);
		return clone;
	}

	/** Legacy event factory used by libraries. */
	createEvent(_kind: string): Event {
		return new Event("");
	}

	override cloneNode(deep = false): Document {
		const clone = new Document();
		if (deep) for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
		return clone;
	}
}

/** Window shape returned by parseHTML. */
export class DOMWindow extends EventTarget {
	readonly document: Document;
	readonly Node = Node;
	readonly Element = Element;
	readonly HTMLElement = HTMLElement;
	readonly HTMLIFrameElement = HTMLIFrameElement;
	readonly SVGElement = SVGElement;
	readonly Text = Text;
	readonly Comment = Comment;
	readonly Document = Document;
	readonly DocumentFragment = DocumentFragment;
	readonly Event = Event;
	readonly CustomEvent = CustomEvent;
	readonly navigator = { userAgent: "pi-utils-dom", platform: "" };
	readonly location = { href: "about:blank" };
	readonly window: DOMWindow;
	readonly self: DOMWindow;
	readonly top: DOMWindow;
	readonly parent: DOMWindow;

	constructor(document: Document) {
		super();
		this.document = document;
		this.window = this;
		this.self = this;
		this.top = this;
		this.parent = this;
		document.defaultView = this;
	}

	/** Browser-compatible computed style placeholder. */
	getComputedStyle(element: Element): CSSStyleDeclaration {
		return element.style;
	}

	/** Schedule an animation callback. */
	requestAnimationFrame(callback: FrameRequestCallback): number {
		return globalThis.setTimeout(() => callback(Date.now()), 16) as unknown as number;
	}

	/** Cancel an animation callback. */
	cancelAnimationFrame(handle: number): void {
		globalThis.clearTimeout(handle);
	}

	/** Empty selection object. */
	getSelection(): { rangeCount: number; removeAllRanges(): void } {
		return { rangeCount: 0, removeAllRanges() {} };
	}
}

const VOID_ELEMENTS: Record<string, true> = {
	area: true,
	base: true,
	br: true,
	col: true,
	embed: true,
	hr: true,
	img: true,
	input: true,
	link: true,
	meta: true,
	param: true,
	source: true,
	track: true,
	wbr: true,
};
const BOOLEAN_ATTRIBUTES: Record<string, true> = {
	allowfullscreen: true,
	async: true,
	autofocus: true,
	autoplay: true,
	checked: true,
	controls: true,
	default: true,
	defer: true,
	disabled: true,
	formnovalidate: true,
	hidden: true,
	inert: true,
	ismap: true,
	itemscope: true,
	loop: true,
	multiple: true,
	muted: true,
	nomodule: true,
	novalidate: true,
	open: true,
	playsinline: true,
	readonly: true,
	required: true,
	reversed: true,
	selected: true,
};

function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/ /g, "&#160;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
	return value.replace(/"/g, "&quot;");
}

/** Serialize a DOM node as HTML. */
export function serializeNode(node: Node): string {
	if (node instanceof Comment) return `<!--${node.data}-->`;
	if (node instanceof Text) return node.serializeRaw ? node.data : escapeText(node.data);
	if (node instanceof Document || node instanceof DocumentFragment) return node.childNodes.map(serializeNode).join("");
	if (!(node instanceof Element)) return "";
	const attributes = node.attributes
		.map(attr =>
			attr.value === "" && BOOLEAN_ATTRIBUTES[attr.name.toLowerCase()]
				? ` ${attr.name}`
				: ` ${attr.name}="${escapeAttribute(attr.value)}"`,
		)
		.join("");
	const style =
		node.style.cssText && !node.attributes.getNamedItem("style")
			? ` style="${escapeAttribute(node.style.cssText)}"`
			: "";
	const opening = `<${node.qualifiedName}${attributes}${style}>`;
	if (VOID_ELEMENTS[node.localName]) return opening;
	const raw = node.localName === "script" || node.localName === "style";
	const childNodes = node instanceof HTMLTemplateElement ? node.content.childNodes : node.childNodes;
	const content = raw
		? childNodes.map(child => (child instanceof Text ? child.data : serializeNode(child))).join("")
		: childNodes.map(serializeNode).join("");
	return `${opening}${content}</${node.qualifiedName}>`;
}

function cssEscapeIdentifier(value: string): string {
	return value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}
