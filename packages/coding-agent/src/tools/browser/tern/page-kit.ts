import ariaBundle from "../aria/aria-snapshot.bundle.txt" with { type: "text" };
import type { AriaSnapshotPayload } from "../aria/aria-snapshot";
import { DEFAULT_STYLE_PROPERTIES, type QueryBox } from "../queries";
import { SEMANTIC_QUERY_HANDLERS } from "../query-handlers";
import type { Observation } from "../tab-protocol";
import type { TernSelector } from "./selectors";

/** Action whose actionability `target()` checks; `point` only scrolls and requires visibility. */
export type TernTargetAction =
	| "click"
	| "dblclick"
	| "hover"
	| "check"
	| "type"
	| "fill"
	| "focus"
	| "drag"
	| "upload"
	| "point";

/** Why `target()` could not produce an actionable point. */
export type TernTargetFailure =
	| "missing"
	| "hidden"
	| "disabled"
	| "notEditable"
	| "unstable"
	| "covered"
	| "offViewport";

/** `target()` result: the point to press (viewport CSS px of the element's frame) or the failure reason. */
export type TernTarget =
	| { ok: true; x: number; y: number; width: number; height: number; count: number }
	| { ok: false; reason: TernTargetFailure; count: number; detail?: string };

/** Value type of each `read()` property. */
export interface TernReadValues {
	/** Trimmed `innerText ?? textContent`. */
	text: string;
	/** `innerHTML`. */
	html: string;
	/** `outerHTML`. */
	outerHTML: string;
	/** Form value, or null when the element has none. */
	value: string | null;
	/** Attribute named by `arg`, or null when absent. */
	attr: string | null;
	/** Box in the frame's viewport, or null when zero-size. */
	box: QueryBox | null;
	/** Computed values of the properties in `arg` (default: `DEFAULT_STYLE_PROPERTIES`). */
	styles: Record<string, string>;
	/** Non-zero box and not `display:none` / `visibility:hidden|collapse`. */
	visible: boolean;
	/** Not `:disabled` and not `aria-disabled="true"`. */
	enabled: boolean;
	/** Native `checked`, else `aria-checked="true"`. */
	checked: boolean;
}

/** Property readable through `read()`. */
export type TernReadProp = keyof TernReadValues;

/** File passed to `setFiles()`; `data` is base64. */
export interface TernFilePayload {
	name: string;
	type: string;
	data: string;
}

/** Options for `observe()`; `root` scopes the walk to one element. */
export interface TernObserveOptions {
	includeAll?: boolean;
	viewportOnly?: boolean;
	root?: TernSelector;
	compact?: boolean;
}

/** `observe()` result; ids populate the document's `id` selector registry. */
export type TernObservation = Observation;

/** Numbered screenshot overlay installed by `annotate()`; remove it with `removeOverlay(token)`. */
export interface TernAnnotation {
	token: string;
	boxes: Array<{ id: number; x: number; y: number; width: number; height: number }>;
}

/** One descendant frame reported by `frames()`; `path` is dot-joined indices into `window.frames`. */
export interface TernFrameInfo {
	path: string;
	name: string | null;
	id: string | null;
	src: string | null;
	url: string | null;
	sameOrigin: boolean;
}

/** Viewport metrics of the kit's frame. */
export interface TernGeometry {
	innerWidth: number;
	innerHeight: number;
	dpr: number;
	scrollX: number;
	scrollY: number;
	scrollWidth: number;
	scrollHeight: number;
}

/**
 * Methods of `globalThis.__ompTernKit`, called by omp from the isolated world as
 * `kit[method](...args)`. Every argument and result is JSON; failures throw `Error`s with
 * agent-readable messages (a missing element: `No element matches <JSON selector>`).
 */
export interface TernKitApi {
	/** Number of elements matching `sel`. */
	count(sel: TernSelector): number;
	/** Read one property of the first match; null when nothing matches. */
	read<P extends TernReadProp>(sel: TernSelector, prop: P, arg?: string | string[]): TernReadValues[P] | null;
	/** Scroll the first match into view and check actionability for `action`. */
	target(sel: TernSelector, action: TernTargetAction): Promise<TernTarget>;
	/** Focus the first match without scrolling. */
	focus(sel: TernSelector): void;
	/**
	 * Prepare a fill: text-like controls are focused with their content selected (`insert`: omp types
	 * the value); selects and date/time/color/range inputs are set directly (`done`).
	 */
	prepareFill(sel: TernSelector, value: string): { mode: "insert" } | { mode: "done" };
	/** Focus the first match and collapse the selection to the end of its content. */
	caretToEnd(sel: TernSelector): void;
	/** Checked state of a checkbox, radio, or ARIA checkbox/radio/switch. */
	checkState(sel: TernSelector): { checked: boolean };
	/** Select `<select>` options by value, then label; returns the selected values. */
	select(sel: TernSelector, values: string[]): string[];
	/** Assign files to a file input, or drop them on any other element. */
	setFiles(sel: TernSelector, files: TernFilePayload[]): void;
	/** Whether the first match is a file input or a `<label>` whose control is one. */
	isFileInput(sel: TernSelector): boolean;
	/** Open the native chooser of the first match's file input (`"input"`), or `"none"` when it has none. */
	openChooser(sel: TernSelector): "input" | "none";
	/** Scroll the first match to the viewport centre. */
	scrollIntoView(sel: TernSelector): void;
	/** Scroll the first match (or the window when `sel` is null) by `dx`/`dy` CSS px. */
	scrollBy(sel: TernSelector | null, dx: number, dy: number): void;
	/** Draw the highlight outline around the first match; remove it with `removeOverlay(id)`. */
	highlight(sel: TernSelector, id: string): void;
	/** Remove a highlight or annotation overlay. */
	removeOverlay(id: string): void;
	/** List elements like the Chromium AX-tree observe; replaces the `id` registry. */
	observe(opts: TernObserveOptions): TernObservation;
	/** Playwright ARIA snapshot of `root` (or the document); refs resolve through `ariaRef` selectors. */
	ariaSnapshot(
		root: TernSelector | null,
		request: { depth?: number; boxes?: boolean },
		urls: boolean,
	): AriaSnapshotPayload;
	/** Install numbered overlays over connected, non-empty registry ids. */
	annotate(ids: number[]): TernAnnotation;
	/** Tag the first match with a fresh handle token (null when missing). */
	mark(sel: TernSelector): string | null;
	/** Tag every match with a fresh handle token each, in document order. */
	markAll(sel: TernSelector): string[];
	/** Drop a handle token. */
	unmark(token: string): void;
	/** Every descendant frame reachable through `window.frames`. */
	frames(): TernFrameInfo[];
	/** Frame path (relative to this document) of the matched `<iframe>`/`<frame>`, or null. */
	frameOf(sel: TernSelector): string | null;
	/**
	 * Viewport position of the content box hosting `window.frames[index]`, or null; throws when
	 * the frame element or an ancestor is scaled, rotated or skewed (points inside cannot be mapped).
	 */
	frameOrigin(index: number): { x: number; y: number } | null;
	/** Whether body text (or `root`'s text) contains — or with `exact`, equals — `text` after trimming. */
	hasText(text: string, root: TernSelector | null, exact: boolean): boolean;
	/** Viewport and scroll metrics. */
	geometry(): TernGeometry;
	/** Whether the deep active element is editable. */
	activeEditable(): boolean;
}

