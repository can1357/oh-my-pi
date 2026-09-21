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
});
