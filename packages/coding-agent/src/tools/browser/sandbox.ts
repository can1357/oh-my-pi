/**
 * What a browser call does on the host while the OS sandbox is active, as the sandbox gate's
 * subjects, and how omp's own Chromium launches contained by it.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxSubject } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "../tool-errors";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { Browser } from "puppeteer-core";
import type { Settings } from "../../config/settings";
import { realpathIfExists } from "../../sandbox/context";
import { containingSandbox } from "../../sandbox/file-access";
import { sandboxCallDenial } from "../../sandbox/gate";
import { readSandboxConfig } from "../../sandbox/policy";
import { effectiveNetworkMode } from "../../sandbox/runtime";
import type { SandboxNetworkMode } from "../../sandbox/types";
import type { ToolSession } from "../../sdk";
import { resolveToCwd } from "../path-utils";
import type { ChromiumSandbox } from "./launch";
import { initScriptPath } from "./open-options";
import type { BrowserHandle, BrowserKind } from "./registry";
import type { TabCallStep } from "./tab-call";

/** Exec target of code a browser call runs in omp's own process (`tab.run`, a function argument). */
const HOST_CODE_TARGET = "browser:run";

/** Exec target of a headed Chromium's clipboard operations, which reach the host's system clipboard. */
const HEADED_CLIPBOARD_TARGET = "browser:clipboard";

/**
 * A key whose press, with or without a modifier prefix, can copy, cut or paste: `c`, `v`, `x`
 * (also as the `KeyC`-style code name) or `Insert` (`Control+Insert`, `Shift+Insert`).
 */
const CLIPBOARD_SHORTCUT_KEY = /(?:^|\+)(?:(?:key)?[cvx]|insert)$/i;

/** Suffix of the changed-frame contact sheet a recording writes (or clears) beside its video. */
const CONTACT_SHEET_SUFFIX = ".contact.png";

/** Exec target of omp's Chromium launched with the network of mode `allow` while the mode is stricter. */
const NETWORK_ALLOW_TARGET = "browser:chromium-network-allow";

/** Strictness of a network mode: a Chromium launched under a mode at least this strict stays contained. */
const NETWORK_STRICTNESS: Record<SandboxNetworkMode, number> = { allow: 0, allowlist: 1, deny: 2 };

/** The parameters of one browser call that name host effects. */
export interface BrowserSandboxCall {
	action: "open" | "close" | "run" | "call" | "tabs" | "targets";
	url?: string;
	init_scripts?: readonly string[];
	downloads?: string;
	chain?: readonly TabCallStep[];
}

/**
 * The network mode contained commands run under now, as the runtime's status reports it: the
 * configured mode, or `deny` where this host cannot enforce it.
 */
export function sandboxNetworkMode(settings: Settings): SandboxNetworkMode {
	return effectiveNetworkMode(readSandboxConfig(settings).networkMode);
}

/**
 * The containment omp's own Chromium launches under for `session` now: `undefined` while the
 * sandbox is not active. In network mode `deny` it launches as in `allow`, once the session holds
 * {@link NETWORK_ALLOW_TARGET}: an open of this browser asks for it ({@link browserExecTarget});
 * one that fell back to it from another browser is checked here. Throws, as contained commands do,
 * when `fallback: block` finds no backend.
 */
export async function chromiumSandbox(
	session: Pick<ToolSession, "cwd" | "settings" | "isToolActive">,
): Promise<ChromiumSandbox | undefined> {
	const runtime = await containingSandbox(session.cwd, { settings: session.settings });
	if (!runtime) return undefined;
	const { workspace } = runtime;
	const proxyServer = await runtime.egressProxyUrl();
	if (proxyServer !== undefined) return { workspace, network: "allowlist", proxyServer };
	const status = runtime.status();
	if (status.state === "active" && status.network === "deny") {
		const denial = await sandboxCallDenial({
			settings: session.settings,
			workspace: session.cwd,
			name: "browser",
			subjects: () => [{ kind: "exec", target: NETWORK_ALLOW_TARGET }],
			requestTool: () => session.isToolActive?.("sandbox_request") === true,
		});
		if (denial !== undefined) throw new ToolError(denial);
	}
	return { workspace, network: "allow" };
}

