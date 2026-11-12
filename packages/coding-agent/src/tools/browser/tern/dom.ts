/**
 * Native DOM reads of a Tern whose engine answers them (the `dom` browser op,
 * listed in the welcome's `ops`): the read protocol's request and reply
 * shapes (`snapshot`, `resolve`, `query`, `wait`), the reply check, and the
 * pure mappings between the tab API's shapes (selectors, observations) and the
 * protocol's. The engine only reads: nothing is evaluated, injected or
 * stamped in the page, and every action stays trusted `input`.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { parseRoleSelector, type RoleQuery } from "../query-handlers";
import type { Observation, ObservationEntry } from "../tab-protocol";
import { INTERACTIVE_ROLES } from "./page-kit";
import type { TernSelector } from "./selectors";
import { TernError } from "./wire";

/** Attribute the page kit stamps handle tokens on; the bridge between kit elements and engine refs. */
export const HANDLE_ATTRIBUTE = "data-omp-tern-handle";

/**
 * An engine node: valid while the node lives in its web process, never reused.
 * A dead ref reads as `detached`, never as another node.
 */
export type DomRef = string;

/** `[x, y]` in CSS px of the main frame's viewport (the space pointer and wheel input use). */
export type DomPoint = [x: number, y: number];

/** `[x, y, width, height]` in CSS px of the main frame's viewport. */
export type DomRect = [x: number, y: number, width: number, height: number];

/** Per-node extras a `query` adds on request. */
export type DomInclude = "text" | "html" | "value" | "attributes" | "checked";

/** One node of a read. Text leaves (`role: "text"`, `includeAll` snapshots only) have no `ref`. */
export interface DomNode {
	ref?: DomRef;
	tag?: string;
	/** Computed ARIA role (`generic` when none). */
	role: string;
	name?: string;
	value?: string;
	description?: string;
	keyshortcuts?: string;
	states?: string[];
	rect: DomRect;
	/** A frame owner; its document's nodes are its `children`. */
	frame?: boolean;
	children?: DomNode[];
	/** Rendered text (`include: "text"`). */
	text?: string;
	/** Outer HTML (`include: "html"`). */
	html?: string;
	/** Every attribute (`include: "attributes"`). */
	attributes?: Record<string, string>;
	/** Checked state of a checkable node (`include: "checked"`); absent on any other node. */
	checked?: boolean | "mixed";
}

/** The wheel that brings a node into view: dispatch it at `at`, then resolve again. */
export interface DomScroll {
	at: DomPoint;
	dx: number;
	dy: number;
}

export interface DomSnapshotRequest {
	read: "snapshot";
	root?: DomRef;
	includeAll?: boolean;
	viewportOnly?: boolean;
	limit?: number;
}

export interface DomSnapshot {
	url: string;
	title: string;
	viewport: { width: number; height: number; scale: number };
	scroll: { x: number; y: number; width: number; height: number; scrollWidth: number; scrollHeight: number };
	nodes: DomNode[];
	truncated: boolean;
}

/** What `resolve` checks actionability for; `none` only requires a rendered node with a point in view. */
export type DomResolveAction = "click" | "hover" | "type" | "none";

export interface DomResolveRequest {
	read: "resolve";
	ref: DomRef;
	action?: DomResolveAction;
	/** Consecutive rendering updates the rect must stay identical for; `0` skips the check. */
	stable?: number;
	/** How long the engine waits for a stable rect, in ms. */
	timeout?: number;
}

/** Outcome of a `resolve`, in the order the engine checks them. */
export type DomResolveState =
	| "detached"
	| "hidden"
	| "disabled"
	| "notEditable"
	| "offViewport"
	| "unstable"
	| "covered"
	| "ok";

