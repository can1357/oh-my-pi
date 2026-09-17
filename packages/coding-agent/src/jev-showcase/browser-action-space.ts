/**
 * Dynamic browser operation/target heads — ported from browser-use/jev-ultrafast model.py.
 * One index per DOM node; each operation gets its own compatible target Choice criteria.
 */

export interface BrowserActionWire {
	id: string;
	kind: string;
	label: string;
	role?: string;
	value?: string;
	node?: number;
	checked?: string;
	selected?: boolean;
	expanded?: boolean;
	current_value?: string;
}

export interface BrowserElementIndex {
	index: string;
	label: string;
	role?: string;
	value?: string;
	checked?: string;
	selected?: boolean;
	expanded?: boolean;
	operations: string[];
	options?: Array<{ index: string; label: string; value: string }>;
}

export interface BrowserActionSpace {
	elements: BrowserElementIndex[];
	targets: Record<string, Record<string, BrowserActionWire>>;
	controls: Record<string, BrowserActionWire>;
}

const OPERATIONS: Record<string, string> = {
	click: "CLICK",
	fill: "TYPE_TEXT",
	select: "SELECT",
};

/** Build the indexed element table and per-operation target maps from a DOM snapshot. */
export function buildBrowserActionSpace(actions: readonly BrowserActionWire[]): BrowserActionSpace {
	const elements: BrowserElementIndex[] = [];
	const indices = new Map<number, string>();
	const targets: Record<string, Record<string, BrowserActionWire>> = {};
	const controls: Record<string, BrowserActionWire> = {};

	for (const action of actions) {
		const kind = action.kind;
		if (!(kind in OPERATIONS)) {
			controls[action.id.toUpperCase()] = action;
			continue;
		}
		const node = action.node;
		if (node === undefined) continue;

		let index = indices.get(node);
		if (index === undefined) {
			index = String(elements.length + 1);
			indices.set(node, index);
			const element: BrowserElementIndex = {
				index,
				label: action.label.split(" → ")[0] ?? action.label,
				operations: [],
			};
			if (action.role !== undefined) element.role = action.role;
			if (action.value !== undefined) element.value = action.value;
			if (action.checked !== undefined) element.checked = action.checked;
			if (action.selected !== undefined) element.selected = action.selected;
			if (action.expanded !== undefined) element.expanded = action.expanded;
			if (kind === "select") {
				element.value = action.current_value ?? "";
				element.options = [];
			}
			elements.push(element);
		}

		const operation = OPERATIONS[kind]!;
		const group = (targets[operation] ??= {});
		const element = elements[Number(index) - 1]!;
		if (!element.operations.includes(operation)) element.operations.push(operation);

		let targetKey = index;
		if (kind === "select") {
			targetKey = `${index}:${(element.options?.length ?? 0) + 1}`;
			element.options ??= [];
			element.options.push({ index: targetKey, label: action.label, value: action.value ?? "" });
		}
		group[targetKey] = action;
	}

	return { elements, targets, controls };
}

/** Resolve operation + target indices to the underlying action id (jev-ultrafast choose()). */
export function resolveBrowserDecision(
	operation: string,
	target: string | undefined,
	space: BrowserActionSpace,
): string {
	if (operation in space.targets) {
		const candidates = space.targets[operation];
		if (!target || !(target in candidates)) {
			throw new Error("Invalid TypeSafe response; no action executed.");
		}
		return candidates[target]!.id;
	}
	if (operation in space.controls) return space.controls[operation]!.id;
	return operation;
}

/** Fixture page state from jev-ultrafast tests/test_agent.py. */
export function demoBrowserPage(): {
	url: string;
	title: string;
	text: string;
	actions: BrowserActionWire[];
} {
	return {
		url: "https://example.test/",
		title: "Search",
		text: "Search",
		actions: [
			{ id: "e1", kind: "fill", label: "Search", role: "textbox", value: "", node: 10 },
			{ id: "e2", kind: "click", label: "Open Search", role: "textbox", value: "", node: 10 },
			{ id: "e3", kind: "click", label: "Go", role: "button", value: "", node: 20 },
			{ id: "wait", kind: "wait", label: "Wait" },
		],
	};
}
