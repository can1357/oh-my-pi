/**
 * Tests for per-site consent gating of relay-driven browsing:
 * - `relay-sites` origin parsing and pattern matching (exact hosts and
 *   `*.example.com` wildcards incl. the bare domain), aligned with
 *   `allowed_domains` semantics,
 * - the open-time gate `gateRelaySite`: allow-once, always-persist into
 *   `browser.relayAllowedSites`, deny, timed-out prompts, non-interactive
 *   guidance, and non-relay kinds passing through ungated,
 * - the wiring inside `browser.open`: consent errors surface before any
 *   browser acquisition, and an approved origin proceeds to it.
 */

import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude, gateRelaySite } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import type { BrowserKind } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	diffSite,
	parseSite,
	siteHost,
	siteMatches,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay-sites";
import { cfgBrowserRelayAllowedSites } from "@oh-my-pi/pi-coding-agent/tools/browser/settings";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { rejectionOf } from "../helpers/rejection";

// A port nothing serves: relay opens that pass the gate fail fast here with
// the relay-unreachable error, proving they got past consent without ever
// touching a real relay or Chrome.
const DEAD_RELAY_PORT = await findFreeCdpPort();
const DEAD_RELAY_URL = `http://127.0.0.1:${DEAD_RELAY_PORT}`;
const RELAY_KIND: BrowserKind = { kind: "relay", cdpUrl: DEAD_RELAY_URL };
const HEADLESS_KIND: BrowserKind = { kind: "headless", headless: true };
const CONNECTED_KIND: BrowserKind = { kind: "connected", cdpUrl: DEAD_RELAY_URL };

/** Ask tool stand-in: records every question payload and answers with `details`. */
function fakeAsk(details: { selectedOptions: string[]; timedOut?: boolean }) {
	const questions: unknown[] = [];
	const tool = {
		name: "ask",
		execute: async (_toolCallId: string, params: unknown) => {
			questions.push(params);
			return {
				content: [{ type: "text" as const, text: "answered" }],
				details: {
					selectedOptions: details.selectedOptions,
					...(details.timedOut ? { timedOut: true } : {}),
				},
			};
		},
	} as unknown as AgentTool;
	return { questions, tool };
}

function agentContext(): AgentToolContext {
	return { hasUI: true, ui: {} } as unknown as AgentToolContext;
}

function makeSession(options: { ask?: AgentTool; allowedSites?: string[] } = {}): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: options.ask !== undefined,
		canPromptUser: options.ask !== undefined,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.relayUrl": DEAD_RELAY_URL,
			// Only pin the allowlist when a test supplies one: a pinned `[]`
			// override would mask the global write "Always allow" persists.
			...(options.allowedSites ? { "browser.relayAllowedSites": options.allowedSites } : {}),
		}),
		getToolByName: (name: string) => (name === "ask" ? options.ask : undefined),
	};
}

describe("parseSite", () => {
	it("returns the origin of http(s) URLs", () => {
		expect(parseSite("https://example.com/cart?x=1")).toBe("https://example.com");
		expect(parseSite("http://localhost:3000/x")).toBe("http://localhost:3000");
		expect(parseSite("HTTPS://Example.COM/")).toBe("https://example.com");
	});

	it("returns undefined for non-http(s) or unparseable URLs", () => {
		expect(parseSite("about:blank")).toBeUndefined();
		expect(parseSite("chrome://extensions")).toBeUndefined();
		expect(parseSite("file:///etc/passwd")).toBeUndefined();
		expect(parseSite("not a url")).toBeUndefined();
	});
});