export interface DomResolved {
	state: DomResolveState;
	/** The node without `children`; absent only when `detached`. */
	node?: DomNode;
	/** Where to click or hover (`ok`), or where the hit test landed elsewhere (`covered`). */
	point?: DomPoint;
	/** The visible part of the node (`ok`). */
	rect?: DomRect;
	/** `offViewport`: the wheel to send. `covered`: a wheel that would centre the node, worth one retry. */
	scroll?: DomScroll;
	coveredBy?: DomNode;
}

/** What a `query` (or the `for` of a `wait`) matches. */
export interface DomQuery {
	by: "css" | "xpath" | "text" | "role" | "label" | "attribute" | "ref";
	/** Selector, expression, text, role, attribute value or ref; a `role` query without it matches any role by `name`. */
	value?: string;
	/** Accessible-name filter of a `role` query. */
	name?: string;
	/** Attribute name of an `attribute` query. */
	attribute?: string;
	/** Equality instead of substring matching. */
	exact?: boolean;
	/** Limits the read to this node's subtree; a frame owner stands for its content document. */
	root?: DomRef;
	visibleOnly?: boolean;
	limit?: number;
	include?: DomInclude[];
}

export interface DomQueryRequest extends DomQuery {
	read: "query";
}

/** Matches in document order, without `children`; `total` counts all of them before `limit`. */
export interface DomMatches {
	nodes: DomNode[];
	total: number;
}

export type DomWaitState = "visible" | "attached" | "hidden" | "detached";

export interface DomWaitRequest {
	read: "wait";
	for: DomQuery;
	state?: DomWaitState;
	timeout?: number;
}

/** A timeout is `matched: false`, not an error; `nodes` lists the matches of an `attached`/`visible` wait. */
export interface DomWaited {
	matched: boolean;
	nodes?: DomNode[];
}

export type DomRequest = DomSnapshotRequest | DomResolveRequest | DomQueryRequest | DomWaitRequest;

interface DomReplies {
	snapshot: DomSnapshot;
	resolve: DomResolved;
	query: DomMatches;
	wait: DomWaited;
}

/** The reply of request `R`. */
export type DomReply<R extends DomRequest> = DomReplies[R["read"]];

/**
 * The engine's reply to `request` out of the `dom` op's `ok`. An
 * `{ error: { kind, message } }` reply (unknown read, malformed field, bad
 * selector) throws a {@link TernError} carrying the engine's message.
 * `product` names the backend in the error for a reply that is no object.
 */
export function domReply<R extends DomRequest>(product: string, request: R, answer: unknown): DomReply<R> {
	if (!isRecord(answer)) {
		throw new TernError("protocol", `${product} answered dom ${request.read} without a reply object`);
	}
	if (isRecord(answer.error)) {
		const message = typeof answer.error.message === "string" ? answer.error.message : `dom ${request.read} failed`;
		throw new TernError(answer.error.kind === "invalid" ? "invalid" : "failed", message);
	}
	return answer as unknown as DomReply<R>;
}

/** Selectors that name one element by reference instead of describing what to match. */
type ReferenceEngine = "ariaRef" | "id";

/**
 * The query matching what `selector` selects. Reads pierce shadow roots, so
 * `pierce/` is plain CSS; `aria/` compares names exactly as the kit does and
 * may name no role; the semantic handlers keep their substring matching
 * (`testid/` its equality).
 */
