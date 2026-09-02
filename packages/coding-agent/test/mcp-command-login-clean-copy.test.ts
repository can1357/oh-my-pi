import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, type Mock, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import * as oauthFlow from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import * as smitheryAuth from "@oh-my-pi/pi-coding-agent/mcp/smithery-auth";
import * as smitheryRegistry from "@oh-my-pi/pi-coding-agent/mcp/smithery-registry";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { OAuthManualInputManager } from "@oh-my-pi/pi-coding-agent/modes/oauth-manual-input";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { loginUrlCopyCommand, loginUrlWritesSettled } from "@oh-my-pi/pi-coding-agent/utils/login-url";
import * as openModule from "@oh-my-pi/pi-coding-agent/utils/open";
import type { Component } from "@oh-my-pi/pi-tui";
import { getConfigRootDir, getProjectDir, removeWithRetries, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";

const AUTH_ERROR = new Error(
	'HTTP 401: {"authorization_url":"https://auth.example.com/authorize","token_url":"https://auth.example.com/token"}',
);

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function createController(authStorage: AuthStorage) {
	const present = vi.fn();
	const showStatus = vi.fn();
	const ctx = {
		chatContainer: { addChild: vi.fn() },
		present,
		presentCommandOutput: present,
		ui: { requestRender: vi.fn() },
		editor: {},
		showError: vi.fn(),
		showStatus,
		oauthManualInput: new OAuthManualInputManager(),
		settings: { get: vi.fn((_key: string): unknown => undefined) },
		session: {
			refreshMCPTools: vi.fn(),
			setMCPPromptCommands: vi.fn(),
			modelRegistry: { authStorage },
		},
		mcpManager: {
			prepareConfig: vi.fn(async (config: unknown) => config),
			disconnectAll: vi.fn(async () => {}),
			discoverAndConnect: vi.fn(async () => ({ errors: new Map<string, string>() })),
			getTools: vi.fn(() => []),
			waitForConnection: vi.fn(async () => {}),
			getConnectionStatus: vi.fn(() => "connected"),
		},
	} as never;
	return { controller: new MCPCommandController(ctx), present, showStatus };
}

/**
 * Every component `ctx.present`/`ctx.presentCommandOutput` received, rendered
 * at `width` and ANSI-stripped into one flat row list.
 */
function renderPresented(present: Mock<(...args: unknown[]) => unknown>, width: number): string[] {
	const rows: string[] = [];
	for (const call of present.mock.calls) {
		for (const arg of call as unknown[]) {
			for (const component of Array.isArray(arg) ? arg : [arg]) {
				const rendered = (component as Component | undefined)?.render?.(width);
				if (rendered) rows.push(...rendered.map(row => Bun.stripANSI(row)));
			}
		}
	}
	return rows;
}

/**
 * Reassemble the clean-copy command from rendered rows. Both fixed surfaces
 * render it through a paddingX=1 component, so content occupies columns
 * [1, width - 1); full rows fill that span exactly and only the tail row
 * carries right padding.
 */
function joinCleanCopyRows(rows: string[], width: number, expected: string): string {
	const contentWidth = width - 2;
	const first = rows.findIndex(row => row.slice(1).startsWith("Clean copy: "));
	expect(first).toBeGreaterThanOrEqual(0);
	return rows
		.slice(first, first + Math.ceil(expected.length / contentWidth))
		.map(row => row.slice(1, 1 + contentWidth))
		.join("")
		.trimEnd();
}

describe("mcp-command-controller clean-copy rendering", () => {
	let projectDir = "";
	let agentDir = "";
	const openAuthStores: AuthStorage[] = [];
	function freshAuthStorage(): AuthStorage {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		openAuthStores.push(storage);
		return storage;
	}

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-clean-copy-project-"));
		// The spaced dir is the trigger: it forces quoting and pushes the
		// command past the render width.
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp login spaced agent dir "));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
		vi.spyOn(openModule, "openPath").mockImplementation(() => true);
		vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		// A persisted-URL write still in flight would re-create the temp agent
		// dir after the removal below.
		await loginUrlWritesSettled();
		while (openAuthStores.length > 0) openAuthStores.pop()?.close();
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	// Same defect class as the wizard panel and login dialog (codex
	// r3911391657): plain `Text` word-wraps the clean-copy row and swallows
	// the space at each break, so a spaced agent dir displayed a command
	// whose path does not exist.
	test("OAuth panel keeps the clean-copy command byte-complete at narrow width", async () => {
		await Bun.write(
			path.join(projectDir, ".mcp.json"),
			`${JSON.stringify({ mcpServers: { envserver: { type: "http", url: "https://mcp.example.com/mcp" } } })}\n`,
		);
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				this.ctrl.onAuth?.({ url: "https://auth.example.com/authorize?state=narrow" });
				return { access: "fresh-access", refresh: "fresh-refresh", expires: Date.now() + 3_600_000 };
			},
		);
		const { controller, present } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		// The persisted-URL write is fire-and-forget off the render path.
		await loginUrlWritesSettled();
		const urlFileName = (await fs.readdir(agentDir)).find(name => name.startsWith("login-url-"));
		expect(urlFileName).toBeDefined();
		const expected = `Clean copy: ${loginUrlCopyCommand(path.join(agentDir, urlFileName as string))}`;

		const width = 40;
		// Premise: the spaced agent dir must actually overflow the row.
		expect(expected.length).toBeGreaterThan(width);
		const rows = renderPresented(present, width);
		expect(joinCleanCopyRows(rows, width, expected)).toBe(expected);
	});

	test("Smithery login message keeps the clean-copy command byte-complete at narrow width", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		vi.spyOn(smitheryAuth, "createSmitheryCliAuthSession").mockResolvedValue({
			sessionId: "session-1",
			authUrl: "https://smithery.ai/auth/cli?session=session-1",
		});
		vi.spyOn(smitheryAuth, "pollSmitheryCliAuthSession").mockResolvedValue({
			status: "success",
			apiKey: "smithery-test-key",
		});
		vi.spyOn(smitheryAuth, "saveSmitheryApiKey").mockResolvedValue(undefined);
		vi.spyOn(smitheryRegistry, "searchSmitheryRegistry").mockResolvedValue([]);
		const { controller, present, showStatus } = createController(authStorage);

		await controller.handle("/mcp smithery-login");

		expect(showStatus).toHaveBeenCalledWith("Smithery API key saved.");
		await loginUrlWritesSettled();
		const urlFileName = (await fs.readdir(agentDir)).find(name => name.startsWith("login-url-"));
		expect(urlFileName).toBeDefined();
		const expected = `Clean copy: ${loginUrlCopyCommand(path.join(agentDir, urlFileName as string))}`;

		const width = 40;
		expect(expected.length).toBeGreaterThan(width);
		const rows = renderPresented(present, width);
		expect(joinCleanCopyRows(rows, width, expected)).toBe(expected);
	});
});
