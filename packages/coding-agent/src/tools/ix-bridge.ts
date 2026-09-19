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
import { judgeState, OPENROUTER_DEFAULT_JUDGE_MODEL } from "../lib/openrouter-judge";
import type { ToolSession } from "./index";

/** Default IX Bridge daemon base URL. */
export const IX_BRIDGE_DEFAULT_BASE_URL = "http://127.0.0.1:18086";
/** Default agent route / lane when the caller does not specify one. */
const IX_BRIDGE_DEFAULT_LANE = "agent-a";
/** Default per-request timeout (ms). */
const IX_BRIDGE_DEFAULT_TIMEOUT_MS = 30_000;
const IX_BRIDGE_MIN_TIMEOUT_MS = 1_000;
const IX_BRIDGE_MAX_TIMEOUT_MS = 300_000;

const verifyQuestions = type({ "[string]": { instructions: "string" } });

const ixBridgeParams = type({
	action: type.enumerated("status", "guide", "command", "verify").describe("status | guide | command | verify"),
	"baseUrl?": type("string").describe(`daemon base URL (default ${IX_BRIDGE_DEFAULT_BASE_URL})`),
	"lane?": type("string").describe(`agent route / lane (default ${IX_BRIDGE_DEFAULT_LANE})`),
	"session?": type("string").describe("stable session id so tabs stay grouped per task"),
	"tabGroup?": type("string").describe("strict Chrome tab-group title boundary"),
	"command?": type("string").describe(
		"for action=command: navigate|find_tab|snapshot|click|fill|type|press|wait|get_url|get_title|screenshot|browser_execute|list_tabs|close_tab|close_session|fill_secret|...",
	),
	"args?": type("object").describe("command arguments, e.g. { selector: '@e12', value: 'x' }"),
	"timeoutMs?": type("number").describe(`request timeout ms (default ${IX_BRIDGE_DEFAULT_TIMEOUT_MS})`),
	"goal?": type("string").describe("for action=verify: the goal the browser task was supposed to achieve"),
	"questions?": verifyQuestions.describe(
		"for action=verify: yes/no questions to judge against the snapshot (default: one goal_met question)",
	),
	"model?": type("string").describe(
		`for action=verify: OpenRouter judge model (default ${OPENROUTER_DEFAULT_JUDGE_MODEL})`,
	),
	"threshold?": type("number").describe("for action=verify: probability required per question (default 0.7)"),
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
			"Drive the local IX Bridge browser daemon (Chrome/Edge extension at http://127.0.0.1:18086). action=status checks daemon/extension health, action=guide fetches the live command guide, action=command sends a browser action (snapshot before element actions; use returned @e refs), action=verify snapshots the lane and asks a fast OpenRouter model whether the page state satisfies `goal` — use it to confirm a browser task actually completed. Primary browser surface for OMPK; prefer over ad-hoc HTTP.",
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

				if (params.action === "verify") {
					if (!params.goal?.trim()) {
						return {
							content: [{ type: "text", text: "ix_bridge action=verify requires a `goal`." }],
							isError: true,
							details: makeDetails(false),
						};
					}
					const lane = params.lane ?? IX_BRIDGE_DEFAULT_LANE;
					const snapRes = await fetchImpl(`${baseUrl}/ix-bridge/command`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ lane, action: "snapshot", args: {} }),
						signal: controller.signal,
					});
					if (!snapRes.ok) {
						const text = `IX Bridge verify snapshot failed (${snapRes.status}):\n${await snapRes.text()}`;
						return {
							content: [{ type: "text", text }],
							isError: true,
							details: makeDetails(false, snapRes.status),
						};
					}
					let state = await snapRes.text();
					// Aria snapshots omit input values — augment with live DOM field
					// values so "was the form filled" questions are answerable.
					// Passwords are masked; failure degrades to snapshot-only.
					try {
						const fieldsRes = await fetchImpl(`${baseUrl}/ix-bridge/command`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								lane,
								action: "browser_execute",
								args: {
									code: `JSON.stringify([...document.querySelectorAll('input,textarea,select')].map(e=>({name:e.name||e.id||e.type,type:e.type,value:e.type==='password'?(e.value?'[set]':'[empty]'):e.value,checked:e.checked})).filter(f=>f.value||f.checked))`,
								},
							}),
							signal: controller.signal,
						});
						if (fieldsRes.ok) {
							state += `\n\nFORM FIELD VALUES (live DOM):\n${await fieldsRes.text()}`;
						}
					} catch {
						// snapshot-only verification still applies
					}
					const questions = params.questions ?? {
						goal_met: { instructions: `Does the page state show this goal was achieved: ${params.goal}` },
					};
					const threshold = params.threshold ?? 0.7;
					try {
						const result = await judgeState({
							goal: params.goal,
							state,
							questions,
							model: params.model,
							signal: controller.signal,
							fetchImpl,
						});
						const verified = Object.values(result.answers).every(a => a.noul >= threshold);
						// Mid-range probabilities mean "cannot tell" — surface that so the
						// caller escalates instead of treating ambiguity as failure.
						const uncertain = Object.values(result.answers).some(a => a.noul > 0.3 && a.noul < threshold);
						const text =
							`IX Bridge verify (${result.model}, ${result.latencyMs.toFixed(0)}ms):\n` +
							stringifyBody({ verified, uncertain, threshold, goal: params.goal, answers: result.answers });
						return { content: [{ type: "text", text }], isError: false, details: makeDetails(true) };
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return {
							content: [{ type: "text", text: `IX Bridge verify failed: ${message}` }],
							isError: true,
							details: makeDetails(false),
						};
					}
				}
				// action === "command"
				if (!params.command?.trim()) {
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