export function domQueryFor(selector: Exclude<TernSelector, { engine: ReferenceEngine }>): DomQuery {
	switch (selector.engine) {
		case "css":
		case "pierce":
			return { by: "css", value: selector.query };
		case "text":
			return { by: "text", value: selector.query };
		case "xpath":
			return { by: "xpath", value: selector.query };
		case "aria":
			return {
				by: "role",
				...(selector.role === undefined ? {} : { value: selector.role }),
				...(selector.name === undefined ? {} : { name: selector.name.replace(/\s+/g, " ").trim(), exact: true }),
			};
		case "role": {
			let role: RoleQuery;
			try {
				role = parseRoleSelector(selector.query);
			} catch (error) {
				throw new ToolError(error instanceof Error ? error.message : String(error));
			}
			return {
				by: "role",
				value: role.role,
				...(role.name === undefined ? {} : { name: role.name, ...(role.exact ? { exact: true } : {}) }),
			};
		}
		case "label":
			return { by: "label", value: selector.query.trim() };
		case "placeholder":
		case "alt":
		case "title":
			return { by: "attribute", attribute: selector.engine, value: selector.query.trim() };
		case "testid":
			return { by: "attribute", attribute: "data-testid", value: selector.query.trim(), exact: true };
		case "handle":
			return { by: "attribute", attribute: HANDLE_ATTRIBUTE, value: selector.token };
		case "ref":
			return { by: "ref", value: selector.ref };
	}
}

/** Roles whose checked state an observation always spells out. */
const CHECKABLE_ROLES: Readonly<Record<string, true>> = {
	checkbox: true,
	radio: true,
	switch: true,
	menuitemcheckbox: true,
	menuitemradio: true,
};

/** Roles whose value an observation reports as a number. */
const NUMERIC_VALUE_ROLES: Readonly<Record<string, true>> = {
	slider: true,
	spinbutton: true,
	progressbar: true,
	meter: true,
};

/** Unnamed wrappers a compact observation drops when nothing in them is interactive. */
const STRUCTURAL_ROLES: Readonly<Record<string, true>> = { generic: true, none: true, group: true };

const INTERACTIVE_ROLE_SET: ReadonlySet<string> = new Set(INTERACTIVE_ROLES);

/** Engine states an observation passes through as they are, in the order the other backends list them. */
const PLAIN_STATES = ["required", "readonly", "multiselectable", "multiline", "modal", "focused"] as const;
const EXTRA_STATES = ["invalid", "haspopup", "busy"] as const;

/** The node's engine states in the observation vocabulary (`checked=true`, `expanded=false`, `disabled`, …). */
function observationStates(node: DomNode): string[] {
	const has = new Set(node.states ?? []);
	const states: string[] = [];
	if (has.has("disabled")) states.push("disabled");
	if (has.has("mixed")) states.push("checked=mixed");
	else if (has.has("checked")) states.push("checked=true");
	else if (CHECKABLE_ROLES[node.role]) states.push("checked=false");
	if (has.has("pressed")) states.push("pressed=true");
	if (has.has("selected")) states.push("selected=true");
	else if (node.role === "option") states.push("selected=false");
	if (has.has("expanded")) states.push("expanded=true");
	else if (has.has("collapsed")) states.push("expanded=false");
	for (const state of PLAIN_STATES) if (has.has(state)) states.push(state);
	for (const state of EXTRA_STATES) if (has.has(state)) states.push(state);
	return states;
}

function isInteractive(node: DomNode): boolean {
	return (
		INTERACTIVE_ROLE_SET.has(node.role) ||
		(node.states ?? []).some(state => state === "clickable" || state === "editable" || state === "focused")
	);
}

/** A snapshot as the tab API's observation, with what each numeric id stands for. */
export interface DomObservation {
	observation: Observation;
	/** Observation id → engine ref. */
	refs: Map<number, DomRef>;
	/** Observation id → the node's box in the main frame's viewport. */
	rects: Map<number, DomRect>;
}

/**
 * Map a snapshot's forest to observation entries, depth-first; ids number
 * the entries from 1. Text leaves are skipped. `compact` drops unnamed
 * structural wrappers with nothing interactive in them.
 */
