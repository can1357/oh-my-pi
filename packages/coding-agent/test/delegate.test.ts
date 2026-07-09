import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import type { InteractiveModeContext } from "../src/modes/types";
import { handleDelegateSlashCommand, looksLikeBrowserAutomationTask } from "../src/slash-commands/helpers/delegate";
import * as subagentModule from "../src/slash-commands/helpers/subagent";

// Spy on subagent helpers to avoid actual network/subprocess creation.
const spawnSpy = vi.spyOn(subagentModule, "spawnSubagent").mockImplementation(async () => "spawned-id");
const resolveModelSpy = vi
	.spyOn(subagentModule, "resolveSlashSubagentModel")
	.mockImplementation(async (_ctx, input) => {
		if (input === "nope") return null;
		return {
			selector: input,
			model: {
				id: input,
				provider: "google",
				name: "Mock Model",
			} as unknown as Model<Api>,
		};
	});

afterEach(() => {
	vi.clearAllMocks();
});

describe("looksLikeBrowserAutomationTask", () => {
	test("classifies browser tasks correctly", () => {
		expect(looksLikeBrowserAutomationTask("click the login button")).toBe(true);
		expect(looksLikeBrowserAutomationTask("open the web dashboard and click Settings")).toBe(true);
		expect(looksLikeBrowserAutomationTask("navigate to example.com")).toBe(true);
		expect(looksLikeBrowserAutomationTask("screenshot the page")).toBe(true);
	});

	test("does not classify non-browser tasks", () => {
		expect(looksLikeBrowserAutomationTask("refactor the parser")).toBe(false);
		expect(looksLikeBrowserAutomationTask("fix a bug in code")).toBe(false);
	});
});

describe("/delegate command routing", () => {
	const mockShowStatus = vi.fn();
	const mockShowError = vi.fn();
	const mockUiStop = vi.fn();
	const mockUiStart = vi.fn();
	const mockUiRequestRender = vi.fn();

	function makeContext(settings: Record<string, unknown>): InteractiveModeContext {
		return {
			settings: {
				get: (key: string) => settings[key],
			},
			session: {
				modelRegistry: {},
				getPlanModeState: () => ({ enabled: false }),
				getPlanReferencePath: () => "",
				getAgentId: () => "test-agent",
				skills: [],
				promptTemplates: [],
			},
			sessionManager: {
				getCwd: () => process.cwd(),
				getSessionFile: () => null,
				getArtifactsDir: () => null,
				getArtifactManager: () => null,
				ensureOnDisk: async () => {},
			},
			ui: {
				stop: mockUiStop,
				start: mockUiStart,
				requestRender: mockUiRequestRender,
			},
			showStatus: mockShowStatus,
			showError: mockShowError,
		} as unknown as InteractiveModeContext;
	}

	test("/delegate using browser-fast click the login button resolves alias and spawns browser-operation", async () => {
		const ctx = makeContext({
			"subagent.modelAliases": { "browser-fast": "google/gemini-2.5-flash-lite" },
			"delegate.mode": "subagents",
		});

		await handleDelegateSlashCommand("using browser-fast click the login button", ctx);

		expect(resolveModelSpy).toHaveBeenCalledWith(ctx, "browser-fast");
		expect(spawnSpy).toHaveBeenCalled();
		const spawnArgs = spawnSpy.mock.calls[0];
		expect(spawnArgs[2]).toBe("browser-operation");
		expect(spawnArgs[1].modelOverride).toBe("browser-fast");
		expect(spawnArgs[1].task).toContain("Primary browser tool is IX Bridge");
		expect(mockShowStatus).toHaveBeenCalledWith(
			"Spawned delegate lane spawned-id (browser-operation) on browser-fast.",
		);
	});

	test("/delegate open the web dashboard and click Settings routes to browser-operation with browser-fast model", async () => {
		const ctx = makeContext({
			"delegate.mode": "subagents",
			"delegate.lanes": {},
		});

		await handleDelegateSlashCommand("open the web dashboard and click Settings", ctx);

		expect(resolveModelSpy).toHaveBeenCalledWith(ctx, "browser-fast");
		expect(spawnSpy).toHaveBeenCalled();
		const spawnArgs = spawnSpy.mock.calls[0];
		expect(spawnArgs[2]).toBe("browser-operation");
		expect(spawnArgs[1].modelOverride).toBe("browser-fast");
		expect(mockShowStatus).toHaveBeenCalledWith(
			"Spawned delegate lane spawned-id (browser-operation) on browser-fast.",
		);
	});

	test("/delegate refactor the parser uses configured delegate.lanes and does not route to browser-operation", async () => {
		const ctx = makeContext({
			"delegate.mode": "subagents",
			"delegate.lanes": {
				fast: "pi/smol",
				verifier: "pi/task",
			},
		});

		await handleDelegateSlashCommand("refactor the parser", ctx);

		expect(resolveModelSpy).toHaveBeenCalledWith(ctx, "pi/smol");
		expect(resolveModelSpy).toHaveBeenCalledWith(ctx, "pi/task");
		expect(spawnSpy).toHaveBeenCalledTimes(2);

		const firstSpawn = spawnSpy.mock.calls[0];
		expect(firstSpawn[2]).toBe("task");
		expect(firstSpawn[1].modelOverride).toBe("pi/smol");

		const secondSpawn = spawnSpy.mock.calls[1];
		expect(secondSpawn[2]).toBe("task");
		expect(secondSpawn[1].modelOverride).toBe("pi/task");

		expect(mockShowStatus).toHaveBeenCalledWith("Spawned delegate lane spawned-id (fast) on pi/smol.");
		expect(mockShowStatus).toHaveBeenCalledWith("Spawned delegate lane spawned-id (verifier) on pi/task.");
	});

	test("unknown selector in /delegate using nope task returns exact error message", async () => {
		const ctx = makeContext({
			"delegate.mode": "subagents",
		});

		await handleDelegateSlashCommand("using nope task", ctx);

		expect(mockShowError).toHaveBeenCalledWith('No available delegate model matched "nope" for lane "fast".');
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	test("delegate.mode=legacy-endpoint with missing legacy script returns missing-script error", async () => {
		// Mock config files and settings
		const ctx = makeContext({
			"delegate.mode": "legacy-endpoint",
			"delegate.legacyEndpointConfigPath": "~/.claude/custom-endpoint.json",
		});

		// Temporarily spy on fs.stat to simulate missing script
		const statSpy = vi.spyOn(fs, "stat").mockRejectedValue(new Error("ENOENT"));

		try {
			await handleDelegateSlashCommand("some task", ctx);

			const expectedPath = path.resolve(os.homedir(), ".claude/bin/dispatch-endpoint.mjs");
			expect(mockShowError).toHaveBeenCalledWith(
				`Legacy delegate endpoint not found: ${expectedPath}. Set delegate.mode=subagents or install dispatch-endpoint.mjs.`,
			);
		} finally {
			statSpy.mockRestore();
		}
	});
});