/**
 * The exec target an open or attach of `kind` needs: every browser omp cannot contain (the user's
 * Chrome through the relay, a CDP endpoint, cmux, Tern, omp's WebKit host, a spawned executable).
 * omp's own Chromium launches contained ({@link chromiumSandbox}) and needs none, except under
 * `network` mode `deny`, where it launches with the network of mode `allow`.
 */
export function browserExecTarget(kind: BrowserKind, network?: SandboxNetworkMode): string | undefined {
	switch (kind.kind) {
		case "headless":
			return network === "deny" ? NETWORK_ALLOW_TARGET : undefined;
		case "spawned":
			return `browser:spawned ${realpathIfExists(kind.path) ?? kind.path}`;
		case "connected":
			return "browser:cdp";
		default:
			return `browser:${kind.kind}`;
	}
}

/**
 * The exec target a call on an open tab of `handle` needs from a session in `cwd`: as
 * {@link browserExecTarget}, and for omp's Chromium one not contained as this session's sandbox
 * now asks: launched while the sandbox was off (`browser:shared`, `browser:chromium-unsandboxed`),
 * for another workspace (`browser:chromium-workspace <path>`), or under a looser network mode than
 * `network` (`browser:chromium-network-<mode>`). Closing and reopening the tab contains it instead.
 */
export function tabExecTarget(handle: BrowserHandle, network: SandboxNetworkMode, cwd: string): string | undefined {
	const kind = handle.kind;
	if (kind.kind !== "headless") return browserExecTarget(kind);
	const { sandbox } = kind;
	if (!sandbox)
		return "sharedDaemon" in handle && handle.sharedDaemon ? "browser:shared" : "browser:chromium-unsandboxed";
	const workspace = path.resolve(cwd);
	if (sandbox.workspace !== (realpathIfExists(workspace) ?? workspace)) {
		return `browser:chromium-workspace ${sandbox.workspace}`;
	}
	if (NETWORK_STRICTNESS[sandbox.network] >= NETWORK_STRICTNESS[network]) return undefined;
	return `browser:chromium-network-${sandbox.network}`;
}

/** Whether `handle` is omp's own Chromium with a visible window (`kind: "headless"` with `headless: false`). */
export function isHeadedChromium(handle: BrowserHandle): boolean {
	return handle.kind.kind === "headless" && !handle.kind.headless;
}

/**
 * The host effects `call` names, besides its browser: local files it reads or writes (relative
 * paths against `cwd`, as the tab resolves them; `file:` URLs it loads) and code it runs in omp's
 * own process. Files omp picks itself (temp captures, `~/.omp/browser-state`) are not named.
 * `headed` is whether the call's tab is a headed omp Chromium, whose clipboard is the host's.
 */