export function observationFrom(snapshot: DomSnapshot, opts: { compact: boolean }): DomObservation {
	const collected: Array<{ node: DomNode; ref: DomRef; drop: boolean }> = [];
	const visit = (node: DomNode): boolean => {
		if (node.ref === undefined) return false;
		const item = { node, ref: node.ref, drop: false };
		collected.push(item);
		let below = false;
		for (const child of node.children ?? []) {
			if (visit(child)) below = true;
		}
		const interactive = isInteractive(node);
		item.drop = opts.compact && !node.name && !interactive && !below && STRUCTURAL_ROLES[node.role] === true;
		return interactive || below;
	};
	for (const node of snapshot.nodes) visit(node);
	const refs = new Map<number, DomRef>();
	const rects = new Map<number, DomRect>();
	const elements: ObservationEntry[] = [];
	for (const { node, ref, drop } of collected) {
		if (drop) continue;
		const id = elements.length + 1;
		refs.set(id, ref);
		rects.set(id, node.rect);
		const entry: ObservationEntry = { id, role: node.role, states: observationStates(node) };
		if (node.name) entry.name = node.name;
		if (node.value !== undefined && node.value !== "") {
			const number = NUMERIC_VALUE_ROLES[node.role] ? Number(node.value) : Number.NaN;
			entry.value = Number.isFinite(number) ? number : node.value;
		}
		if (node.description) entry.description = node.description;
		if (node.keyshortcuts) entry.keyshortcuts = node.keyshortcuts;
		elements.push(entry);
	}
	return {
		observation: {
			url: snapshot.url,
			title: snapshot.title,
			viewport: {
				width: snapshot.viewport.width,
				height: snapshot.viewport.height,
				deviceScaleFactor: snapshot.viewport.scale,
			},
			scroll: { ...snapshot.scroll },
			elements,
		},
		refs,
		rects,
	};
}

/** A node for failure messages: `div[role=dialog] "Cookie settings"`. */
export function describeDomNode(node: DomNode): string {
	const tag = node.tag ?? node.role;
	const role = node.role !== tag && node.role !== "generic" ? `[role=${node.role}]` : "";
	return `${tag}${role}${node.name ? ` ${JSON.stringify(node.name)}` : ""}`;
}

/**
 * The inner HTML of a node whose outer HTML is `outer` (the reads report
 * outer HTML only): the text between its start tag and its end tag, empty for
 * a void element.
 */
export function innerHtmlOf(outer: string, tag: string): string {
	// Serialized attribute values are always double-quoted, with `"` inside them escaped.
	let quoted = false;
	let open = -1;
	for (let index = 0; index < outer.length; index++) {
		const char = outer[index];
		if (char === '"') {
			quoted = !quoted;
		} else if (char === ">" && !quoted) {
			open = index;
			break;
		}
	}
	if (open < 0) return "";
	const close = `</${tag}>`;
	const end = outer.length - close.length;
	if (end <= open || outer.slice(end).toLowerCase() !== close.toLowerCase()) return "";
	return outer.slice(open + 1, end);
}

const SIMPLE_NAME = /^[A-Za-z_][\w-]*$/;
const CANDIDATE_VALUE_LIMIT = 200;

/** `value` as the content of a double-quoted CSS string. */
function cssStringContent(value: string): string {
	let out = "";
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (char === '"' || char === "\\") out += `\\${char}`;
		else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(16)} `;
		else out += char;
	}
	return out;
}

/**
 * A CSS selector matching `node` by its tag and attributes: the candidates
 * the page kit marks when a kit-only helper has to reach a node the engine
 * named. It may match other elements too; the engine says which candidate is
 * the node. Attributes CSS cannot name plainly, long values and the handle
 * attribute itself are left out.
 */
export function domCandidateSelector(node: DomNode): string {
	let selector = node.tag && SIMPLE_NAME.test(node.tag) ? node.tag : "*";
	const attributes = node.attributes ?? {};
	for (const name in attributes) {
		const value = attributes[name]!;
		if (name === HANDLE_ATTRIBUTE || !SIMPLE_NAME.test(name) || value.length > CANDIDATE_VALUE_LIMIT) continue;
		selector += `[${name}="${cssStringContent(value)}"]`;
	}
	return selector;
}
