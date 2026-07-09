/**
 * ix_bridge — native tool for driving the local IX Bridge browser daemon.
 *
 * IX Bridge is the primary browser automation surface for OMPK: a local daemon
 * plus a Chrome/Edge MV3 extension listening on http://127.0.0.1:18086. Browser
 * subagents (`browser-control`, `browser-operation`, `ix-browser-fast`) should
 * prefer this tool over hand-written `bash` HTTP snippets so lane/session
 * defaults, status checks, and error mapping are handled consistently.
 *
 * Endpoints wrapped:
 *   - GET  /ix-bridge/status  → daemon + extension health
 *   - GET  /ix-bridge/guide   → live command guide
 *   - POST /ix-bridge/command → browser actions (snapshot/click/fill/...)
 */
import type { AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import type { ToolSession } from "./index";

/** Default IX Bridge daemon base URL. */
export const IX_BRIDGE_DEFAULT_BASE_URL = "http://127.0.0.1:18086";
/** Default agent route / lane when the caller does not specify one. */
const IX_BRIDGE_DEFAULT_LANE = "agent-a";
/** Default per-request timeout (ms). */
const IX_BRIDGE_DEFAULT_TIMEOUT_MS = 30_000;
const IX_BRIDGE_MIN_TIMEOUT_MS = 1_000;
const IX_BRIDGE_MAX_TIMEOUT_MS = 300_000;

const ixBridgeParams = type({
	action: type.enumerated("status", "guide", "command").describe("status | guide | command"),
	"baseUrl?": type("string").describe(`daemon base URL (default ${IX_BRIDGE_DEFAULT_BASE_URL})`),
	"lane?": type("string").describe(`agent route / lane (default ${IX_BRIDGE_DEFAULT_LANE})`),
	"session?": type("string").describe("stable session id so tabs stay grouped per task"),
	"tabGroup?": type("string").describe("strict Chrome tab-group title boundary"),
	"command?": type("string").describe(
		"for action=command: navigate|find_tab|snapshot|click|fill|type|press|wait|get_url|get_title|screenshot|browser_execute|list_tabs|close_tab|close_session|fill_secret|...",
	),
	"args?": type("object").describe("command arguments, e.g. { selector: '@e12', value: 'x' }"),
	"timeoutMs?": type("number").describe(`request timeout ms (default ${IX_BRIDGE_DEFAULT_TIMEOUT_MS})`),
});

type IxBridgeParams = typeof ixBridgeParams.infer;

/** Details for TUI rendering / transcript. */
export interface IxBridgeToolDetails {
	action: string;
	command?: string;
	lane?: string;
	baseUrl: string;
	ok: boolean;
	httpStatus?: number;
}

function clampIxBridgeTimeout(raw?: number): number {
	const value = raw ?? IX_BRIDGE_DEFAULT_TIMEOUT_MS;
	return Math.max(IX_BRIDGE_MIN_TIMEOUT_MS, Math.min(IX_BRIDGE_MAX_TIMEOUT_MS, value));
}

function normalizeBaseUrl(raw?: string): string {
	const base = (raw ?? IX_BRIDGE_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
	return base || IX_BRIDGE_DEFAULT_BASE_URL;
}

function stringifyBody(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function createIxBridgeTool(session: ToolSession): AgentTool<typeof ixBridgeParams, IxBridgeToolDetails> {
	const fetchImpl = (session.fetch ?? fetch) as typeof fetch;

	return {
		name: "ix_bridge",
		label: "IX Bridge",
		loadMode: "discoverable",
		summary: "Drive the local IX Bridge daemon to automate the user's real Chrome/Edge browser",
		strict: false,
		approval: "write",
		description:
			"Drive the local IX Bridge browser daemon (Chrome/Edge extension at http://127.0.0.1:18086). action=status checks daemon/extension health, action=guide fetches the live command guide, action=command sends a browser action (snapshot before element actions; use returned @e refs). Primary browser surface for OMPK; prefer over ad-hoc HTTP.",
		parameters: ixBridgeParams,
		async execute(_toolCallId, rawParams, signal) {
			const params = rawParams as IxBridgeParams;
			const baseUrl = normalizeBaseUrl(params.baseUrl);
			const timeoutMs = clampIxBridgeTimeout(params.timeoutMs);

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			const makeDetails = (ok: boolean, httpStatus?: number): IxBridgeToolDetails => ({
				action: params.action,
				command: params.command,
				lane: params.lane ?? IX_BRIDGE_DEFAULT_LANE,
				baseUrl,
				ok,
				httpStatus,
			});

			try {
				if (params.action === "status" || params.action === "guide") {
					const path = params.action === "status" ? "/ix-bridge/status" : "/ix-bridge/guide";
					const res = await fetchImpl(`${baseUrl}${path}`, { signal: controller.signal });
					const bodyText = await res.text();
					const ok = res.ok;
					const text = ok
						? `IX Bridge ${params.action} (${res.status}):\n${bodyText}`
						: `IX Bridge ${params.action} failed (${res.status}):\n${bodyText}`;
					return { content: [{ type: "text", text }], isError: !ok, details: makeDetails(ok, res.status) };
				}

				// action === "command"
				if (!params.command || !params.command.trim()) {
					return {
						content: [
							{
								type: "text",
								text: "ix_bridge action=command requires a `command` (e.g. snapshot, navigate, click).",
							},
						],
						isError: true,
						details: makeDetails(false),
					};
				}

				const body: Record<string, unknown> = {
					lane: params.lane ?? IX_BRIDGE_DEFAULT_LANE,
					action: params.command,
					args: params.args ?? {},
				};
				if (params.session) body.session = params.session;
				if (params.tabGroup) body.tabGroup = params.tabGroup;

				const res = await fetchImpl(`${baseUrl}/ix-bridge/command`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
					signal: controller.signal,
				});
				const raw = await res.text();
				let rendered = raw;
				try {
					rendered = stringifyBody(JSON.parse(raw));
				} catch {
					// non-JSON response; keep raw text
				}
				const ok = res.ok;
				const text = ok
					? `IX Bridge ${params.command} (${res.status}):\n${rendered}`
					: `IX Bridge ${params.command} failed (${res.status}):\n${rendered}`;
				return { content: [{ type: "text", text }], isError: !ok, details: makeDetails(ok, res.status) };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const hint = /abort/i.test(message)
					? `IX Bridge request timed out after ${timeoutMs}ms at ${baseUrl}.`
					: `IX Bridge request failed: ${message}. Is the daemon running at ${baseUrl}? Check action=status or start daemon.js.`;
				logger.debug("ix_bridge request failed", { error: message, action: params.action, baseUrl });
				return { content: [{ type: "text", text: hint }], isError: true, details: makeDetails(false) };
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}