/** Roles `observe()` lists by default; mirrors the Chromium backend's AX-tree observe. */
const INTERACTIVE_ROLES = [
	"button",
	"link",
	"textbox",
	"combobox",
	"listbox",
	"option",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"slider",
	"spinbutton",
	"searchbox",
	"treeitem",
];

const SEMANTIC_SOURCE = Object.entries(SEMANTIC_QUERY_HANDLERS)
	.map(([name, handler]) => `${JSON.stringify(name)}: ${handler.toString()}`)
	.join(",\n");

// Page-side kit body. Plain JS (no eval/new Function/string timers: runs under page CSP) in the
// scope set up by TERN_KIT_SOURCE, where `loadAria` (fresh ARIA bundle instance), `semantic`,
// `INTERACTIVE_ROLES` and `DEFAULT_STYLES` are bound. No backticks or `${` in here: this is a String.raw
// template.
const KIT_BODY = String.raw`
const STATE_ROLES_CHECKED = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
const NAME_FROM_CONTENT = new Set([
	"button", "cell", "checkbox", "columnheader", "gridcell", "heading", "link", "menuitem",
	"menuitemcheckbox", "menuitemradio", "option", "radio", "row", "rowheader", "switch", "tab",
	"tooltip", "treeitem",
]);
const SKIP_TAGS = new Set(["script", "style", "template", "noscript", "head", "meta", "link", "title"]);
const POINTER_ACTIONS = new Set(["click", "dblclick", "hover", "check", "drag", "upload"]);
const ENABLED_ACTIONS = new Set(["click", "dblclick", "check", "type", "fill", "upload"]);
const EDIT_ACTIONS = new Set(["type", "fill"]);
const SETTER_INPUT_TYPES = new Set(["date", "datetime-local", "month", "week", "time", "color", "range"]);
const UNTYPABLE_INPUT_TYPES = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "hidden", "file"]);
const TRIVIAL_VALUE_INPUT_TYPES = new Set(["checkbox", "image", "radio"]);
const HANDLE_ATTR = "data-omp-tern-handle";
const OVERLAY_ATTR = "data-omp-tern-overlay";

let registry = new Map();
// Ref resolution is stateless (it scans _ariaRef expandos), so one instance serves every lookup.
const ariaRefs = loadAria();

const missing = sel => new Error("No element matches " + JSON.stringify(sel));
const normalizeSpace = value => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
const randomToken = () => {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
};
// Add a fresh handle token to el's token list (tokens of other handles stay).
const markElement = el => {
	const token = randomToken();
	const existing = (el.getAttribute(HANDLE_ATTR) || "").split(/\s+/).filter(Boolean);
	el.setAttribute(HANDLE_ATTR, existing.concat(token).join(" "));
	return token;
};
const inputType = el => String(el.type || el.getAttribute("type") || "text").toLowerCase();
const composedParent = node => node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
const composedContains = (ancestor, descendant) => {
	for (let current = descendant, depth = 0; current && depth < 256; depth++) {
		if (current === ancestor) return true;
		current = composedParent(current);
	}
	return false;
};
const deepActiveElement = () => {
	let active = document.activeElement;
	while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
	return active;
};
const describeElement = el => {
	const id = el.id ? "#" + el.id : "";
	const classes = Array.from(el.classList || []).slice(0, 2).map(name => "." + name).join("");
	return "<" + el.localName + id + classes + ">";
};
const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
const fireInputChange = el => {
	fire(el, "input");
	fire(el, "change");
};

// ---- element enumeration -------------------------------------------------------------------

// Pre-order walk of every element, descending into open shadow roots before light children.
const forEachDeep = (root, visit) => {
	for (const el of Array.from(root.children || [])) {
		visit(el);
		if (el.shadowRoot) forEachDeep(el.shadowRoot, visit);
		forEachDeep(el, visit);
	}
};
const deepElements = root => {
	const out = [];
	forEachDeep(root, el => out.push(el));
	return out;
};
const deepQueryAll = (root, selector) => deepElements(root).filter(el => el.matches(selector));

// Puppeteer's pierceQuerySelectorAll.
const pierceAll = selector => {
	const result = [];
	const collect = root => {
		const iter = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
		do {
			const current = iter.currentNode;
			if (current.shadowRoot) collect(current.shadowRoot);
			if (current.nodeType !== Node.ELEMENT_NODE) continue;
			if (current !== root && current.matches(selector)) result.push(current);
		} while (iter.nextNode());
	};
	collect(document.documentElement);
	return result;
};

// Puppeteer's text engine (textQuerySelectorAll + createTextContent), with a per-query cache.
const textSuitable = node =>
	node.nodeName !== "SCRIPT" && node.nodeName !== "STYLE" && !(document.head && document.head.contains(node));
const textContentFull = (root, cache) => {
	const cached = cache.get(root);
	if (cached !== undefined) return cached;
	let value = "";
	if (textSuitable(root)) {
		const tag = root.nodeType === Node.ELEMENT_NODE ? root.localName : "";
		if (tag === "select" || tag === "textarea" || (tag === "input" && !TRIVIAL_VALUE_INPUT_TYPES.has(root.type))) {
			value = root.value;
		} else {
			for (let child = root.firstChild; child; child = child.nextSibling) {
				if (child.nodeType === Node.TEXT_NODE) value += child.nodeValue || "";
				else if (child.nodeType === Node.ELEMENT_NODE) value += textContentFull(child, cache);
			}
			if (root.nodeType === Node.ELEMENT_NODE && root.shadowRoot) value += textContentFull(root.shadowRoot, cache);
		}
	}
	cache.set(root, value);
	return value;
};
const textQueryAll = (root, query, cache, out) => {
	let yielded = false;
	for (const node of Array.from(root.childNodes)) {
		if (node.nodeType === Node.ELEMENT_NODE && textSuitable(node)) {
			const before = out.length;
			textQueryAll(node.shadowRoot || node, query, cache, out);
			if (out.length > before) yielded = true;
		}
	}
	if (yielded) return;
	if (root.nodeType === Node.ELEMENT_NODE && textSuitable(root) && textContentFull(root, cache).includes(query)) {
		out.push(root);
	}
};

// ---- roles and names -----------------------------------------------------------------------

const hasAccessibleLabel = el => !!(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"));
const insideSectioning = el => {
	for (let current = composedParent(el); current; current = composedParent(current)) {
		if (["article", "aside", "main", "nav", "section"].includes(current.localName)) return true;
	}
	return false;
};
const implicitRole = el => {
	const tag = el.localName;
	switch (tag) {
		case "a":
		case "area":
			return el.hasAttribute("href") ? "link" : tag === "a" ? "generic" : null;
		case "button":
			return "button";
		case "input": {
			const type = inputType(el);
			if (type === "hidden") return null;
			if (type === "checkbox") return "checkbox";
			if (type === "radio") return "radio";
			if (type === "range") return "slider";
			if (type === "number") return "spinbutton";
			if (["button", "submit", "reset", "image", "file", "color"].includes(type)) return "button";
			if (type === "search") return el.hasAttribute("list") ? "combobox" : "searchbox";
			return el.hasAttribute("list") ? "combobox" : "textbox";
		}
		case "textarea":
			return "textbox";
		case "select":
			return el.multiple || el.size > 1 ? "listbox" : "combobox";
		case "option":
			return "option";
		case "optgroup":
		case "fieldset":
		case "details":
			return "group";
		case "summary":
			return "button";
		case "img":
			return el.getAttribute("alt") === "" ? "none" : "img";
		case "ul":
		case "ol":
		case "menu":
			return "list";
		case "li":
			return "listitem";
		case "dt":
			return "term";
		case "dd":
			return "definition";
		case "nav":
			return "navigation";
		case "main":
			return "main";
		case "aside":
			return "complementary";
		case "header":
			return insideSectioning(el) ? "generic" : "banner";
		case "footer":
			return insideSectioning(el) ? "generic" : "contentinfo";
		case "section":
			return hasAccessibleLabel(el) ? "region" : "generic";
		case "form":
			return "form";
		case "search":
			return "search";
		case "article":
			return "article";
		case "dialog":
			return "dialog";
		case "h1":
		case "h2":
		case "h3":
		case "h4":
		case "h5":
		case "h6":
			return "heading";
		case "p":
			return "paragraph";
		case "blockquote":
			return "blockquote";
		case "figure":
			return "figure";
		case "table":
			return "table";
		case "thead":
		case "tbody":
		case "tfoot":
			return "rowgroup";
		case "tr":
			return "row";
		case "th":
			return el.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
		case "td":
			return "cell";
		case "caption":
			return "caption";
		case "hr":
			return "separator";
		case "progress":
			return "progressbar";
		case "meter":
			return "meter";
		case "output":
			return "status";
		case "code":
			return "code";
		case "div":
		case "span":
		case "b":
		case "i":
		case "u":
		case "small":
		case "label":
			return el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable) ? "textbox" : "generic";
		default:
			return el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable) ? "textbox" : null;
	}
};
const roleOf = el => {
	const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0].toLowerCase();
	if (explicit) return explicit === "presentation" ? "none" : explicit;
	return implicitRole(el);
};
const idrefText = (el, attribute) => {
	const ids = (el.getAttribute(attribute) || "").split(/\s+/).filter(Boolean);
	if (!ids.length) return "";
	const root = el.getRootNode();
	const lookup = id => (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
	return normalizeSpace(ids.map(id => {
		const target = lookup(id);
		return target ? contentText(target, null) : "";
	}).join(" "));
};
const hiddenForA11y = el => {
	for (let current = el; current; current = composedParent(current)) {
		if (current.getAttribute && current.getAttribute("aria-hidden") === "true") return true;
	}
	if (typeof el.checkVisibility === "function" && !el.checkVisibility()) return true;
	const style = getComputedStyle(el);
	return style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
};
// Text an element contributes as name-from-content: text nodes, embedded image alts, nested labels.
const contentText = (el, skip) => {
	let out = "";
	const walk = node => {
		for (let child = node.firstChild; child; child = child.nextSibling) {
			if (child.nodeType === Node.TEXT_NODE) {
				out += child.nodeValue || "";
				continue;
			}
			if (child.nodeType !== Node.ELEMENT_NODE || child === skip || SKIP_TAGS.has(child.localName)) continue;
			if (child.getAttribute("aria-hidden") === "true") continue;
			const style = getComputedStyle(child);
			if (style.display === "none") continue;
			const block = style.display !== "inline" && style.display !== "contents";
			if (block) out += " ";
			const label = child.getAttribute("aria-label");
			if (label) out += label;
			else if (child.localName === "img") out += child.getAttribute("alt") || "";
			else if (child.localName === "input" || child.localName === "select" || child.localName === "textarea") {
				out += child.localName === "select" ? (child.selectedOptions[0] ? child.selectedOptions[0].text : "") : child.value || "";
			} else if (child.shadowRoot) walk(child.shadowRoot);
			else walk(child);
			if (block) out += " ";
		}
	};
	if (el.shadowRoot) walk(el.shadowRoot);
	else walk(el);
	return normalizeSpace(out);
};
const accessibleName = (el, role) => {
	const label = normalizeSpace(el.getAttribute("aria-label"));
	if (label) return label;
	const labelledBy = idrefText(el, "aria-labelledby");
	if (labelledBy) return labelledBy;
	if (el.labels && el.labels.length) {
		const text = normalizeSpace(Array.from(el.labels, labelEl => contentText(labelEl, el)).join(" "));
		if (text) return text;
	}
	const tag = el.localName;
	if (tag === "img" || tag === "area" || (tag === "input" && inputType(el) === "image")) {
		const alt = normalizeSpace(el.getAttribute("alt"));
		if (alt) return alt;
	}
	if (tag === "input") {
		const type = inputType(el);
		if (type === "button" || type === "submit" || type === "reset") {
			const value = normalizeSpace(el.value);
			if (value) return value;
			if (type === "submit") return "Submit";
			if (type === "reset") return "Reset";
		}
	}
	if (tag === "fieldset" || tag === "figure" || tag === "table") {
		const caption = el.querySelector(tag === "fieldset" ? "legend" : tag === "figure" ? "figcaption" : "caption");
		if (caption) {
			const text = contentText(caption, null);
			if (text) return text;
		}
	}
	if (NAME_FROM_CONTENT.has(role || roleOf(el))) {
		const text = contentText(el, null);
		if (text) return text;
	}
	const title = normalizeSpace(el.getAttribute("title"));
	if (title) return title;
	return normalizeSpace(el.getAttribute("placeholder") || el.getAttribute("aria-placeholder"));
};

// ---- resolution ----------------------------------------------------------------------------

const resolveAll = sel => {
	switch (sel.engine) {
		case "css":
			return Array.from(document.querySelectorAll(sel.query));
		case "pierce":
			return pierceAll(sel.query);
		case "text": {
			const out = [];
			textQueryAll(document, sel.query, new Map(), out);
			return out;
		}
		case "xpath": {
			const result = document.evaluate(sel.query, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
			const out = [];
			for (let index = 0; index < result.snapshotLength; index++) {
				const node = result.snapshotItem(index);
				if (node && node.nodeType === Node.ELEMENT_NODE) out.push(node);
			}
			return out;
		}
		case "aria": {
			const wantedName = sel.name === undefined ? undefined : normalizeSpace(sel.name);
			return deepElements(document).filter(el => {
				const role = roleOf(el);
				if (sel.role !== undefined && role !== sel.role) return false;
				if (wantedName !== undefined && accessibleName(el, role) !== wantedName) return false;
				return !hiddenForA11y(el);
			});
		}
		case "label":
		case "placeholder":
		case "testid":
		case "alt":
		case "title":
		case "role":
			return Array.from(semantic[sel.engine](document, sel.query));
		case "ariaRef": {
			const el = ariaRefs.resolveAriaRef(sel.ref);
			return el ? [el] : [];
		}
		case "id": {
			const el = registry.get(sel.id);
			if (!el) throw new Error("Unknown element id " + sel.id + ". Run tab.observe() to refresh the element list.");
			if (!el.isConnected) throw new Error("Element id " + sel.id + " is stale. Run tab.observe() again.");
			return [el];
		}
		case "handle":
			return pierceAll("[" + HANDLE_ATTR + "~=\"" + CSS.escape(sel.token) + "\"]");
	}
	throw new Error("Unsupported selector engine " + JSON.stringify(sel.engine));
};
const first = sel => resolveAll(sel)[0] || null;
const requireFirst = sel => {
	const el = first(sel);
	if (!el) throw missing(sel);
	return el;
};

// ---- element state -------------------------------------------------------------------------

const boxOf = el => {
	const rect = el.getBoundingClientRect();
	return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
};
const hiddenReason = el => {
	const style = getComputedStyle(el);
	if (style.display === "none") return "display:none";
	if (style.visibility === "hidden" || style.visibility === "collapse") return "visibility:" + style.visibility;
	const rect = el.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return "zero-size";
	return null;
};
const isEnabled = el => !el.matches(":disabled") && el.getAttribute("aria-disabled") !== "true";
const isChecked = el => (typeof el.checked === "boolean" ? el.checked : el.getAttribute("aria-checked") === "true");
const isEditable = (el, action) => {
	const tag = el.localName;
	if (tag === "textarea") return !el.readOnly;
	if (tag === "input") {
		const type = inputType(el);
		if (UNTYPABLE_INPUT_TYPES.has(type)) return false;
		if (action === "type" && (type === "color" || type === "range")) return false;
		return !el.readOnly;
	}
	if (tag === "select") return action === "fill";
	return !!el.isContentEditable;
};
const isTextEditable = el => {
	if (!el) return false;
	if (el.localName === "textarea") return !el.readOnly && !el.disabled;
	if (el.localName === "input") return !UNTYPABLE_INPUT_TYPES.has(inputType(el)) && !el.readOnly && !el.disabled;
	return !!el.isContentEditable;
};
const fullyInView = el => {
	const rect = el.getBoundingClientRect();
	return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
};
const nextFrame = () => {
	const { promise, resolve } = Promise.withResolvers();
	requestAnimationFrame(() => resolve());
	// Backgrounded web views may never deliver animation frames.
	setTimeout(() => resolve(), 50);
	return promise;
};
const sameRect = (a, b) =>
	Math.abs(a.left - b.left) < 0.5 &&
	Math.abs(a.top - b.top) < 0.5 &&
	Math.abs(a.width - b.width) < 0.5 &&
	Math.abs(a.height - b.height) < 0.5;
const hitTest = (x, y) => {
	let top = document.elementFromPoint(x, y);
	for (let depth = 0; top && top.shadowRoot && depth < 16; depth++) {
		const nested = top.shadowRoot.elementFromPoint(x, y);
		if (!nested || nested === top) break;
		top = nested;
	}
	return top;
};
const fileInputOf = el => {
	if (el.localName === "input" && inputType(el) === "file") return el;
	if (el.localName === "label" && el.control && el.control.localName === "input" && inputType(el.control) === "file") {
		return el.control;
	}
	return null;
};
const setNativeValue = (el, value) => {
	let proto = Object.getPrototypeOf(el);
	let descriptor;
	while (proto && !(descriptor = Object.getOwnPropertyDescriptor(proto, "value"))) proto = Object.getPrototypeOf(proto);
	if (descriptor && descriptor.set) descriptor.set.call(el, value);
	else el.value = value;
};
const selectContents = el => {
	const selection = getSelection();
	if (!selection) return;
	const range = document.createRange();
	range.selectNodeContents(el);
	selection.removeAllRanges();
	selection.addRange(range);
	return range;
};
const removeOverlay = id => {
	for (const el of Array.from(document.querySelectorAll("[" + OVERLAY_ATTR + "]"))) {
		if (el.getAttribute(OVERLAY_ATTR) === id) el.remove();
	}
};

// ---- observe -------------------------------------------------------------------------------

const tristate = value => (value === "true" || value === "false" || value === "mixed" ? value : undefined);
const observeStates = (el, role, focused) => {
	const states = [];
	const tag = el.localName;
	if (!isEnabled(el)) states.push("disabled");
	let checked = STATE_ROLES_CHECKED.has(role) ? tristate(el.getAttribute("aria-checked")) : undefined;
	if (tag === "input" && (inputType(el) === "checkbox" || inputType(el) === "radio")) {
		checked = el.indeterminate ? "mixed" : String(el.checked);
	} else if (checked === undefined && STATE_ROLES_CHECKED.has(role)) checked = "false";
	if (checked !== undefined) states.push("checked=" + checked);
	const pressed = tristate(el.getAttribute("aria-pressed"));
	if (pressed !== undefined) states.push("pressed=" + pressed);
	let selected = tristate(el.getAttribute("aria-selected"));
	if (tag === "option") selected = String(el.selected);
	if (selected !== undefined) states.push("selected=" + selected);
	let expanded = tristate(el.getAttribute("aria-expanded"));
	if (expanded === undefined && tag === "summary" && el.parentElement && el.parentElement.localName === "details") {
		expanded = String(el.parentElement.open);
	}
	if (expanded !== undefined) states.push("expanded=" + expanded);
	if (el.required === true || el.getAttribute("aria-required") === "true") states.push("required");
	if (((tag === "input" || tag === "textarea") && el.readOnly) || el.getAttribute("aria-readonly") === "true") {
		states.push("readonly");
	}
	if ((tag === "select" && el.multiple) || el.getAttribute("aria-multiselectable") === "true") {
		states.push("multiselectable");
	}
	if (tag === "textarea" || el.getAttribute("aria-multiline") === "true" || (role === "textbox" && el.isContentEditable)) {
		states.push("multiline");
	}
	if (el.getAttribute("aria-modal") === "true" || (tag === "dialog" && el.matches(":modal"))) states.push("modal");
	if (focused) states.push("focused");
	return states;
};
const observeValue = (el, role) => {
	const tag = el.localName;
	if (tag === "select" && role === "combobox") {
		return el.selectedOptions[0] ? normalizeSpace(el.selectedOptions[0].text) : undefined;
	}
	if (role === "slider" || role === "spinbutton" || role === "progressbar" || role === "meter") {
		const raw = el.getAttribute("aria-valuenow") || (tag === "input" || tag === "progress" || tag === "meter" ? String(el.value) : "");
		const number = Number(raw);
		return raw !== "" && Number.isFinite(number) ? number : undefined;
	}
	if ((tag === "input" || tag === "textarea") && (role === "textbox" || role === "searchbox" || role === "combobox")) {
		return el.value ? String(el.value) : undefined;
	}
	if (role === "textbox" && el.isContentEditable) return normalizeSpace(el.innerText) || undefined;
	return undefined;
};
const ownText = el => {
	let out = "";
	for (let child = el.firstChild; child; child = child.nextSibling) {
		if (child.nodeType === Node.TEXT_NODE) out += child.nodeValue || "";
	}
	return normalizeSpace(out);
};
const flatChildren = el => {
	if (el.shadowRoot) return Array.from(el.shadowRoot.children);
	if (el.localName === "slot" && typeof el.assignedElements === "function") {
		const assigned = el.assignedElements({ flatten: true });
		if (assigned.length) return assigned;
	}
	return Array.from(el.children);
};
const intersectsViewport = el => {
	const rect = el.getBoundingClientRect();
	return rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
};
const observe = opts => {
	const includeAll = !!opts.includeAll;
	const viewportOnly = !!opts.viewportOnly;
	const compact = !!opts.compact;
	let root = document.body || document.documentElement;
	if (opts.root) {
		root = first(opts.root);
		if (!root) throw new Error("tab.observe: selector " + JSON.stringify(opts.root) + " matched no element");
	}
	const focused = deepActiveElement();
	const collected = [];
	const visit = (el, inSelect) => {
		const tag = el.localName;
		if (SKIP_TAGS.has(tag) || el.getAttribute("aria-hidden") === "true" || el.inert) return false;
		const style = getComputedStyle(el);
		if (style.display === "none" && !inSelect) return false;
		const role = roleOf(el);
		const rect = el.getBoundingClientRect();
		const rendered =
			inSelect || (style.visibility !== "hidden" && style.visibility !== "collapse" && rect.width > 0 && rect.height > 0);
		let entry = null;
		let interactive = false;
		if (rendered && role && role !== "none" && role !== "presentation") {
			const states = observeStates(el, role, el === focused);
			interactive =
				INTERACTIVE_ROLES.has(role) ||
				states.some(state => /^(checked|pressed|selected|expanded)=/.test(state)) ||
				el === focused;
			let name = accessibleName(el, role);
			let include = interactive;
			if (!include && includeAll) {
				if (role === "generic") {
					name = name || ownText(el);
					include = !!name;
				} else {
					name = name || ownText(el);
					include = true;
				}
			}
			if (include && viewportOnly && !intersectsViewport(inSelect && el.closest("select") ? el.closest("select") : el)) {
				include = false;
			}
			if (include) {
				const description =
					idrefText(el, "aria-describedby") ||
					normalizeSpace(el.getAttribute("aria-description")) ||
					(name !== normalizeSpace(el.getAttribute("title")) ? normalizeSpace(el.getAttribute("title")) : "");
				entry = {
					el,
					role,
					name: name || undefined,
					value: observeValue(el, role),
					description: description || undefined,
					keyshortcuts: normalizeSpace(el.getAttribute("aria-keyshortcuts")) || undefined,
					states,
					drop: false,
				};
				collected.push(entry);
			}
		}
		let descendantInteractive = false;
		const childInSelect = inSelect || tag === "select";
		for (const child of flatChildren(el)) {
			if (visit(child, childInSelect)) descendantInteractive = true;
		}
		if (entry && compact && !entry.name && !descendantInteractive && ["generic", "none", "group"].includes(entry.role)) {
			entry.drop = true;
		}
		return interactive || descendantInteractive;
	};
	visit(root, false);
	registry = new Map();
	const elements = [];
	for (const entry of collected) {
		if (entry.drop) continue;
		const id = elements.length + 1;
		registry.set(id, entry.el);
		const out = { id, role: entry.role, states: entry.states };
		for (const key of ["name", "value", "description", "keyshortcuts"]) {
			if (entry[key] !== undefined) out[key] = entry[key];
		}
		elements.push(out);
	}
	const doc = document.documentElement;
	return {
		url: location.href,
		title: document.title,
		viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
		scroll: {
			x: scrollX,
			y: scrollY,
			width: innerWidth,
			height: innerHeight,
			scrollWidth: doc.scrollWidth,
			scrollHeight: doc.scrollHeight,
		},
		elements,
	};
};

// ---- frames --------------------------------------------------------------------------------

const frameElementFor = (parentWindow, childWindow) => {
	let doc;
	try {
		doc = parentWindow.document;
		if (!doc) return null;
	} catch {
		return null;
	}
	return deepQueryAll(doc, "iframe,frame").find(el => el.contentWindow === childWindow) || null;
};
const listFrames = (win, prefix, out) => {
	let length = 0;
	try {
		length = win.length;
	} catch {
		return;
	}
	for (let index = 0; index < length; index++) {
		let child;
		try {
			child = win[index];
		} catch {
			continue;
		}
		if (!child) continue;
		const path = prefix ? prefix + "." + index : String(index);
		let url = null;
		let sameOrigin = false;
		try {
			url = String(child.location.href);
			sameOrigin = !!child.document;
		} catch {
			url = null;
			sameOrigin = false;
		}
		const owner = frameElementFor(win, child);
		out.push({
			path,
			name: owner ? owner.getAttribute("name") : null,
			id: owner ? owner.getAttribute("id") : null,
			src: owner ? owner.getAttribute("src") : null,
			url: sameOrigin ? url : null,
			sameOrigin,
		});
		listFrames(child, path, out);
	}
};
const findFramePath = (win, target, prefix) => {
	let length = 0;
	try {
		length = win.length;
	} catch {
		return null;
	}
	for (let index = 0; index < length; index++) {
		const child = win[index];
		const path = prefix ? prefix + "." + index : String(index);
		if (child === target) return path;
		const nested = findFramePath(child, target, path);
		if (nested) return nested;
	}
	return null;
};

// ---- kit -----------------------------------------------------------------------------------

const kit = {
	count: sel => resolveAll(sel).length,
	read: (sel, prop, arg) => {
		const el = first(sel);
		if (!el) return null;
		switch (prop) {
			case "text":
				return String(el.innerText != null ? el.innerText : el.textContent || "").trim();
			case "html":
				return el.innerHTML;
			case "outerHTML":
				return el.outerHTML;
			case "value":
				return "value" in el && el.value != null ? String(el.value) : null;
			case "attr":
				return el.getAttribute(String(arg));
			case "box": {
				const box = boxOf(el);
				return box.width > 0 && box.height > 0 ? box : null;
			}
			case "styles": {
				const computed = getComputedStyle(el);
				const props = Array.isArray(arg) ? arg : DEFAULT_STYLES;
				const out = {};
				for (const property of props) out[property] = computed.getPropertyValue(property);
				return out;
			}
			case "visible":
				return hiddenReason(el) === null;
			case "enabled":
				return isEnabled(el);
			case "checked":
				return isChecked(el);
		}
		throw new Error("Unsupported read property " + JSON.stringify(prop));
	},
	target: async (sel, action) => {
		const all = resolveAll(sel);
		const count = all.length;
		const el = all[0];
		if (!el) return { ok: false, reason: "missing", count };
		const hidden = hiddenReason(el);
		if (hidden) return { ok: false, reason: "hidden", count, detail: hidden };
		if (!fullyInView(el)) el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
		if (ENABLED_ACTIONS.has(action) && !isEnabled(el)) return { ok: false, reason: "disabled", count };
		if (EDIT_ACTIONS.has(action) && !isEditable(el, action)) {
			return { ok: false, reason: "notEditable", count, detail: describeElement(el) };
		}
		const pointer = POINTER_ACTIONS.has(action);
		let rect = el.getBoundingClientRect();
		if (pointer) {
			await nextFrame();
			let previous = el.getBoundingClientRect();
			let stable = false;
			for (let attempt = 0; attempt < 5 && !stable; attempt++) {
				await nextFrame();
				rect = el.getBoundingClientRect();
				stable = sameRect(previous, rect);
				previous = rect;
			}
			if (!stable) return { ok: false, reason: "unstable", count };
			const style = getComputedStyle(el);
			const late = hiddenReason(el);
			if (late) return { ok: false, reason: "hidden", count, detail: late };
			if (style.pointerEvents === "none") return { ok: false, reason: "covered", count, detail: "pointer-events:none" };
			if (action !== "upload" && Number(style.opacity) === 0) {
				return { ok: false, reason: "hidden", count, detail: "opacity:0" };
			}
		}
		const left = Math.max(0, Math.min(innerWidth, rect.left));
		const right = Math.max(0, Math.min(innerWidth, rect.right));
		const top = Math.max(0, Math.min(innerHeight, rect.top));
		const bottom = Math.max(0, Math.min(innerHeight, rect.bottom));
		const inViewport = right - left >= 1 && bottom - top >= 1;
		if ((pointer || action === "point") && !inViewport) return { ok: false, reason: "offViewport", count };
		const x = inViewport ? Math.floor((left + right) / 2) : Math.floor(rect.left + rect.width / 2);
		const y = inViewport ? Math.floor((top + bottom) / 2) : Math.floor(rect.top + rect.height / 2);
		if (pointer) {
			const hit = hitTest(x, y);
			if (!hit) return { ok: false, reason: "covered", count, detail: "elementFromPoint-null" };
			if (!composedContains(el, hit) && !composedContains(hit, el)) {
				return { ok: false, reason: "covered", count, detail: describeElement(hit) };
			}
		}
		return { ok: true, x, y, width: rect.width, height: rect.height, count };
	},
	focus: sel => {
		requireFirst(sel).focus({ preventScroll: true });
	},
	prepareFill: (sel, value) => {
		const el = requireFirst(sel);
		const tag = el.localName;
		if (tag === "select") {
			const options = Array.from(el.options);
			const option =
				options.find(candidate => candidate.value === value) ||
				options.find(candidate => candidate.label === value || normalizeSpace(candidate.text) === value);
			if (!option) throw new Error("No <select> option matches " + JSON.stringify(value));
			setNativeValue(el, option.value);
			fireInputChange(el);
			return { mode: "done" };
		}
		if (tag === "input") {
			const type = inputType(el);
			if (type === "file") throw new Error("Cannot fill a file input; use tab.uploadFile()");
			if (SETTER_INPUT_TYPES.has(type)) {
				setNativeValue(el, value);
				fireInputChange(el);
				return { mode: "done" };
			}
			if (UNTYPABLE_INPUT_TYPES.has(type)) throw new Error("Cannot fill <input type=\"" + type + "\">");
		}
		if (tag === "input" || tag === "textarea") {
			el.focus({ preventScroll: true });
			el.select();
			return { mode: "insert" };
		}
		if (el.isContentEditable) {
			el.focus({ preventScroll: true });
			selectContents(el);
			return { mode: "insert" };
		}
		throw new Error("tab.fill() requires an input, textarea, select, or contenteditable element; got " + describeElement(el));
	},
	caretToEnd: sel => {
		const el = requireFirst(sel);
		el.focus({ preventScroll: true });
		if (el.localName === "input" || el.localName === "textarea") {
			const end = String(el.value || "").length;
			try {
				el.setSelectionRange(end, end);
			} catch {
				// Inputs like email/number reject selection APIs; focus already places the caret.
			}
			return;
		}
		const range = selectContents(el);
		if (range) range.collapse(false);
	},
	checkState: sel => {
		const el = requireFirst(sel);
		const type = el.localName === "input" ? inputType(el) : "";
		if (type === "checkbox" || type === "radio") return { checked: !!el.checked };
		const role = (el.getAttribute("role") || "").toLowerCase();
		if (role === "checkbox" || role === "radio" || role === "switch") {
			return { checked: el.getAttribute("aria-checked") === "true" };
		}
		throw new Error("tab.check() requires a checkbox, radio, or ARIA switch");
	},
	select: (sel, values) => {
		const el = requireFirst(sel);
		if (el.localName !== "select") throw new Error("tab.select() requires a <select> element");
		const options = Array.from(el.options);
		const wanted = new Set();
		for (const value of values.map(String)) {
			const option =
				options.find(candidate => candidate.value === value) ||
				options.find(candidate => candidate.label === value || normalizeSpace(candidate.text) === value);
			if (option) wanted.add(option);
		}
		if (el.multiple) {
			for (const option of options) option.selected = wanted.has(option);
		} else {
			// A single select re-selects its first option the moment none is selected, so pick the
			// wanted one directly instead of deselecting the others first.
			const [first] = wanted;
			el.selectedIndex = first ? first.index : -1;
		}
		fireInputChange(el);
		return options.filter(option => option.selected).map(option => option.value);
	},
	setFiles: (sel, files) => {
		const el = requireFirst(sel);
		const transfer = new DataTransfer();
		for (const file of files) {
			const bytes = Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
			transfer.items.add(new File([bytes], file.name, { type: file.type || "application/octet-stream" }));
		}
		if (el.localName === "input" && inputType(el) === "file") {
			el.files = transfer.files;
			fireInputChange(el);
			return;
		}
		for (const type of ["dragenter", "dragover", "drop"]) {
			el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
		}
	},
	isFileInput: sel => fileInputOf(requireFirst(sel)) !== null,
	openChooser: sel => {
		const input = fileInputOf(requireFirst(sel));
		if (!input) return "none";
		if (typeof input.showPicker === "function") {
			try {
				input.showPicker();
				return "input";
			} catch {
				// showPicker needs transient activation; a programmatic click is the fallback.
			}
		}
		input.click();
		return "input";
	},
	scrollIntoView: sel => {
		requireFirst(sel).scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
	},
	scrollBy: (sel, dx, dy) => {
		const target = sel ? requireFirst(sel) : window;
		target.scrollBy({ left: Number(dx) || 0, top: Number(dy) || 0, behavior: "instant" });
	},
	highlight: (sel, id) => {
		const rect = requireFirst(sel).getBoundingClientRect();
		const overlay = document.createElement("div");
		overlay.id = String(id);
		overlay.dataset.ompHighlightOverlay = "";
		overlay.setAttribute(OVERLAY_ATTR, String(id));
		overlay.setAttribute("aria-hidden", "true");
		overlay.setAttribute("role", "presentation");
		overlay.inert = true;
		Object.assign(overlay.style, {
			position: "fixed",
			left: rect.left - 3 + "px",
			top: rect.top - 3 + "px",
			width: rect.width + 6 + "px",
			height: rect.height + 6 + "px",
			border: "3px solid #ff3366",
			borderRadius: "4px",
			boxSizing: "border-box",
			pointerEvents: "none",
			zIndex: "2147483647",
		});
		document.documentElement.append(overlay);
	},
	removeOverlay,
	observe,
	ariaSnapshot: (root, request, urls) => {
		let rootEl = null;
		if (root) {
			rootEl = first(root);
			if (!rootEl) throw new Error("tab.ariaSnapshot: selector " + JSON.stringify(root) + " matched no element");
		}
		// A fresh bundle instance per snapshot renumbers refs from e1, like the Chromium backend.
		const fresh = loadAria();
		const snapshot = fresh.ariaSnapshot(rootEl, request || {});
		const hrefs = {};
		if (urls) {
			for (const match of snapshot.matchAll(/\[ref=(e\d+)\]/g)) {
				const el = fresh.resolveAriaRef(match[1]);
				if (el && el.localName === "a" && typeof el.href === "string" && el.href) hrefs[match[1]] = el.href;
			}
		}
		return { snapshot, hrefs };
	},
	annotate: ids => {
		const token = "omp-screenshot-" + randomToken();
		const boxes = [];
		const root = document.createElement("div");
		root.setAttribute("data-omp-screenshot-annotations", token);
		root.setAttribute(OVERLAY_ATTR, token);
		root.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none";
		for (const id of ids) {
			const el = registry.get(id);
			if (!el || !el.isConnected) continue;
			const box = boxOf(el);
			if (box.width <= 0 || box.height <= 0) continue;
			boxes.push({ id, x: box.x, y: box.y, width: box.width, height: box.height });
			const outline = document.createElement("div");
			outline.style.cssText =
				"position:absolute;left:" + box.x + "px;top:" + box.y + "px;width:" + box.width + "px;height:" + box.height +
				"px;box-sizing:border-box;border:2px solid #ff2bd6;background:rgba(255,43,214,.08)";
			const label = document.createElement("span");
			label.textContent = "[" + id + "]";
			label.style.cssText =
				"position:absolute;left:-2px;top:-20px;padding:1px 4px;border:1px solid #111;border-radius:3px;background:#ffeb3b;color:#111;font:700 13px/16px ui-monospace,monospace;white-space:nowrap";
			outline.appendChild(label);
			root.appendChild(outline);
		}
		document.documentElement.appendChild(root);
		return { token, boxes };
	},
	mark: sel => {
		const el = first(sel);
		return el ? markElement(el) : null;
	},
	markAll: sel => resolveAll(sel).map(markElement),
	unmark: token => {
		for (const el of pierceAll("[" + HANDLE_ATTR + "~=\"" + CSS.escape(token) + "\"]")) {
			const rest = (el.getAttribute(HANDLE_ATTR) || "").split(/\s+/).filter(value => value && value !== token);
			if (rest.length) el.setAttribute(HANDLE_ATTR, rest.join(" "));
			else el.removeAttribute(HANDLE_ATTR);
		}
	},
	frames: () => {
		const out = [];
		listFrames(window, "", out);
		return out;
	},
	frameOf: sel => {
		const el = requireFirst(sel);
		if (el.localName !== "iframe" && el.localName !== "frame") return null;
		const target = el.contentWindow;
		return target ? findFramePath(window, target, "") : null;
	},
	frameOrigin: index => {
		const child = window[index];
		if (!child) return null;
		const owner = frameElementFor(window, child);
		if (!owner) return null;
		// Only translations keep frame-local CSS px equal to viewport px; anything else cannot be mapped.
		for (let node = owner; node; node = composedParent(node)) {
			const style = getComputedStyle(node);
			const matrix = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
			const linear = matrix.is2D && matrix.a === 1 && matrix.b === 0 && matrix.c === 0 && matrix.d === 1;
			const extra = (style.scale && style.scale !== "none") || (style.rotate && style.rotate !== "none") || (style.zoom && style.zoom !== "1" && style.zoom !== "normal");
			if (!linear || extra) {
				throw new Error("Frame " + index + " sits in a CSS-transformed element (" + (node.localName || "node") + "); input and boxes inside it cannot be mapped to the page");
			}
		}
		const rect = owner.getBoundingClientRect();
		const style = getComputedStyle(owner);
		return {
			x: rect.left + owner.clientLeft + (parseFloat(style.paddingLeft) || 0),
			y: rect.top + owner.clientTop + (parseFloat(style.paddingTop) || 0),
		};
	},
	hasText: (text, root, exact) => {
		let content;
		if (root) {
			const el = first(root);
			if (!el) return false;
			content = el.innerText != null ? el.innerText : el.textContent || "";
		} else {
			content = document.body ? document.body.innerText || "" : "";
		}
		const candidate = String(content).trim();
		return exact ? candidate === text : candidate.includes(text);
	},
	geometry: () => ({
		innerWidth,
		innerHeight,
		dpr: devicePixelRatio,
		scrollX,
		scrollY,
		scrollWidth: document.documentElement.scrollWidth,
		scrollHeight: document.documentElement.scrollHeight,
	}),
	activeEditable: () => isTextEditable(deepActiveElement()),
};

Object.defineProperty(globalThis, "__ompTernKit", { value: kit, configurable: true });

// Child frames announce their index path so omp can address them by name.
if (window !== window.parent) {
	const path = [];
	try {
		for (let win = window; win !== win.parent; win = win.parent) {
			const parent = win.parent;
			let found = -1;
			for (let index = 0; index < parent.length; index++) {
				if (parent[index] === win) {
					found = index;
					break;
				}
			}
			if (found < 0) throw new Error("frame not found in parent");
			path.unshift(found);
		}
		const handler = globalThis.webkit && webkit.messageHandlers && webkit.messageHandlers.stencilFrame;
		if (handler) handler.postMessage(path.join("."));
	} catch {
		// Detached or unreachable frame: nothing to register.
	}
}
`;

/**
 * Script (valid both as a top-level classic script and as a function body) that installs the kit as
 * `globalThis.__ompTernKit` in the current realm if absent and, in a child frame, registers the frame's
 * index path (`"0"`, `"1.0"`, …) via `webkit.messageHandlers.stencilFrame`. Idempotent. Embeds a private
 * instance of the Playwright ARIA bundle and the Chromium semantic query handlers; defines no other
 * globals and uses nothing CSP-gated.
 */
export const TERN_KIT_SOURCE = [
	"(function () {",
	'"use strict";',
	"if (globalThis.__ompTernKit) return;",
	"const loadAria = function () {",
	"var module = { exports: {} };",
	ariaBundle,
	";",
	"return module.exports;",
	"};",
	`const semantic = {\n${SEMANTIC_SOURCE}\n};`,
	`const INTERACTIVE_ROLES = new Set(${JSON.stringify(INTERACTIVE_ROLES)});`,
	`const DEFAULT_STYLES = ${JSON.stringify(DEFAULT_STYLE_PROPERTIES)};`,
	KIT_BODY,
	"})();",
].join("\n");