export function browserCallSubjects(call: BrowserSandboxCall, cwd: string, headed = false): SandboxSubject[] {
	const subjects: SandboxSubject[] = [];
	// Resolved as the tab resolves it (`""` is the cwd); an internal URL the tab refuses names nothing.
	const push = (kind: "read" | "write", resolve: () => string | undefined, recursive?: boolean) => {
		let target: string | undefined;
		try {
			target = resolve();
		} catch {
			return;
		}
		if (target !== undefined) subjects.push(recursive ? { kind, target, recursive } : { kind, target });
	};
	const add = (kind: "read" | "write", value: unknown, recursive?: boolean) => {
		if (typeof value === "string") push(kind, () => resolveToCwd(value, cwd), recursive);
	};
	const addUrl = (value: unknown) => push("read", () => fileUrlPath(value));
	switch (call.action) {
		case "open":
			addUrl(call.url);
			for (const entry of call.init_scripts ?? []) push("read", () => initScriptPath(entry, cwd));
			add("write", call.downloads, true);
			break;
		case "run":
			subjects.push({ kind: "exec", target: HOST_CODE_TARGET });
			break;
		case "call": {
			const [root, handleStep] = call.chain ?? [];
			if (!root) break;
			// A function argument is source spliced into the code the tab runs in this process, as is
			// the string an element handle's `evaluate` takes.
			const elementEvaluate =
				handleStep?.method === "evaluate" && root.method !== "frame" && typeof handleStep.args[0] === "string";
			if (elementEvaluate || [root, handleStep].some(step => step?.args.some(hasFunctionMarker))) {
				subjects.push({ kind: "exec", target: HOST_CODE_TARGET });
			}
			const step = handleStep ?? root;
			const [first, second] = step.args;
			const option = (value: unknown, key: string) => (isRecord(value) ? value[key] : undefined);
			switch (step.method) {
				case "goto":
					addUrl(first);
					break;
				case "uploadFile":
					// `tab.uploadFile(selector, ...paths)`; an element's takes paths only. Either may pass arrays.
					for (const file of step.args.slice(handleStep ? 0 : 1).flat()) add("read", file);
					break;
				case "screenshot":
				case "pdf":
				case "traceStop":
				case "profileStop":
					add("write", option(first, "path"));
					break;
				case "harStop":
					// Without a path the HAR goes to a new file in the session cwd.
					add("write", option(first, "path") || cwd);
					break;
				case "diffScreenshot":
					add("read", first);
					add("write", option(second, "output"));
					break;
				case "saveState":
					add("write", first);
					break;
				case "recordStart":
				case "recordRestart":
					// The recording, and the `<path>.contact.png` sheet a failed or contact-sheet stop writes or removes beside it.
					add("write", first);
					if (typeof first === "string") add("write", `${first}${CONTACT_SHEET_SUFFIX}`);
					break;
				case "clipboardRead":
				case "clipboardWrite":
				case "clipboardCopy":
				case "clipboardPaste":
					// A headed Chromium shares the host's system clipboard; a headless one's is its own.
					if (headed) subjects.push({ kind: "exec", target: HEADED_CLIPBOARD_TARGET });
					break;
				case "press":
				case "keyDown": {
					// A clipboard shortcut key (`Control+v`, or `v` while a modifier `keyDown` holds) copies,
					// cuts or pastes the host's clipboard in a headed Chromium, like `clipboardCopy`/`Paste`.
					// The key is the first argument of `keyDown` and of an element's `press`, the second of a
					// tab or frame `press(selector, key)`: either string argument naming one gates the call.
					const keys = step.method === "press" ? [first, second] : [first];
					if (headed && keys.some(key => typeof key === "string" && CLIPBOARD_SHORTCUT_KEY.test(key))) {
						subjects.push({ kind: "exec", target: HEADED_CLIPBOARD_TARGET });
					}
					break;
				}
				case "loadState":
					add("read", first);
					break;
			}
			break;
		}
	}
	return subjects;
}

/** The local file a `file:` URL (also inside `view-source:`) loads; `undefined` for any other value. */
function fileUrlPath(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (url.protocol === "view-source:") return fileUrlPath(url.pathname);
	if (url.protocol !== "file:") return undefined;
	try {
		return fileURLToPath(url);
	} catch {
		// A host on POSIX or an encoded separator: the decoded path is the file at stake.
		try {
			return decodeURIComponent(url.pathname);
		} catch {
			return url.pathname;
		}
	}
}

/**
 * Contain a Chromium launched for `sandbox`: page downloads are denied (a tab's declared `downloads`
 * folder or omp's temp folder enables them per tab), and every `file:` load the sandbox does not let
 * omp read for its workspace fails: subresources and frames of a `file:` page and navigations it
 * starts reach paths no call declared, so they are checked as they happen.
 */
export async function containChromium(browser: Browser, sandbox: ChromiumSandbox, settings: Settings): Promise<void> {
	const session = await browser.target().createCDPSession();
	await session.send("Browser.setDownloadBehavior", { behavior: "deny" });
	const decide = async (requestId: string, url: string) => {
		const target = fileUrlPath(url);
		try {
			const denial =
				target === undefined
					? "unparseable"
					: await sandboxCallDenial({
							settings,
							workspace: sandbox.workspace,
							name: "browser",
							subjects: () => [{ kind: "read", target }],
							requestTool: () => false,
						});
			if (denial === undefined) return await session.send("Fetch.continueRequest", { requestId });
		} catch (error) {
			logger.debug("Browser file load check failed", { url, error: String(error) });
		}
		await session.send("Fetch.failRequest", { requestId, errorReason: "AccessDenied" });
	};
	session.on("Fetch.requestPaused", ({ requestId, request }) => {
		// A closed browser or page leaves nothing to answer.
		decide(requestId, request.url).catch(() => undefined);
	});
	await session.send("Fetch.enable", { patterns: [{ urlPattern: "file://*" }] });
}

/** Whether `value` holds a serialized function (`{ __omp_fn }`) at any depth. */
function hasFunctionMarker(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(hasFunctionMarker);
	return isRecord(value) && (Object.hasOwn(value, "__omp_fn") || Object.values(value).some(hasFunctionMarker));
}
