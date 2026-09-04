import { renderRunArg } from "../run-code";
import { ToolError } from "../tool-errors";

/** One allowlisted method invocation in a computer call chain. */
export interface ComputerCallStep {
	method: string;
	args: unknown[];
}

/** Approval tier a direct computer helper needs: inspection reads, input and mutation execute. */
export type ComputerCallPolicy = "read" | "exec";

type MethodPolicies = Readonly<Record<string, ComputerCallPolicy>>;

/** Helpers callable on the `desktop` root; `window` and `ref` also anchor one-hop handle chains. */
export const DESKTOP_METHODS: MethodPolicies = {
	capabilities: "read",
	displays: "read",
	windows: "read",
	window: "read",
	focusedWindow: "read",
	screenshot: "read",
	click: "exec",
	doubleClick: "exec",
	move: "exec",
	drag: "exec",
	scroll: "exec",
	type: "exec",
	press: "exec",
	elementAt: "read",
	focusedElement: "read",
	ref: "read",
	"clipboard.read": "read",
	"clipboard.write": "exec",
};

/** Helpers callable on a window handle resolved through `desktop.window(id)`. */
export const WINDOW_METHODS: MethodPolicies = {
	screenshot: "read",
	click: "exec",
	doubleClick: "exec",
	move: "exec",
	drag: "exec",
	scroll: "exec",
	type: "exec",
	press: "exec",
	raise: "exec",
	ax: "read",
	find: "read",
	ref: "read",
};

/** Helpers callable on an AX element handle resolved through `desktop.ref(ref)`. */
export const ELEMENT_METHODS: MethodPolicies = {
	value: "read",
	setValue: "exec",
	bounds: "read",
	attributes: "read",
	actions: "read",
	perform: "exec",
	press: "exec",
	click: "exec",
	focus: "exec",
	parent: "read",
	children: "read",
};

/** Root methods whose result accepts one chained handle call, mapped to the handle's method table. */
const HANDLE_ROOTS: Readonly<Record<string, { label: string; methods: MethodPolicies }>> = {
	window: { label: "window", methods: WINDOW_METHODS },
	ref: { label: "element", methods: ELEMENT_METHODS },
};

function describe(methods: MethodPolicies): string {
	return Object.keys(methods).join(", ");
}

function renderStep(step: ComputerCallStep): string {
	return `${step.method}(${step.args.map(renderRunArg).join(", ")})`;
}

function validateChain(chain: readonly ComputerCallStep[]): void {
	if (chain.length === 0) {
		throw new ToolError("Action 'call' requires a non-empty 'chain'.");
	}
	if (chain.length > 2) {
		throw new ToolError("Call chains support one handle hop at most; use computer.run(fn) for longer sequences.");
	}
	const root = chain[0]!;
	if (!Object.hasOwn(DESKTOP_METHODS, root.method)) {
		throw new ToolError(
			`Unknown desktop method "${root.method}". Desktop helpers support: ${describe(DESKTOP_METHODS)}.`,
		);
	}
	if (chain.length === 1) return;
	const handle = Object.hasOwn(HANDLE_ROOTS, root.method) ? HANDLE_ROOTS[root.method] : undefined;
	if (!handle) {
		throw new ToolError(
			`Only desktop.window(id)/desktop.ref(ref) results accept a chained call; got desktop.${root.method}().`,
		);
	}
	const step = chain[1]!;
	if (!Object.hasOwn(handle.methods, step.method)) {
		throw new ToolError(
			`Unknown ${handle.label} method "${step.method}". ${handle.label[0]!.toUpperCase()}${handle.label.slice(1)} handles support: ${describe(handle.methods)}.`,
		);
	}
}

/** Whether every step of a direct computer call is inspection-only, so the run needs read approval. */
export function isReadOnlyComputerCall(chain: readonly ComputerCallStep[]): boolean {
	validateChain(chain);
	const root = chain[0]!;
	if (chain.length === 1) return DESKTOP_METHODS[root.method] === "read";
	return HANDLE_ROOTS[root.method]!.methods[chain[1]!.method] === "read";
}

/** Render an allowlisted desktop helper or handle call for the persistent computer runtime. */
export function renderComputerCall(chain: readonly ComputerCallStep[]): string {
	validateChain(chain);
	const root = chain[0]!;
	if (chain.length === 1) return `return await desktop.${renderStep(root)};`;
	return `return await (await desktop.${renderStep(root)}).${renderStep(chain[1]!)};`;
}