describe("siteMatches", () => {
	it("matches exact hosts and bare domains under wildcards", () => {
		expect(siteMatches("https://example.com", ["example.com"])).toBe(true);
		expect(siteMatches("https://example.com", ["*.example.com"])).toBe(true);
		expect(siteMatches("https://a.b.example.com", ["*.example.com"])).toBe(true);
	});

	it("does not match other hosts, suffixes, or empty patterns", () => {
		expect(siteMatches("https://other.com", ["example.com", "*.example.com"])).toBe(false);
		expect(siteMatches("https://notexample.com", ["example.com"])).toBe(false);
		expect(siteMatches("https://example.com.evil.com", ["*.example.com"])).toBe(false);
		expect(siteMatches("https://example.com", [])).toBe(false);
	});

	it("normalizes case, trailing dots, ports, and full-URL patterns", () => {
		expect(siteMatches("https://example.com", ["Example.COM."])).toBe(true);
		expect(siteMatches("http://localhost:3000", ["localhost"])).toBe(true);
		expect(siteMatches("https://example.com/x", ["https://example.com/x"])).toBe(true);
		expect(siteHost("http://User@Example.COM:8443/p")).toBe("example.com");
	});
});

describe("diffSite", () => {
	it("returns the origin needing consent, null otherwise", () => {
		expect(diffSite("https://example.com/", ["example.com"])).toBeNull();
		expect(diffSite("https://sub.example.com/", ["*.example.com"])).toBeNull();
		expect(diffSite("about:blank", [])).toBeNull();
		expect(diffSite("https://example.com/", [])).toBe("https://example.com");
	});
});

describe("gateRelaySite", () => {
	it("leaves non-relay kinds ungated", async () => {
		const ask = fakeAsk({ selectedOptions: ["Allow once"] });
		const session = makeSession({ ask: ask.tool });
		for (const kind of [HEADLESS_KIND, CONNECTED_KIND]) {
			await gateRelaySite(session, kind, "https://example.com/", {
				agentContext: agentContext(),
			});
		}
		expect(ask.questions).toHaveLength(0);
	});

	it("passes allowed origins and URL-less opens without asking", async () => {
		const ask = fakeAsk({ selectedOptions: ["Deny"] });
		const session = makeSession({ ask: ask.tool, allowedSites: ["*.example.com"] });
		await gateRelaySite(session, RELAY_KIND, "https://sub.example.com/x", { agentContext: agentContext() });
		await gateRelaySite(session, RELAY_KIND, undefined, { agentContext: agentContext() });
		await gateRelaySite(session, RELAY_KIND, "about:blank", { agentContext: agentContext() });
		expect(ask.questions).toHaveLength(0);
	});

	it("asks once and proceeds without persisting on Allow once", async () => {
		const ask = fakeAsk({ selectedOptions: ["Allow once"] });
		const session = makeSession({ ask: ask.tool });
		await gateRelaySite(session, RELAY_KIND, "https://example.com/", { agentContext: agentContext() });
		expect(ask.questions).toHaveLength(1);
		expect(cfgBrowserRelayAllowedSites.get(session.settings)).toEqual([]);
	});

	it("persists the host on Always allow", async () => {
		const ask = fakeAsk({ selectedOptions: ["Always allow example.com"] });
		const session = makeSession({ ask: ask.tool });
		await gateRelaySite(session, RELAY_KIND, "https://example.com/", { agentContext: agentContext() });
		expect(cfgBrowserRelayAllowedSites.get(session.settings)).toEqual(["example.com"]);
	});

	it("throws a ToolError on Deny", async () => {
		const ask = fakeAsk({ selectedOptions: ["Deny"] });
		const session = makeSession({ ask: ask.tool });
		const error = await rejectionOf(
			gateRelaySite(session, RELAY_KIND, "https://example.com/", { agentContext: agentContext() }),
		);
		expect(error).toBeInstanceOf(ToolError);
		expect((error as Error).message).toContain("declined to allow https://example.com");
		expect(cfgBrowserRelayAllowedSites.get(session.settings)).toEqual([]);
	});

	it("fails closed when the prompt times out or answers nothing", async () => {
		for (const details of [{ selectedOptions: [], timedOut: true }, { selectedOptions: [] }]) {
			const ask = fakeAsk(details);
			const session = makeSession({ ask: ask.tool });
			const error = await rejectionOf(
				gateRelaySite(session, RELAY_KIND, "https://example.com/", { agentContext: agentContext() }),
			);
			expect(error).toBeInstanceOf(ToolError);
			expect(cfgBrowserRelayAllowedSites.get(session.settings)).toEqual([]);
		}
	});

	it("tells the agent what to do when the session cannot ask", async () => {
		const session = makeSession();
		const error = await rejectionOf(
			gateRelaySite(session, RELAY_KIND, "https://example.com/", { agentContext: agentContext() }),
		);
		expect(error).toBeInstanceOf(ToolError);
		expect((error as Error).message).toContain("browser.relayAllowedSites");
		const askSession = makeSession({ ask: fakeAsk({ selectedOptions: ["Allow once"] }).tool });
		const noUi = await rejectionOf(gateRelaySite(askSession, RELAY_KIND, "https://example.com/", {}));
		expect(noUi).toBeInstanceOf(ToolError);
	});
});

