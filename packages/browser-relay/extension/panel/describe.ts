/**
 * Claude-style step labels: turn a tool call's arguments into “Clicked “Merge pull request””, “Typed in Search”,
 * “Ran `bun test`”. Browser steps are read out of the eval/browser code the agent wrote, since omp drives tabs
 * through `tab.click(…)`-style helpers rather than one tool per action.
 */
import { INTENT_FIELD, toolIntentLabel } from "@oh-my-pi/pi-wire";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { hostOf } from "./tab-context";

/** Which glyph a step row shows. */
export type StepIcon =
	| "click"
	| "type"
	| "scroll"
	| "navigate"
	| "screenshot"
	| "terminal"
	| "file"
	| "search"
	| "page"
	| "wait"
	| "agent"
	| "ask"
	| "plan"
	| "tool";

/** A point in the coordinate space of the step's screenshot. */
export interface Point {
	x: number;
	y: number;
}

/** What a step row, the working row, the page tag and a GIF frame say about one tool call. */
export interface StepDescription {
	icon: StepIcon;
	/** Past tense, shown once the step finished: “Clicked “Checks””. */
	done: string;
	/** Progressive, shown while it runs: “Clicking “Checks””. */
	live: string;
	/** Where the agent clicked, when the code names coordinates. */
	point?: Point;
	/** Drag endpoints, when the code names coordinates. */
	drag?: { from: Point; to: Point };
	/** Marker kind for GIF export. */
	motion?: "click" | "drag" | "scroll" | "type";
}

const MAX_TARGET = 48;

function clip(text: string, max = MAX_TARGET): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

function field(args: Record<string, unknown>, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return null;
}

/** A URL as people say it: host plus a short path. */
function sayUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname === "/" ? "" : parsed.pathname;
		return clip(`${hostOf(url)}${path}`);
	} catch {
		return clip(url);
	}
}

/**
 * A selector as people say it: the accessible name or text a selector asks for when it has one (quoted), else the
 * selector itself as code. Null when the argument was not a string literal.
 */
