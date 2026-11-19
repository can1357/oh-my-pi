/** Behavior-compatible reimplementation of linkedom's used surface. */

import { DOMWindow } from "./dom/core";
import { parseDocument } from "./dom/parser";

export {
	Attr,
	Comment,
	CSSStyleDeclaration,
	CustomEvent,
	DOMTokenList,
	DOMWindow,
	Document,
	DocumentFragment,
	Element,
	Event,
	EventTarget,
	HTMLElement,
	HTMLIFrameElement,
	HTMLMetaElement,
	HTMLTemplateElement,
	NamedNodeMap,
	Node,
	NodeType,
	SVGElement,
	serializeNode,
	Text,
} from "./dom/core";

/** Parse HTML or XML-like markup into a lightweight window and document. */
export function parseHTML(html: string): DOMWindow {
	return new DOMWindow(parseDocument(html));
}