describe("relay site gate wiring in browser.open", () => {
	it("surfaces the consent error before acquiring a relay browser", async () => {
		const ask = fakeAsk({ selectedOptions: ["Deny"] });
		const session = makeSession({ ask: ask.tool });
		const prelude = createBrowserPrelude(session);
		const error = await rejectionOf(
			prelude.invoke(
				{ action: "open", name: "gated", url: "https://example.com/", app: { relay: true } },
				{ session, toolCallId: "relay-gate-deny", context: agentContext() },
			),
		);
		expect(error).toBeInstanceOf(ToolError);
		expect((error as Error).message).toContain("declined to allow https://example.com");
		expect(ask.questions).toHaveLength(1);
	});

	it("asks for unapproved origins even without app.relay when the relay setting is on", async () => {
		const ask = fakeAsk({ selectedOptions: ["Deny"] });
		const session = makeSession({ ask: ask.tool });
		session.settings = Settings.isolated({
			"browser.enabled": true,
			"browser.relay": true,
			"browser.relayUrl": DEAD_RELAY_URL,
		});
		const prelude = createBrowserPrelude(session);
		const error = await rejectionOf(
			prelude.invoke(
				{ action: "open", name: "gated-setting", url: "https://example.com/" },
				{ session, toolCallId: "relay-gate-setting", context: agentContext() },
			),
		);
		expect((error as Error).message).toContain("declined to allow https://example.com");
		expect(ask.questions).toHaveLength(1);
	});

	it("proceeds past the gate on Allow once and reaches relay acquisition", async () => {
		const ask = fakeAsk({ selectedOptions: ["Allow once"] });
		const session = makeSession({ ask: ask.tool });
		const prelude = createBrowserPrelude(session);
		const error = await rejectionOf(
			prelude.invoke(
				{ action: "open", name: "once", url: "https://example.com/", app: { relay: true } },
				{ session, toolCallId: "relay-gate-once", context: agentContext() },
			),
		);
		expect((error as Error).message).toContain("omp browser relay is not reachable");
		expect(ask.questions).toHaveLength(1);
		expect(cfgBrowserRelayAllowedSites.get(session.settings)).toEqual([]);
	});

	it("persists the host through the open path on Always allow", async () => {
		const ask = fakeAsk({ selectedOptions: ["Always allow example.com"] });
		const session = makeSession({ ask: ask.tool });
		const prelude = createBrowserPrelude(session);
		const error = await rejectionOf(
			prelude.invoke(
				{ action: "open", name: "always", url: "https://example.com/", app: { relay: true } },
				{ session, toolCallId: "relay-gate-always", context: agentContext() },
			),
		);
		expect((error as Error).message).toContain("omp browser relay is not reachable");
		expect(cfgBrowserRelayAllowedSites.get(session.settings)).toEqual(["example.com"]);
	});

	it("opens an allowed origin without any ask surface available", async () => {
		const session = makeSession({ allowedSites: ["example.com"] });
		const prelude = createBrowserPrelude(session);
		const error = await rejectionOf(
			prelude.invoke(
				{ action: "open", name: "allowed", url: "https://example.com/", app: { relay: true } },
				{ session, toolCallId: "relay-gate-allowed" },
			),
		);
		expect((error as Error).message).toContain("omp browser relay is not reachable");
	});

	it("opens a relay tab without a URL ungated", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const error = await rejectionOf(
			prelude.invoke(
				{ action: "open", name: "blank", app: { relay: true } },
				{ session, toolCallId: "relay-gate-blank" },
			),
		);
		expect((error as Error).message).toContain("omp browser relay is not reachable");
	});
});