function sayTarget(literal: string | null): { text: string; named: boolean } | null {
	if (literal === null) return null;
	const named =
		/^(?:text|aria|label|placeholder)\s*[=/]\s*(.+)$/i.exec(literal) ??
		/::-p-(?:text|aria)\(\s*["']?(.+?)["']?\s*\)/.exec(literal) ??
		/\[(?:aria-label|placeholder|title|name|alt)[*^$~|]?=\s*["']?([^"'\]]+)["']?\s*\]/.exec(literal) ??
		/:(?:has-text|text|contains)\(\s*["'](.+?)["']\s*\)/.exec(literal);
	if (named !== null) return { text: clip(named[1].replace(/^["']|["']$/g, "")), named: true };
	return { text: clip(literal), named: false };
}

function quoted(target: { text: string; named: boolean }): string {
	return target.named ? `“${target.text}”` : `\`${target.text}\``;
}

interface BrowserCall {
	method: string;
	/** Raw argument source up to the matching close paren. */
	args: string;
	/** `tab.id(12).click()` / `tab.ref("e5").click()` receivers. */
	handle: string | null;
}

const BROWSER_METHODS =
	"clickAt|click|dblclick|hover|check|uncheck|fill|type|press|select|uploadFile|scroll|drag|goto|back|forward|reload|open|" +
	"screenshot|observe|ariaSnapshot|extract|text|html|waitForSelector|waitForText|waitForUrl|waitForNavigation|waitFor|" +
	"waitForDownload|evaluate|run|close";
const CALL = new RegExp(`(?:\\.(?:id|ref)\\(\\s*([^)]*?)\\s*\\))?\\.(${BROWSER_METHODS})\\(`, "g");

/** What makes a call the headline of a multi-call cell: the last thing that changed the page wins over reads. */
const ACTION =
	/^(?:clickAt|click|dblclick|hover|check|uncheck|fill|type|press|select|uploadFile|scroll|drag|goto|back|forward|reload|open)$/;

/** Source text of a call's arguments, honouring nested parens and string literals. */
function argsSource(code: string, from: number): string {
	let depth = 1;
	let quote: string | null = null;
	for (let i = from; i < code.length; i++) {
		const ch = code[i];
		if (quote !== null) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return code.slice(from, i);
	}
	return code.slice(from);
}

function browserCalls(code: string): BrowserCall[] {
	// Only code that talks to a tab: `browser.open`, `tab.…`, `page.…`.
	if (!/\b(?:browser|tab|page)\b/.test(code)) return [];
	const calls: BrowserCall[] = [];
	for (const match of code.matchAll(CALL)) {
		const method = match[2];
		const before = code.slice(Math.max(0, match.index - 24), match.index);
		// `text`, `run`, `open`, `close`, `type` are common words; require a tab-ish receiver for the ambiguous ones.
		if (
			(method === "open" || method === "close") &&
			!/\bbrowser\s*$/.test(before) &&
			!/\b(?:tab|page)\w*\s*$/.test(before)
		)
			continue;
		if (
			match[1] === undefined &&
			(method === "text" || method === "run" || method === "type" || method === "select" || method === "check") &&
			!/(?:\btab\w*|\bpage\w*|\bframe\w*|\))\s*$/i.test(before)
		)
			continue;
		calls.push({
			method,
			args: argsSource(code, match.index + match[0].length),
			handle: match[1] === undefined ? null : match[1].replace(/^["'`]|["'`]$/g, ""),
		});
	}
	return calls;
}

/** The first string literal among a call's arguments, at argument position `index`. */
function literalArg(args: string, index = 0): string | null {
	let position = 0;
	let depth = 0;
	for (let i = 0; i < args.length; i++) {
		const ch = args[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			let end = i + 1;
			while (end < args.length && args[end] !== ch) end += args[end] === "\\" ? 2 : 1;
			if (depth === 0 && position === index) return args.slice(i + 1, end).replace(/\\(.)/g, "$1");
			i = end;
		} else if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 0) position++;
	}
	return null;
}

function numbers(args: string): number[] {
	return [...args.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
}

function describeBrowserCall(call: BrowserCall, title: string | null): StepDescription {
	const target = sayTarget(literalArg(call.args));
	// An observed id or aria ref says nothing to a reader; the cell's own title does.
	const anonymous = target === null || (call.handle !== null && !target.named);
	const on = (verbDone: string, verbLive: string, icon: StepIcon, motion?: StepDescription["motion"]) => {
		if (target !== null && call.handle === null)
			return { icon, done: `${verbDone} ${quoted(target)}`, live: `${verbLive} ${quoted(target)}`, motion };
		if (anonymous && title !== null) return { icon, done: title, live: title, motion };
		return { icon, done: `${verbDone} an element`, live: `${verbLive} an element`, motion };
	};
	switch (call.method) {
		case "click":
		case "check":
		case "uncheck":
			return on("Clicked", "Clicking", "click", "click");
		case "dblclick":
			return on("Double-clicked", "Double-clicking", "click", "click");
		case "hover":
			return on("Hovered over", "Hovering over", "click");
		case "clickAt": {
			const [x, y] = numbers(call.args);
			if (x === undefined || y === undefined)
				return { icon: "click", done: title ?? "Clicked", live: title ?? "Clicking", motion: "click" };
			return {
				icon: "click",
				done: title ?? `Clicked at ${Math.round(x)}, ${Math.round(y)}`,
				live: title ?? `Clicking at ${Math.round(x)}, ${Math.round(y)}`,
				point: { x, y },
				motion: "click",
			};
		}
		case "fill":
		case "type": {
			if (target !== null && call.handle === null)
				return {
					icon: "type",
					done: `Typed in ${target.named ? target.text : quoted(target)}`,
					live: `Typing in ${target.named ? target.text : quoted(target)}`,
					motion: "type",
				};
			return { icon: "type", done: title ?? "Typed text", live: title ?? "Typing", motion: "type" };
		}
		case "press": {
			const key = literalArg(call.args);
			return {
				icon: "type",
				done: key === null ? "Pressed a key" : `Pressed ${clip(key, 24)}`,
				live: key === null ? "Pressing a key" : `Pressing ${clip(key, 24)}`,
				motion: "type",
			};
		}
		case "select": {
			const value = literalArg(call.args, call.handle === null ? 1 : 0);
			return {
				icon: "click",
				done: value === null ? "Selected an option" : `Selected “${clip(value)}”`,
				live: value === null ? "Selecting an option" : `Selecting “${clip(value)}”`,
				motion: "click",
			};
		}
		case "uploadFile": {
			const path = literalArg(call.args, call.handle === null ? 1 : 0);
			return {
				icon: "file",
				done: path === null ? "Uploaded a file" : `Uploaded \`${clip(basename(path))}\``,
				live: path === null ? "Uploading a file" : `Uploading \`${clip(basename(path))}\``,
			};
		}
		case "scroll": {
			const [, dy] = numbers(call.args);
			const direction = dy === undefined || dy === 0 ? "" : dy > 0 ? " down" : " up";
			return { icon: "scroll", done: `Scrolled${direction}`, live: `Scrolling${direction}`, motion: "scroll" };
		}
		case "drag": {
			const [x1, y1, x2, y2] = numbers(call.args);
			const drag =
				x1 !== undefined &&
				y1 !== undefined &&
				x2 !== undefined &&
				y2 !== undefined &&
				literalArg(call.args) === null
					? { from: { x: x1, y: y1 }, to: { x: x2, y: y2 } }
					: undefined;
			return { icon: "scroll", done: title ?? "Dragged", live: title ?? "Dragging", drag, motion: "drag" };
		}
		case "goto":
		case "open": {
			const url =
				call.method === "open"
					? (/\burl\s*:\s*["'`]([^"'`]+)/.exec(call.args)?.[1] ?? null)
					: literalArg(call.args);
			if (url === null)
				return call.method === "open"
					? { icon: "navigate", done: "Connected to the tab", live: "Connecting to the tab" }
					: { icon: "navigate", done: "Navigated", live: "Navigating" };
			return { icon: "navigate", done: `Went to ${sayUrl(url)}`, live: `Going to ${sayUrl(url)}` };
		}
		case "back":
			return { icon: "navigate", done: "Went back", live: "Going back" };
		case "forward":
			return { icon: "navigate", done: "Went forward", live: "Going forward" };
		case "reload":
			return { icon: "navigate", done: "Reloaded the page", live: "Reloading the page" };
		case "close":
			return { icon: "navigate", done: "Released the tab", live: "Releasing the tab" };
		case "screenshot":
			return { icon: "screenshot", done: "Took a screenshot", live: "Taking a screenshot" };
		case "waitFor":
		case "waitForSelector":
		case "waitForText":
		case "waitForUrl":
		case "waitForNavigation":
		case "waitForDownload": {
			if (target === null) return { icon: "wait", done: "Waited for the page", live: "Waiting for the page" };
			const what = call.method === "waitForText" ? `“${target.text}”` : quoted(target);
			return { icon: "wait", done: `Waited for ${what}`, live: `Waiting for ${what}` };
		}
		case "evaluate":
		case "run":
			return { icon: "terminal", done: title ?? "Ran a page script", live: title ?? "Running a page script" };
		default:
			return { icon: "page", done: "Read page", live: "Reading page" };
	}
}

/** Code of every cell of an eval call, whichever argument shape the host used. */
function evalCode(args: Record<string, unknown>): { code: string; title: string | null } {
	if (Array.isArray(args.cells)) {
		const cells = args.cells.filter(isRecord);
		const title = cells.map(cell => cell.title).find((t): t is string => typeof t === "string" && t !== "");
		return {
			code: cells.map(cell => (typeof cell.code === "string" ? cell.code : "")).join("\n"),
			title: title ?? null,
		};
	}
	return { code: field(args, "code", "input") ?? "", title: field(args, "title") };
}

function describeCode(code: string, title: string | null): StepDescription {
	const calls = browserCalls(code);
	if (calls.length === 0) {
		const first = code.split("\n").find(line => line.trim() !== "" && !/^\s*(?:\/\/|#)/.test(line));
		const label = title ?? (first === undefined ? "code" : `\`${clip(first, 40)}\``);
		return { icon: "terminal", done: title ?? `Ran ${label}`, live: title ?? `Running ${label}` };
	}
	// One row per cell: what changed the page, else what it waited for, else what it read, else the screenshot.
	const headline =
		calls.findLast(call => ACTION.test(call.method) && !(call.method === "open" && !/\burl\s*:/.test(call.args))) ??
		calls.findLast(call => call.method.startsWith("waitFor")) ??
		calls.findLast(call => call.method !== "screenshot" && call.method !== "open" && call.method !== "close") ??
		calls[calls.length - 1];
	return describeBrowserCall(headline, title);
}

/** The label, icon and pointer geometry for one tool call. `args` is the raw argument object off the wire. */
export function describeStep(name: string, rawArgs: unknown, intent: string | undefined): StepDescription {
	const args = isRecord(rawArgs) ? rawArgs : {};
	const rawHint = intent?.trim() || (typeof args[INTENT_FIELD] === "string" ? args[INTENT_FIELD].trim() : "") || null;
	const hint = rawHint ? toolIntentLabel(rawHint) : null;
	switch (name) {
		case "bash": {
			const command = field(args, "command");
			const shown = command === null ? "a command" : `\`${clip(command.split("\n")[0], 44)}\``;
			return { icon: "terminal", done: `Ran ${shown}`, live: `Running ${shown}` };
		}
		case "eval":
		case "js":
		case "python": {
			const { code, title } = evalCode(args);
			return describeCode(code, title);
		}
		case "browser": {
			const action = field(args, "action");
			if (action === "open") {
				const url = field(args, "url");
				return url === null
					? { icon: "navigate", done: "Opened a tab", live: "Opening a tab" }
					: { icon: "navigate", done: `Opened ${sayUrl(url)}`, live: `Opening ${sayUrl(url)}` };
			}
			if (action === "close") return { icon: "navigate", done: "Released the tab", live: "Releasing the tab" };
			return describeCode(field(args, "code") ?? "", hint);
		}
		case "read": {
			const path = field(args, "path", "file_path");
			if (path === null) return { icon: "file", done: "Read a file", live: "Reading a file" };
			if (/^https?:\/\//.test(path))
				return { icon: "navigate", done: `Read ${sayUrl(path)}`, live: `Reading ${sayUrl(path)}` };
			const file = `\`${clip(basename(path.replace(/:[\d,+\-:a-z]*$/i, "")))}\``;
			return { icon: "file", done: `Read ${file}`, live: `Reading ${file}` };
		}
		case "write": {
			const path = field(args, "path", "file_path");
			const file = path === null ? "a file" : `\`${clip(basename(path))}\``;
			return { icon: "file", done: `Wrote ${file}`, live: `Writing ${file}` };
		}
		case "edit":
		case "ast_edit": {
			const path =
				field(args, "path", "file_path") ?? /\*\*\* Edit File: (\S+)/.exec(field(args, "input") ?? "")?.[1];
			const file = path == null ? "files" : `\`${clip(basename(path))}\``;
			return { icon: "file", done: `Edited ${file}`, live: `Editing ${file}` };
		}
		case "grep":
		case "search":
		case "ast_grep": {
			const pattern = field(args, "pattern", "query");
			const what = pattern === null ? "the code" : `\`${clip(pattern, 36)}\``;
			return { icon: "search", done: `Searched for ${what}`, live: `Searching for ${what}` };
		}
		case "find":
		case "glob": {
			const what = field(args, "query", "pattern", "path");
			return what === null
				? { icon: "search", done: "Looked for files", live: "Looking for files" }
				: { icon: "search", done: `Looked for ${clip(what, 40)}`, live: `Looking for ${clip(what, 40)}` };
		}
		case "web_search": {
			const query = field(args, "query");
			const what = query === null ? "the web" : `the web for “${clip(query, 36)}”`;
			return { icon: "search", done: `Searched ${what}`, live: `Searching ${what}` };
		}
		case "fetch": {
			const url = field(args, "url");
			const what = url === null ? "a page" : sayUrl(url);
			return { icon: "navigate", done: `Fetched ${what}`, live: `Fetching ${what}` };
		}
		case "task": {
			const count = Array.isArray(args.tasks) ? args.tasks.length : 1;
			const what = count === 1 ? "a subagent" : `${count} subagents`;
			return { icon: "agent", done: `Started ${what}`, live: `Starting ${what}` };
		}
		case "wait":
			return { icon: "wait", done: "Waited for background work", live: "Waiting for background work" };
		case "ask":
			return { icon: "ask", done: "Asked you a question", live: "Asking you a question" };
		case "todo":
		case "todo_write":
			return { icon: "plan", done: "Updated the plan", live: "Updating the plan" };
		default: {
			const label = hint ?? name.replaceAll("_", " ");
			return { icon: "tool", done: hint ?? `Used ${label}`, live: hint ?? `Using ${label}` };
		}
	}
}
