import { beforeAll, describe, expect, test } from "bun:test";
import {
	MCPActionPanel,
	type MCPActionId,
	type MCPActionItem,
	type MCPActionPanelRuntime,
	type MCPActionPanelState,
} from "../src/overlays/extensions/mcp-action-panel";
import type { Extension } from "../src/overlays/extensions/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme(false);
});

const extension: Extension = {
	id: "mcp:github",
	kind: "mcp",
	name: "github",
	displayName: "github",
	path: "/tmp/github-mcp.json",
	source: { provider: "native", providerName: "Native", level: "user" },
	state: "active",
	raw: {},
};

function action(id: MCPActionId, requiresConfirmation = false): MCPActionItem {
	return { id, label: id, description: `${id} description`, enabled: true, requiresConfirmation };
}

function state(actions: MCPActionItem[]): MCPActionPanelState {
	return {
		name: "github",
		connectionStatus: "connected",
		transport: "http",
		source: "Native user",
		authentication: "OAuth (managed by OMP)",
		tools: 3,
		prompts: 1,
		resources: 2,
		actions,
	};
}

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("MCPActionPanel", () => {
	test("requires a second confirmation before clearing authentication", async () => {
		const calls: MCPActionId[] = [];
		const didChange = Promise.withResolvers<void>();
		const runtime: MCPActionPanelRuntime = {
			loadState: async () => state([action("clear-authentication", true)]),
			runAction: async (_extension, id) => {
				calls.push(id);
				return "Authentication cleared.";
			},
		};
		const panel = new MCPActionPanel(extension, state([action("clear-authentication", true)]), runtime, 24);
		panel.onChanged = () => didChange.resolve();

		panel.handleInput("\r");
		expect(calls).toEqual([]);
		expect(panel.render(80).join("\n")).toContain("Press Enter again to confirm this action.");

		panel.handleInput("\r");
		await didChange.promise;
		expect(calls).toEqual(["clear-authentication"]);
	});

	test("accepts a bracketed-paste OAuth callback without corrupting it", async () => {
		let manualInput = "";
		const runtime: MCPActionPanelRuntime = {
			loadState: async () => state([action("reauthenticate")]),
			runAction: async (_extension, _id, context) => {
				manualInput = await context.requestManualInput(context.signal);
				return "Authenticated.";
			},
		};
		const panel = new MCPActionPanel(extension, state([action("reauthenticate")]), runtime, 24);

		panel.handleInput("\r");
		await flushAsyncWork();
		panel.handleInput("\x1b[200~http://localhost/callback?code=abc\x1b[106;5u&state=xyz\x1b[201~");
		panel.handleInput("\r");
		await flushAsyncWork();

		expect(manualInput).toBe("http://localhost/callback?code=abc&state=xyz");
	});

	test("accepts batched printable OAuth input", async () => {
		let manualInput = "";
		const runtime: MCPActionPanelRuntime = {
			loadState: async () => state([action("reauthenticate")]),
			runAction: async (_extension, _id, context) => {
				manualInput = await context.requestManualInput(context.signal);
				return "Authenticated.";
			},
		};
		const panel = new MCPActionPanel(extension, state([action("reauthenticate")]), runtime, 24);

		panel.handleInput("\r");
		await flushAsyncWork();
		panel.handleInput("http://localhost/callback?code=abc&state=xyz");
		panel.handleInput("\r");
		await flushAsyncWork();

		expect(manualInput).toBe("http://localhost/callback?code=abc&state=xyz");
	});

	test("Escape aborts an in-flight action and keeps the panel open", async () => {
		let aborted = false;
		let closed = 0;
		const runtime: MCPActionPanelRuntime = {
			loadState: async () => state([action("reconnect")]),
			runAction: async (_extension, _id, context) =>
				await new Promise<string>((_resolve, reject) => {
					context.signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(new DOMException("cancelled", "AbortError"));
						},
						{ once: true },
					);
				}),
		};
		const panel = new MCPActionPanel(extension, state([action("reconnect")]), runtime, 24);
		panel.onClose = () => closed++;

		panel.handleInput("\r");
		await flushAsyncWork();
		panel.handleInput("\x1b");
		await flushAsyncWork();

		expect(aborted).toBe(true);
		expect(closed).toBe(0);
		expect(panel.render(80).join("\n")).toContain("Action cancelled.");
	});

	test("Escape cancels pending OAuth input as cancellation", async () => {
		const runtime: MCPActionPanelRuntime = {
			loadState: async () => state([action("reauthenticate")]),
			runAction: async (_extension, _id, context) => {
				await context.requestManualInput(context.signal);
				return "Authenticated.";
			},
		};
		const panel = new MCPActionPanel(extension, state([action("reauthenticate")]), runtime, 24);

		panel.handleInput("\r");
		await flushAsyncWork();
		panel.handleInput("\x1b");
		await flushAsyncWork();

		expect(panel.render(80).join("\n")).toContain("Action cancelled.");
	});

	test("sanitizes every server-controlled field before rendering", () => {
		const maliciousState: MCPActionPanelState = {
			...state([
				{
					...action("test"),
					label: "Test\x1b[2J label",
					description: "Description\x1b]0;owned\x07 safe",
				},
			]),
			name: "github\x1b]8;;https://evil.example\x07 spoof\x1b]8;;\x07",
			transport: "http\x1b[2J",
			source: "Native\x1b]0;owned\x07 user",
			authentication: "OAuth\x1b[31m managed",
			lastError: "Failed\x1b]0;owned\x07 safely",
		};
		const runtime: MCPActionPanelRuntime = {
			loadState: async () => maliciousState,
			runAction: async () => "unused",
		};

		const rendered = new MCPActionPanel(extension, maliciousState, runtime, 24).render(160).join("\n");

		expect(rendered).not.toContain("\x1b]");
		expect(rendered).not.toContain("\x07");
		expect(rendered).not.toContain("\x1b[2J");
		expect(Bun.stripANSI(rendered)).toContain("github spoof");
		expect(Bun.stripANSI(rendered)).toContain("Failed safely");
	});

	test("keeps OAuth, manual input, results, and the footer visible at minimum height", async () => {
		const continueToInput = Promise.withResolvers<void>();
		const didChange = Promise.withResolvers<void>();
		let manualInput = "";
		const actions = [
			action("test"),
			action("reconnect"),
			action("reauthenticate"),
			action("clear-authentication"),
			action("disable"),
		];
		const runtime: MCPActionPanelRuntime = {
			loadState: async () => state(actions),
			runAction: async (_extension, _id, context) => {
				context.onAuthorization({
					instructions: "Open the browser\x1b[2J now",
					url: "https://auth.example/callback\x1b]0;owned\x07",
				});
				await continueToInput.promise;
				manualInput = await context.requestManualInput(context.signal);
				return "Authenticated\x1b]0;owned\x07 safely\nsecond line";
			},
		};
		const panel = new MCPActionPanel(extension, state(actions), runtime, 14);
		panel.onChanged = () => didChange.resolve();

		panel.handleInput("\r");
		await flushAsyncWork();
		const oauthFrame = panel.render(120);
		const oauthText = oauthFrame.join("\n");
		expect(oauthFrame).toHaveLength(14);
		expect(Bun.stripANSI(oauthText)).toContain("Open the browser now");
		expect(Bun.stripANSI(oauthText)).toContain("https://auth.example/callback");
		expect(Bun.stripANSI(oauthText)).toContain("Esc: cancel action · Ctrl+C: close");
		expect(oauthText).not.toContain("\x1b[2J");
		expect(oauthText).not.toContain("\x1b]");
		expect(oauthText).not.toContain("\x07");

		continueToInput.resolve();
		await flushAsyncWork();
		panel.handleInput("\x1b[200~code=abc\x1b]0;owned\x07\x1b[201~");
		const manualFrame = panel.render(120).join("\n");
		expect(Bun.stripANSI(manualFrame)).toContain("code=abc");
		expect(Bun.stripANSI(manualFrame)).toContain("Esc: cancel action · Ctrl+C: close");
		expect(manualFrame).not.toContain("\x1b]");
		expect(manualFrame).not.toContain("\x07");

		panel.handleInput("\r");
		await didChange.promise;
		expect(manualInput).toContain("code=abc");
		const resultFrame = panel.render(120);
		const resultText = resultFrame.join("\n");
		expect(resultFrame).toHaveLength(14);
		expect(Bun.stripANSI(resultText)).toContain("Authenticated safely");
		expect(Bun.stripANSI(resultText)).toContain("second line");
		expect(Bun.stripANSI(resultText)).toContain("↑/↓: select · Enter: run · Esc: back · Ctrl+C: close");
		expect(resultText).not.toContain("\x1b]");
		expect(resultText).not.toContain("\x07");
	});
});
