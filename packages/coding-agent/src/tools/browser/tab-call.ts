import { renderRunArg } from "../run-code";
import { ToolError } from "../tool-errors";

/** One allowlisted method invocation in a tab call chain. */
export interface TabCallStep {
	method: string;
	args: unknown[];
}

/** Tab helpers whose resolved value is returned directly. */
export const TAB_VALUE_METHODS: readonly string[] = [
	"url",
	"title",
	"goto",
	"observe",
	"ariaSnapshot",
	"screenshot",
	"extract",
	"click",
	"type",
	"fill",
	"press",
	"scroll",
	"drag",
	"scrollIntoView",
	"select",
	"uploadFile",
	"waitForUrl",
	"evaluate",
];

/** Tab helpers whose handle-or-null result is returned as a boolean. */
export const TAB_PRESENCE_METHODS: readonly string[] = ["waitFor", "waitForSelector"];

/** Tab helpers that return an element handle for one subsequent method call. */
export const TAB_HANDLE_METHODS: readonly string[] = ["id", "ref"];

/** Methods allowed on element handles returned by tab.id() and tab.ref(). */
export const ELEMENT_METHODS: readonly string[] = [
	"click",
	"type",
	"fill",
	"press",
	"hover",
	"focus",
	"select",
	"uploadFile",
	"scrollIntoView",
	"boundingBox",
	"isVisible",
	"isHidden",
	"evaluate",
];

const DIRECT_METHODS_DESCRIPTION = [...TAB_VALUE_METHODS, ...TAB_PRESENCE_METHODS].join(", ");
const ELEMENT_METHODS_DESCRIPTION = ELEMENT_METHODS.join(", ");

function renderStep(step: TabCallStep): string {
	return `${step.method}(${step.args.map(renderRunArg).join(", ")})`;
}

function renderElementStep(step: TabCallStep): string {
	if (step.method !== "evaluate" || typeof step.args[0] !== "string") return renderStep(step);
	const [source, ...args] = step.args;
	const renderedArgs = args.map(value => `, ${renderRunArg(value)}`).join("");
	return `evaluate((${source})${renderedArgs})`;
}

/** Render an allowlisted tab helper or element-handle call for browser execution. */
export function renderTabCall(chain: readonly TabCallStep[]): string {
	if (chain.length === 0) {
		throw new ToolError("Action 'call' requires a non-empty 'chain'.");
	}
	if (chain.length > 2) {
		throw new ToolError("Call chains support one element-handle hop at most; use tab.run(fn) for longer sequences.");
	}

	const root = chain[0]!;
	if (TAB_VALUE_METHODS.includes(root.method)) {
		if (chain.length === 2) {
			throw new ToolError(`Only tab.id(n)/tab.ref(id) results accept a chained call; got tab.${root.method}().`);
		}
		return `return await tab.${renderStep(root)};`;
	}
	if (TAB_PRESENCE_METHODS.includes(root.method)) {
		if (chain.length === 2) {
			throw new ToolError(`Only tab.id(n)/tab.ref(id) results accept a chained call; got tab.${root.method}().`);
		}
		return `return (await tab.${renderStep(root)}) !== null;`;
	}
	if (TAB_HANDLE_METHODS.includes(root.method)) {
		if (chain.length === 1) {
			throw new ToolError(
				`tab.${root.method}() returns an element handle; call a method on it (tab.id(5).click()) or use tab.run(fn).`,
			);
		}
		const element = chain[1]!;
		if (!ELEMENT_METHODS.includes(element.method)) {
			throw new ToolError(
				`Unknown element method "${element.method}". Element handles support: ${ELEMENT_METHODS_DESCRIPTION}.`,
			);
		}
		return `return await (await tab.${renderStep(root)}).${renderElementStep(element)};`;
	}

	throw new ToolError(
		`Unknown tab helper "${root.method}". Direct helpers: ${DIRECT_METHODS_DESCRIPTION}; element handles via tab.id(n)/tab.ref(id).`,
	);
}
