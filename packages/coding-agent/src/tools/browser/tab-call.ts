import { renderCallChain, renderRunArg } from "../run-code";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

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
	"back",
	"forward",
	"reload",
	"pushState",
	"frames",
	"dialog",
	"handleDialog",
	"setDialogs",
	"observe",
	"ariaSnapshot",
	"a11y",
	"webmcpList",
	"webmcpInvoke",
	"webmcpEvents",
	"screenshot",
	"diffScreenshot",
	"pdf",
	"extract",
	"click",
	"dblclick",
	"hover",
	"focus",
	"check",
	"uncheck",
	"keyDown",
	"keyUp",
	"mouseMove",
	"mouseDown",
	"mouseUp",
	"clickAt",
	"wheel",
	"highlight",
	"type",
	"fill",
	"press",
	"scroll",
	"drag",
	"scrollIntoView",
	"select",
	"uploadFile",
	"waitForUrl",
	"text",
	"html",
	"value",
	"attr",
	"count",
	"box",
	"styles",
	"isVisible",
	"isEnabled",
	"isChecked",
	"waitForText",
	"evaluate",
	"emulate",
	"devices",
	"clipboardRead",
	"clipboardWrite",
	"clipboardCopy",
	"clipboardPaste",
	"cookies",
	"setCookies",
	"clearCookies",
	"storage",
	"setStorage",
	"clearStorage",
	"saveState",
	"loadState",
	"addInitScript",
	"removeInitScript",
	"initScripts",
	"waitForDownload",
	"downloads",
	"console",
	"errors",
	"clearConsole",
	"traceStart",
	"traceStop",
	"profileStart",
	"profileStop",
	"metrics",
	"route",
	"unroute",
	"routes",
	"requests",
	"request",
	"clearRequests",
	"harStart",
	"harStop",
	"allowedDomains",
	"vitals",
	"reactEnable",
	"reactTree",
	"reactInspect",
	"reactRenders",
	"reactSuspense",
	"recordStart",
	"recordStop",
	"recordRestart",
	"recording",
];

/** Tab helpers whose handle-or-null result is returned as a boolean. */
export const TAB_PRESENCE_METHODS: readonly string[] = ["waitFor", "waitForSelector"];

/** Tab helpers that return an element or frame handle for one subsequent method call. */
export const TAB_HANDLE_METHODS: readonly string[] = ["id", "ref", "frame"];

/** Methods allowed on element handles returned by tab.id() and tab.ref(). */
export const ELEMENT_METHODS: readonly string[] = [
	"click",
	"dblclick",
	"check",
	"uncheck",
	"highlight",
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
	"text",
	"html",
	"value",
	"attr",
	"styles",
	"isEnabled",
	"isChecked",
	"evaluate",
];

/** Methods allowed on frame handles returned by tab.frame(). */
export const FRAME_METHODS: readonly string[] = [
	"click",
	"fill",
	"type",
	"press",
	"text",
	"html",
	"value",
	"attr",
	"count",
	"isVisible",
	"ariaSnapshot",
	"evaluate",
	"waitFor",
	"waitForSelector",
	"screenshot",
];

const DIRECT_METHODS_DESCRIPTION = [...TAB_VALUE_METHODS, ...TAB_PRESENCE_METHODS].join(", ");
const ELEMENT_METHODS_DESCRIPTION = ELEMENT_METHODS.join(", ");
const FRAME_METHODS_DESCRIPTION = FRAME_METHODS.join(", ");

function renderElementStep(step: TabCallStep): string {
	if (step.method !== "evaluate" || typeof step.args[0] !== "string") return renderCallChain([step]);
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
			throw new ToolError(
				`Only tab.id(n)/tab.ref(id)/tab.frame(selector) results accept a chained call; got tab.${root.method}().`,
			);
		}
		return `return await tab.${renderCallChain([root])};`;
	}
	if (TAB_PRESENCE_METHODS.includes(root.method)) {
		if (chain.length === 2) {
			throw new ToolError(
				`Only tab.id(n)/tab.ref(id)/tab.frame(selector) results accept a chained call; got tab.${root.method}().`,
			);
		}
		return `return (await tab.${renderCallChain([root])}) !== null;`;
	}
	if (TAB_HANDLE_METHODS.includes(root.method)) {
		const frameHandle = root.method === "frame";
		if (chain.length === 1) {
			throw new ToolError(
				frameHandle
					? 'tab.frame() returns a frame handle; call a method on it (tab.frame("#pay").click("#submit")) or use tab.run(fn).'
					: `tab.${root.method}() returns an element handle; call a method on it (tab.id(5).click()) or use tab.run(fn).`,
			);
		}
		const handleStep = chain[1]!;
		const methods = frameHandle ? FRAME_METHODS : ELEMENT_METHODS;
		if (!methods.includes(handleStep.method)) {
			const description = frameHandle ? FRAME_METHODS_DESCRIPTION : ELEMENT_METHODS_DESCRIPTION;
			throw new ToolError(
				`Unknown ${frameHandle ? "frame" : "element"} method "${handleStep.method}". ${frameHandle ? "Frame" : "Element"} handles support: ${description}.`,
			);
		}
		return `return await (await tab.${renderCallChain([root])}).${renderElementStep(handleStep)};`;
	}

	throw new ToolError(
		`Unknown tab helper "${root.method}". Direct helpers: ${DIRECT_METHODS_DESCRIPTION}; handles via tab.id(n)/tab.ref(id)/tab.frame(selector).`,
	);
}
