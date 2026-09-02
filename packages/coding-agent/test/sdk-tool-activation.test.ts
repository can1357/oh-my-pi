import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import * as memoryBackendModule from "@oh-my-pi/pi-coding-agent/memory-backend";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import {
	type CreateAgentSessionOptions,
	type CustomTool,
	createAgentSession,
	discoverAuthStorage,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { logger, removeSyncWithRetries, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";

const toolActivationExtension: ExtensionFactory = pi => {
	pi.registerTool({
		name: "default_inactive_tool",
		label: "Default Inactive Tool",
		description: "Tool hidden from the initial active set unless explicitly requested.",
		parameters: type({}),
		defaultInactive: true,
		async execute() {
			return { content: [{ type: "text", text: "inactive" }] };
		},
	});
	pi.registerTool({
		name: "default_active_tool",
		label: "Default Active Tool",
		description: "Tool included in the initial active set.",
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: "active" }] };
		},
	});
};

const sdkCustomTool = {
	name: "sdk_custom_tool",
	label: "SDK Custom Tool",
	description: "SDK-provided custom tool used to verify activation boundaries.",
	parameters: type({}),
	async execute() {
		return { content: [{ type: "text", text: "sdk custom" }] };
	},
} satisfies CustomTool;

describe("createAgentSession defaultInactive tool activation", () => {
	const tempDirs: string[] = [];

	// Built once and shared by every session. `ModelRegistry` eagerly loads all
	// bundled + cached models and `discoverAuthStorage` opens the auth DB — the
	// dominant (~50ms) slice of a cold boot, and identical for every test here.
	// Injecting it drops each per-test boot to the ~4ms of activation-specific work
	// these tests vary, and skips the background model refresh the SDK would
	// otherwise start when it builds its own registry.
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
	});

	// Shared options for every session. `rules: []` and `workspaceTree` short-circuit
	// the two slow startup scans (rule discovery + native workspace walk, ~100ms each)
	// that are irrelevant to tool activation: these tests assert only which tools are
	// registered/active and that tool names appear in the system prompt. The shared
	// `modelRegistry` is injected here; each call still returns fresh
	// `settings`/`sessionManager` instances to keep tests isolated.
	const baseOptions = (tempDir: string): CreateAgentSessionOptions => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});

	const requireBundledModel = (provider: "anthropic" | "google" | "openai" | "xai", id: string): Model => {
		const bundled = getBundledModel(provider, id);
		if (!bundled) throw new Error(`Expected ${provider}/${id} model to exist`);
		return bundled;
	};

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}

		vi.restoreAllMocks();
		testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
	});

	afterAll(() => {
		removeSyncWithRetries(registryAuthDir);
	});

	it("excludes defaultInactive extension tools from the initial active set unless explicitly requested", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [toolActivationExtension],
		});

		try {
			expect(session.getAllToolNames()).toEqual(
				expect.arrayContaining(["default_active_tool", "default_inactive_tool"]),
			);
			// Discoverable extension tools mount as xd:// devices, not top-level active tools.
			const deviceNames = session.getXdevToolEntries().map(entry => entry.name);
			expect(deviceNames).toContain("default_active_tool");
			expect(session.getToolByName("xd://default_active_tool")?.name).toBe("default_active_tool");
			expect(session.getActiveToolNames()).not.toContain("default_active_tool");
			expect(deviceNames).not.toContain("default_inactive_tool");
			expect(session.getActiveToolNames()).not.toContain("default_inactive_tool");
			expect(session.systemPrompt.join("\n")).toContain("default_active_tool");
			expect(session.systemPrompt.join("\n")).not.toContain("default_inactive_tool");

			// Presentation lookup must survive Code Mode clearing the live mount set
			// so historical prefixed calls retain their canonical renderer.
			await session.setActiveToolPresentation(session.getActiveToolNames(), []);
			expect(session.getMountedXdevToolNames()).not.toContain("default_active_tool");
			expect(session.getToolByName("xd://default_active_tool")?.name).toBe("default_active_tool");
		} finally {
			await session.dispose();
		}
	});

	it("mounts discoverable tools under xd:// for explicit tool lists omitting write", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "grep", "glob"],
			extensions: [toolActivationExtension],
		});

		try {
			// The device-only xd:// transport write is surfaced in the active set...
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "grep", "glob", "write"]));
			// ...so a discoverable extension tool mounts under xd:// instead of
			// shipping its full schema top-level on every request.
			const deviceNames = session.getXdevToolEntries().map(entry => entry.name);
			expect(deviceNames).toContain("default_active_tool");
			expect(session.getActiveToolNames()).not.toContain("default_active_tool");
			expect(session.getActiveToolNames()).not.toContain("default_inactive_tool");

			// The transport write rejects filesystem targets: the grant is xd:// only.
			const write = session.getToolByName("write");
			expect(write).toBeDefined();
			await expect(
				write!.execute("device-only-fs", { path: path.join(tempDir, "nope.txt"), content: "x" }),
			).rejects.toThrow("Filesystem writes are not available");
		} finally {
			await session.dispose();
		}
	});

	it("preserves a deferrable-only write transport across enabled-set reapplication", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "ast_edit"],
		});

		try {
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "ast_edit", "write"]));
			expect(session.getMountedXdevToolNames()).toEqual([]);
			const write = session.getToolByName("write");
			expect(write).toBeDefined();
			await expect(
				write!.execute("deferrable-transport-before", {
					path: path.join(tempDir, "before.txt"),
					content: "x",
				}),
			).rejects.toThrow("Filesystem writes are not available");

			await session.setActiveToolsByName(session.getEnabledToolNames());

			await expect(
				write!.execute("deferrable-transport-after", {
					path: path.join(tempDir, "after.txt"),
					content: "x",
				}),
			).rejects.toThrow("Filesystem writes are not available");
		} finally {
			await session.dispose();
		}
	});

	it("activates the private think tool when external thinking is enabled at runtime", async () => {
		const tempDir = makeTempDir();
		const settings = Settings.isolated();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			model: requireBundledModel("openai", "gpt-5"),
			settings,
		});

		try {
			expect(session.getToolByName("think")).toBeUndefined();
			expect(session.getActiveToolNames()).not.toContain("think");

			settings.set("externalThinking", true);
			await session.setThinkToolEnabled(true);

			expect(session.getToolByName("think")).toBeDefined();
			expect(session.getActiveToolNames()).toContain("think");
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain("think");

			settings.set("externalThinking", false);
			await session.setThinkToolEnabled(false);
			expect(session.getActiveToolNames()).not.toContain("think");
		} finally {
			await session.dispose();
		}
	});

	it("exposes the private think tool only on transports that can disable native reasoning", async () => {
		const tempDir = makeTempDir();
		const settings = Settings.isolated({ externalThinking: true });
		const unsupported = requireBundledModel("xai", "grok-4");
		const fable = requireBundledModel("anthropic", "claude-fable-5");
		const responses = requireBundledModel("openai", "gpt-5");
		const gemini = requireBundledModel("google", "gemini-2.5-flash");
		const mandatoryGemini = requireBundledModel("google", "gemini-2.5-pro");
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings,
			model: unsupported,
		});
		const authStorage = session.modelRegistry.authStorage;
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		authStorage.setRuntimeApiKey("google", "test-key");
		authStorage.setRuntimeApiKey("xai", "test-key");

		try {
			expect(session.getActiveToolNames()).not.toContain("think");

			await session.setModel(fable);
			expect(session.getToolByName("think")).toBeDefined();
			expect(session.getActiveToolNames()).toContain("think");
			expect(session.systemPrompt.join("\n")).toContain("other tools become callable when it completes");

			await session.setModel(responses);
			expect(session.getActiveToolNames()).toContain("think");
			await session.setModel(gemini);
			expect(session.getActiveToolNames()).toContain("think");
			await session.setModel(mandatoryGemini);
			expect(session.getActiveToolNames()).not.toContain("think");

			await session.setModel(unsupported);
			expect(session.getActiveToolNames()).not.toContain("think");
			expect(session.systemPrompt.join("\n")).not.toContain("other tools become callable when it completes");
		} finally {
			await session.dispose();
		}
	});

	it("forces think and sends reasoning effort off for a Responses turn", async () => {
		const tempDir = makeTempDir();
		const settings = Settings.isolated({ externalThinking: true });
		const requestTexts: string[] = [];
		const sse = (events: unknown[]): Response =>
			new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		const completed = (id: string) => ({
			type: "response.completed",
			response: {
				id,
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		});
		const server = Bun.serve({
			port: 0,
			fetch: async request => {
				requestTexts.push(await request.text());
				if (requestTexts.length === 1) {
					const argumentsJson = JSON.stringify({ thoughts: "Checked the request before answering." });
					return sse([
						{
							type: "response.output_item.added",
							output_index: 0,
							item: {
								type: "function_call",
								id: "fc_think",
								call_id: "call_think",
								name: "think",
								arguments: "",
							},
						},
						{
							type: "response.function_call_arguments.done",
							output_index: 0,
							item_id: "fc_think",
							arguments: argumentsJson,
						},
						{
							type: "response.output_item.done",
							output_index: 0,
							item: {
								type: "function_call",
								id: "fc_think",
								call_id: "call_think",
								name: "think",
								arguments: argumentsJson,
							},
						},
						completed("resp_think"),
					]);
				}
				return sse([
					{ type: "response.output_text.delta", output_index: 0, delta: "Done." },
					{
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "message",
							id: "msg_done",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Done." }],
						},
					},
					completed("resp_done"),
				]);
			},
		});
		const model = requireBundledModel("openai", "gpt-5");
		// The prompt preflight validates the key through the registry (not the
		// per-request `getApiKey` override), so seed it for keyless CI runners.
		modelRegistry.authStorage.setRuntimeApiKey("openai", "test-key");
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings,
			model: { ...model, baseUrl: `${server.url}v1` },
			getApiKey: () => "test-key",
		});
		expect(session.getActiveToolNames()).toContain("think");

		try {
			await session.prompt("Use the scratchpad before answering.");
			const firstRequest = requestTexts.at(0);
			if (!firstRequest) throw new Error("Expected the initial provider request.");
			expect(requestTexts).toHaveLength(2);
			expect(JSON.parse(firstRequest)).toEqual(
				expect.objectContaining({
					// "none" is the only disable level the Responses wire accepts ("off" 400s).
					reasoning: { effort: "none" },
					tool_choice: expect.objectContaining({ name: "think" }),
				}),
			);
		} finally {
			await session.dispose();
			server.stop(true);
		}
	});

	it("publishes tools from lazy session startup before the input lifecycle completes", async () => {
		const tempDir = makeTempDir();
		const startupGate = Promise.withResolvers<void>();
		const lateRegistrationExtension: ExtensionFactory = pi => {
			let startupPromise: Promise<void> | undefined;
			pi.on("session_start", () => {
				startupPromise = (async () => {
					await startupGate.promise;
					pi.registerTool({
						name: "late_active_tool",
						label: "Late Active Tool",
						description: "Registered after asynchronous session initialization.",
						parameters: type({}),
						async execute() {
							return { content: [{ type: "text", text: "late active" }] };
						},
					});
					pi.registerTool({
						name: "late_inactive_tool",
						label: "Late Inactive Tool",
						description: "Registered late but left disabled by default.",
						parameters: type({}),
						defaultInactive: true,
						async execute() {
							return { content: [{ type: "text", text: "late inactive" }] };
						},
					});
				})();
			});
			pi.on("input", async () => {
				await startupPromise;
				await pi.setActiveTools([...pi.getActiveTools(), "late_active_tool"]);
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [lateRegistrationExtension],
		});

		try {
			expect(session.getAllToolNames()).not.toContain("late_active_tool");
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			const errors: string[] = [];
			const unsubscribe = runner.onError(error => {
				errors.push(error.error);
			});
			await initializeExtensions(session, {
				reportSendError: vi.fn(),
				reportRuntimeError: vi.fn(),
			});
			expect(session.getAllToolNames()).not.toContain("late_active_tool");
			startupGate.resolve();
			await runner.emitInput("probe", undefined, "interactive");
			unsubscribe();
			expect(errors).toEqual([]);

			expect(session.getAllToolNames()).toEqual(expect.arrayContaining(["late_active_tool", "late_inactive_tool"]));
			expect(session.getEnabledToolNames()).toContain("late_active_tool");
			expect(session.getEnabledToolNames()).not.toContain("late_inactive_tool");
			expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("late_active_tool");
			expect(session.getActiveToolNames()).not.toContain("late_active_tool");
			expect(session.systemPrompt.join("\n")).toContain("late_active_tool");
			expect(session.systemPrompt.join("\n")).not.toContain("late_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("mounts late extension tools through a dormant read-only transport", async () => {
		const tempDir = makeTempDir();
		const lateDeviceExtension: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				await Promise.resolve();
				pi.registerTool({
					name: "late_device_tool",
					label: "Late Device Tool",
					description: "Registered after dormant transport startup.",
					parameters: type({}),
					async execute() {
						return { content: [{ type: "text", text: "late device" }] };
					},
				});
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [lateDeviceExtension],
			toolNames: ["read"],
		});

		try {
			expect(session.getActiveToolNames()).not.toContain("write");
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			await runner.emit({ type: "session_start" });

			expect(session.getActiveToolNames()).toContain("write");
			expect(session.getActiveToolNames()).not.toContain("late_device_tool");
			expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("late_device_tool");
			const write = session.getToolByName("write");
			if (!write) throw new Error("expected dormant write transport");
			await expect(
				write.execute("late-device-fs", { path: path.join(tempDir, "nope.txt"), content: "x" }),
			).rejects.toThrow("Filesystem writes are not available");
		} finally {
			await session.dispose();
		}
	});

	it("activates explicitly requested defaultInactive tools registered during session startup", async () => {
		const tempDir = makeTempDir();
		const lateRequestedExtension: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				await Promise.resolve();
				pi.registerTool({
					name: "late_requested_tool",
					label: "Late Requested Tool",
					description: "Registered asynchronously after being explicitly requested.",
					parameters: type({}),
					defaultInactive: true,
					async execute() {
						return { content: [{ type: "text", text: "late requested" }] };
					},
				});
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [lateRequestedExtension],
			toolNames: ["read", "write", "late_requested_tool"],
		});

		try {
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			await runner.emit({ type: "session_start" });

			expect(session.getAllToolNames()).toContain("late_requested_tool");
			expect(session.getEnabledToolNames()).toContain("late_requested_tool");
			expect(session.getActiveToolNames()).toContain("late_requested_tool");
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain("late_requested_tool");
			expect(session.systemPrompt.join("\n")).toContain("late_requested_tool");
		} finally {
			await session.dispose();
		}
	});

	it("deactivates an enabled tool when a late replacement is default-inactive", async () => {
		const tempDir = makeTempDir();
		const lateInactiveReplacement: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				await Promise.resolve();
				pi.registerTool({
					name: "bash",
					label: "Late Inactive Bash",
					description: "A late replacement that must remain disabled by default.",
					parameters: type({}),
					defaultInactive: true,
					async execute() {
						return { content: [{ type: "text", text: "late inactive bash" }] };
					},
				});
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [lateInactiveReplacement],
		});

		try {
			expect(session.getEnabledToolNames()).toContain("bash");
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			await runner.emit({ type: "session_start" });

			expect(session.getToolByName("bash")?.label).toBe("Late Inactive Bash");
			expect(session.hasBuiltInTool("bash")).toBe(false);
			expect(session.getEnabledToolNames()).not.toContain("bash");
			expect(session.getActiveToolNames()).not.toContain("bash");
			expect(session.getMountedXdevToolNames()).not.toContain("bash");
		} finally {
			await session.dispose();
		}
	});

	it("publishes late tools before returning from a failing lifecycle handler", async () => {
		const tempDir = makeTempDir();
		const activationEntered = Promise.withResolvers<void>();
		const releaseActivation = Promise.withResolvers<void>();
		const failingRegistrationExtension: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				await Promise.resolve();
				pi.registerTool({
					name: "late_tool_before_failure",
					label: "Late Tool Before Failure",
					description: "Registered before its lifecycle handler fails.",
					parameters: type({}),
					async execute() {
						return { content: [{ type: "text", text: "late tool before failure" }] };
					},
				});
				throw new Error("expected lifecycle failure");
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [failingRegistrationExtension],
		});
		const originalSetPresentation = session.setActiveToolPresentation.bind(session);
		vi.spyOn(session, "setActiveToolPresentation").mockImplementation(async (toolNames, mountedToolNames) => {
			activationEntered.resolve();
			await releaseActivation.promise;
			await originalSetPresentation(toolNames, mountedToolNames);
		});
		const runner = session.extensionRunner;
		if (!runner) throw new Error("expected extension runner");
		let emissionCompleted = false;
		const emission = runner.emit({ type: "session_start" }).finally(() => {
			emissionCompleted = true;
		});

		try {
			await activationEntered.promise;
			// Drain the handler rejection and outer emit continuations without releasing the registration apply.
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(emissionCompleted).toBe(false);

			releaseActivation.resolve();
			await emission;
			expect(session.getAllToolNames()).toContain("late_tool_before_failure");
			expect(session.getEnabledToolNames()).toContain("late_tool_before_failure");
			expect(session.systemPrompt.join("\n")).toContain("late_tool_before_failure");
		} finally {
			releaseActivation.resolve();
			await emission;
			await session.dispose();
		}
	});

	it("keeps the stable MCP tool-name collision winner during late registration", async () => {
		const tempDir = makeTempDir();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const lateMcpCollisionExtension: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				await Promise.resolve();
				for (const [serverName, label] of [
					["foo.bar", "foo.bar/lookup"],
					["foo_bar", "foo_bar/lookup"],
				] as const) {
					pi.registerTool({
						name: "mcp__foo_bar_lookup",
						label,
						description: `Lookup from ${serverName}`,
						parameters: type({}),
						mcpServerName: serverName,
						mcpToolName: "lookup",
						async execute() {
							return { content: [{ type: "text", text: serverName }] };
						},
					});
				}
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [lateMcpCollisionExtension],
		});

		try {
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			await runner.emit({ type: "session_start" });

			expect(session.getToolByName("mcp__foo_bar_lookup")?.label).toBe("foo.bar/lookup");
			await session.refreshMCPTools([
				{
					name: "mcp__foo_bar_lookup",
					label: "foo_bar/lookup manager",
					description: "Colliding manager tool with the losing stable origin.",
					parameters: type({}),
					mcpServerName: "foo_bar",
					mcpToolName: "lookup",
					async execute() {
						return { content: [{ type: "text", text: "manager" }] };
					},
				} satisfies CustomTool,
			]);
			expect(session.getToolByName("mcp__foo_bar_lookup")?.label).toBe("foo.bar/lookup");
			expect(session.getEnabledToolNames()).toContain("mcp__foo_bar_lookup");
			expect(warn).toHaveBeenCalledWith("MCP tool name collision; keeping stable winner", {
				name: "mcp__foo_bar_lookup",
				keptServer: "foo.bar",
				keptTool: "lookup",
				ignoredServer: "foo_bar",
				ignoredTool: "lookup",
			});
		} finally {
			await session.dispose();
		}
	});

	it("keeps an inactive extension MCP winner disabled when a manager collision loses", async () => {
		const tempDir = makeTempDir();
		const inactiveMcpExtension: ExtensionFactory = pi => {
			pi.registerTool({
				name: "mcp__foo_bar_inactive",
				label: "Inactive extension winner",
				description: "Stable extension winner that starts disabled.",
				parameters: type({}),
				mcpServerName: "foo.bar",
				mcpToolName: "inactive",
				defaultInactive: true,
				async execute() {
					return { content: [{ type: "text", text: "extension" }] };
				},
			});
		};
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [inactiveMcpExtension],
		});

		try {
			expect(session.getEnabledToolNames()).not.toContain("mcp__foo_bar_inactive");
			await session.refreshMCPTools([
				{
					name: "mcp__foo_bar_inactive",
					label: "Losing manager collision",
					description: "Manager origin loses stable deduplication.",
					parameters: type({}),
					mcpServerName: "foo_bar",
					mcpToolName: "inactive",
					async execute() {
						return { content: [{ type: "text", text: "manager" }] };
					},
				} satisfies CustomTool,
			]);
			expect(session.getToolByName("mcp__foo_bar_inactive")?.label).toBe("Inactive extension winner");
			expect(session.getEnabledToolNames()).not.toContain("mcp__foo_bar_inactive");
		} finally {
			await session.dispose();
		}
	});

	it("refreshes an earlier extension's stable MCP winner instead of the later colliding registrant", async () => {
		const tempDir = makeTempDir();
		const stableWinnerExtension: ExtensionFactory = pi => {
			pi.registerTool({
				name: "mcp__foo_bar_refresh",
				label: "foo.bar/refresh connected",
				description: "Initial stable MCP winner.",
				parameters: type({}),
				mcpServerName: "foo.bar",
				mcpToolName: "refresh",
				async execute() {
					return { content: [{ type: "text", text: "connected" }] };
				},
			});
			pi.on("session_start", async () => {
				await Promise.resolve();
				pi.registerTool({
					name: "mcp__foo_bar_refresh",
					label: "foo.bar/refresh reconnected",
					description: "Reconnected stable MCP winner.",
					parameters: type({}),
					mcpServerName: "foo.bar",
					mcpToolName: "refresh",
					async execute() {
						return { content: [{ type: "text", text: "reconnected" }] };
					},
				});
			});
		};
		const collidingLoserExtension: ExtensionFactory = pi => {
			pi.registerTool({
				name: "mcp__foo_bar_refresh",
				label: "foo_bar/refresh",
				description: "Later extension with the losing MCP origin.",
				parameters: type({}),
				mcpServerName: "foo_bar",
				mcpToolName: "refresh",
				async execute() {
					return { content: [{ type: "text", text: "loser" }] };
				},
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [stableWinnerExtension, collidingLoserExtension],
		});

		try {
			expect(session.getToolByName("mcp__foo_bar_refresh")?.label).toBe("foo.bar/refresh connected");
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			await runner.emit({ type: "session_start" });
			expect(session.getToolByName("mcp__foo_bar_refresh")?.label).toBe("foo.bar/refresh reconnected");
		} finally {
			await session.dispose();
		}
	});

	it("retains later-extension precedence when an earlier non-MCP registrant updates", async () => {
		const tempDir = makeTempDir();
		const earlierExtension: ExtensionFactory = pi => {
			pi.registerTool({
				name: "shared_lifecycle_tool",
				label: "Earlier Tool",
				description: "Earlier extension tool.",
				parameters: type({}),
				async execute() {
					return { content: [{ type: "text", text: "earlier" }] };
				},
			});
			pi.on("session_start", async () => {
				await Promise.resolve();
				pi.registerTool({
					name: "shared_lifecycle_tool",
					label: "Updated Earlier Tool",
					description: "Updated earlier extension tool.",
					parameters: type({}),
					async execute() {
						return { content: [{ type: "text", text: "updated earlier" }] };
					},
				});
			});
		};
		const laterExtension: ExtensionFactory = pi => {
			pi.registerTool({
				name: "shared_lifecycle_tool",
				label: "Later Tool",
				description: "Later extension winner.",
				parameters: type({}),
				async execute() {
					return { content: [{ type: "text", text: "later" }] };
				},
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [earlierExtension, laterExtension],
		});

		try {
			expect(session.getToolByName("shared_lifecycle_tool")?.label).toBe("Later Tool");
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			await runner.emit({ type: "session_start" });
			expect(session.getToolByName("shared_lifecycle_tool")?.label).toBe("Later Tool");
		} finally {
			await session.dispose();
		}
	});

	it("preserves SDK custom-tool precedence when an extension registers the same name later", async () => {
		const tempDir = makeTempDir();
		const lateCollisionExtension: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				await Promise.resolve();
				pi.registerTool({
					name: sdkCustomTool.name,
					label: "Late Extension Collision",
					description: "Extension tool that must not replace the SDK custom tool.",
					parameters: type({}),
					async execute() {
						return { content: [{ type: "text", text: "late extension" }] };
					},
				});
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [lateCollisionExtension],
			customTools: [sdkCustomTool],
		});

		try {
			expect(session.getToolByName(sdkCustomTool.name)?.label).toBe(sdkCustomTool.label);
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			await runner.emit({ type: "session_start" });
			expect(session.getToolByName(sdkCustomTool.name)?.label).toBe(sdkCustomTool.label);
		} finally {
			await session.dispose();
		}
	});

	it("preserves RPC host-tool precedence when an extension registers the same name later", async () => {
		const tempDir = makeTempDir();
		const rpcHostTool = {
			name: "rpc_host_collision",
			label: "RPC Host Tool",
			description: "Host-owned RPC tool.",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text", text: "rpc host" }] };
			},
		} satisfies AgentTool;
		const lateCollisionExtension: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				await Promise.resolve();
				pi.registerTool({
					name: rpcHostTool.name,
					label: "Late Extension Collision",
					description: "Extension tool that must not replace the RPC host tool.",
					parameters: type({}),
					async execute() {
						return { content: [{ type: "text", text: "late extension" }] };
					},
				});
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [lateCollisionExtension],
		});

		try {
			await session.refreshRpcHostTools([rpcHostTool]);
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			await runner.emit({ type: "session_start" });
			expect(session.getToolByName(rpcHostTool.name)?.label).toBe(rpcHostTool.label);
		} finally {
			await session.dispose();
		}
	});

	it("serializes late extension activation with MCP refreshes", async () => {
		const tempDir = makeTempDir();
		const activationEntered = Promise.withResolvers<void>();
		const releaseActivation = Promise.withResolvers<void>();
		const lateRegistrationExtension: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				await Promise.resolve();
				pi.registerTool({
					name: "serialized_lifecycle_tool",
					label: "Serialized Lifecycle Tool",
					description: "Lifecycle tool activated before an MCP refresh.",
					parameters: type({}),
					async execute() {
						return { content: [{ type: "text", text: "lifecycle" }] };
					},
				});
			});
		};
		const mcpTool = {
			name: "mcp__serialized_refresh_lookup",
			label: "serialized/refresh lookup",
			description: "MCP tool refreshed during lifecycle activation.",
			parameters: type({}),
			mcpServerName: "serialized",
			mcpToolName: "refresh_lookup",
			async execute() {
				return { content: [{ type: "text", text: "mcp" }] };
			},
		} satisfies CustomTool;

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [lateRegistrationExtension],
		});
		const originalSetActiveToolPresentation = session.setActiveToolPresentation.bind(session);
		vi.spyOn(session, "setActiveToolPresentation").mockImplementation(async (...args) => {
			activationEntered.resolve();
			await releaseActivation.promise;
			return originalSetActiveToolPresentation(...args);
		});

		try {
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			const emission = runner.emit({ type: "session_start" });
			await activationEntered.promise;
			const mcpRefresh = session.refreshMCPTools([mcpTool]);
			await Promise.resolve();
			expect(session.getToolByName(mcpTool.name)).toBeUndefined();

			releaseActivation.resolve();
			await Promise.all([emission, mcpRefresh]);
			expect(session.getEnabledToolNames()).toEqual(
				expect.arrayContaining(["serialized_lifecycle_tool", mcpTool.name]),
			);
		} finally {
			releaseActivation.resolve();
			await session.dispose();
		}
	});

	it("serializes complete memory-tool replacement with late extension activation", async () => {
		const tempDir = makeTempDir();
		const activationEntered = Promise.withResolvers<void>();
		const releaseActivation = Promise.withResolvers<void>();
		const lateRegistrationExtension: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				await Promise.resolve();
				pi.registerTool({
					name: "memory_race_lifecycle_tool",
					label: "Memory Race Lifecycle Tool",
					description: "Lifecycle tool activated before a memory-tool replacement.",
					parameters: type({}),
					async execute() {
						return { content: [{ type: "text", text: "lifecycle" }] };
					},
				});
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [lateRegistrationExtension],
		});
		const originalSetActiveToolPresentation = session.setActiveToolPresentation.bind(session);
		vi.spyOn(session, "setActiveToolPresentation").mockImplementation(async (...args) => {
			activationEntered.resolve();
			await releaseActivation.promise;
			return originalSetActiveToolPresentation(...args);
		});

		try {
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			const emission = runner.emit({ type: "session_start" });
			await activationEntered.promise;
			const memoryRefresh = session.applyMemoryBackend();

			releaseActivation.resolve();
			await Promise.all([emission, memoryRefresh]);
			expect(session.getEnabledToolNames()).toContain("memory_race_lifecycle_tool");
		} finally {
			releaseActivation.resolve();
			await session.dispose();
		}
	});

	it("keeps an explicitly disabled tool disabled when its extension re-registers it", async () => {
		const tempDir = makeTempDir();
		const disabledReplacementExtension: ExtensionFactory = pi => {
			pi.registerTool({
				name: "disabled_replacement_tool",
				label: "Initial Enabled Tool",
				description: "Initially enabled extension tool.",
				parameters: type({}),
				loadMode: "essential",
				async execute() {
					return { content: [{ type: "text", text: "initial" }] };
				},
			});
			pi.on("session_start", async () => {
				await pi.setActiveTools(["read"]);
				pi.registerTool({
					name: "disabled_replacement_tool",
					label: "Disabled Replacement Tool",
					description: "Replacement that must retain the disabled state.",
					parameters: type({}),
					loadMode: "essential",
					async execute() {
						return { content: [{ type: "text", text: "replacement" }] };
					},
				});
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [disabledReplacementExtension],
		});

		try {
			expect(session.getEnabledToolNames()).toContain("disabled_replacement_tool");
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			const errors: string[] = [];
			const unsubscribe = runner.onError(error => {
				errors.push(error.error);
			});
			await initializeExtensions(session, {
				reportSendError: vi.fn(),
				reportRuntimeError: vi.fn(),
			});
			unsubscribe();
			expect(errors).toEqual([]);

			expect(session.getToolByName("disabled_replacement_tool")?.label).toBe("Disabled Replacement Tool");
			expect(session.getEnabledToolNames()).not.toContain("disabled_replacement_tool");
		} finally {
			await session.dispose();
		}
	});

	it("reclassifies late replacements when their load modes change", async () => {
		const tempDir = makeTempDir();
		const loadModeReplacementExtension: ExtensionFactory = pi => {
			const registerTransitionTool = (name: string, label: string, loadMode: "essential" | "discoverable"): void => {
				pi.registerTool({
					name,
					label,
					description: `${label} extension tool.`,
					parameters: type({}),
					loadMode,
					async execute() {
						return { content: [{ type: "text", text: label }] };
					},
				});
			};
			registerTransitionTool("late_becomes_discoverable", "Initially Essential", "essential");
			registerTransitionTool("late_becomes_essential", "Initially Discoverable", "discoverable");
			pi.on("session_start", async () => {
				await Promise.resolve();
				registerTransitionTool("late_becomes_discoverable", "Now Discoverable", "discoverable");
				registerTransitionTool("late_becomes_essential", "Now Essential", "essential");
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [loadModeReplacementExtension],
		});

		try {
			expect(session.getActiveToolNames()).toContain("late_becomes_discoverable");
			expect(session.getMountedXdevToolNames()).toContain("late_becomes_essential");
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			await runner.emit({ type: "session_start" });

			expect(session.getActiveToolNames()).not.toContain("late_becomes_discoverable");
			expect(session.getMountedXdevToolNames()).toContain("late_becomes_discoverable");
			expect(session.getActiveToolNames()).toContain("late_becomes_essential");
			expect(session.getMountedXdevToolNames()).not.toContain("late_becomes_essential");
		} finally {
			await session.dispose();
		}
	});

	it("refreshes prompt-visible metadata when a lifecycle registration replaces an enabled tool", async () => {
		const tempDir = makeTempDir();
		const replacementExtension: ExtensionFactory = pi => {
			const register = (label: string, description: string): void => {
				pi.registerTool({
					name: "prompt_refresh_tool",
					label,
					description,
					parameters: type({}),
					async execute() {
						return { content: [{ type: "text", text: label }] };
					},
				});
			};
			register("Original Prompt Tool", "Original prompt-visible lifecycle description.");
			pi.on("session_start", async () => {
				await Promise.resolve();
				register("Replacement Prompt Tool", "Replacement prompt-visible lifecycle description.");
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [replacementExtension],
		});

		try {
			expect(session.systemPrompt.join("\n")).toContain("Original prompt-visible lifecycle description.");
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			await runner.emit({ type: "session_start" });

			const prompt = session.systemPrompt.join("\n");
			expect(session.getToolByName("prompt_refresh_tool")?.label).toBe("Replacement Prompt Tool");
			expect(prompt).toContain("Replacement prompt-visible lifecycle description.");
			expect(prompt).not.toContain("Original prompt-visible lifecycle description.");
		} finally {
			await session.dispose();
		}
	});

	it("restores a built-in tool and its provenance when a replacement prompt rebuild fails", async () => {
		let rejectReplacementPrompt = false;
		const releaseHandler = Promise.withResolvers<void>();
		const replacementRefreshAttempted = Promise.withResolvers<void>();
		const tempDir = makeTempDir();
		const replacementExtension: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				await Promise.resolve();
				pi.registerTool({
					name: "bash",
					label: "Rejected Rollback Bash",
					description: "Rejected rollback lifecycle description.",
					parameters: type({ changed: type.string }),
					async execute() {
						return { content: [{ type: "text", text: "rejected" }] };
					},
				});
				await releaseHandler.promise;
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [replacementExtension],
			systemPrompt: defaultPrompt => {
				if (rejectReplacementPrompt) {
					replacementRefreshAttempted.resolve();
					throw new Error("expected replacement prompt failure");
				}
				return defaultPrompt;
			},
		});
		let emission: Promise<unknown> | undefined;

		try {
			const enabledBefore = session.getEnabledToolNames();
			const mountedBefore = session.getMountedXdevToolNames();
			const promptBefore = session.systemPrompt;
			const originalTool = session.getToolByName("bash");
			expect(session.hasBuiltInTool("bash")).toBe(true);
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			const errors: string[] = [];
			const unsubscribe = runner.onError(error => {
				errors.push(error.error);
			});
			rejectReplacementPrompt = true;
			emission = runner.emit({ type: "session_start" });
			await replacementRefreshAttempted.promise;
			expect(errors).not.toContain("expected replacement prompt failure");
			releaseHandler.resolve();
			await emission;
			unsubscribe();

			expect(errors).toContain("expected replacement prompt failure");
			expect(session.getToolByName("bash")).toBe(originalTool);
			expect(session.hasBuiltInTool("bash")).toBe(true);
			expect(session.getEnabledToolNames()).toEqual(enabledBefore);
			expect(session.getMountedXdevToolNames()).toEqual(mountedBefore);
			expect(session.systemPrompt).toEqual(promptBefore);
		} finally {
			releaseHandler.resolve();
			await emission;
			await session.dispose();
		}
	});

	it("waits for later registrations after an earlier activation fails", async () => {
		const tempDir = makeTempDir();
		const releaseLaterActivation = Promise.withResolvers<void>();
		const laterActivationEntered = Promise.withResolvers<void>();
		const registrationExtension: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				await Promise.resolve();
				for (const name of ["failed_registration_tool", "drained_registration_tool"]) {
					pi.registerTool({
						name,
						label: name,
						description: `${name} lifecycle description.`,
						parameters: type({}),
						async execute() {
							return { content: [{ type: "text", text: name }] };
						},
					});
				}
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [registrationExtension],
		});
		const originalSetPresentation = session.setActiveToolPresentation.bind(session);
		vi.spyOn(session, "setActiveToolPresentation").mockImplementation(
			async (toolNames, mountedToolNames, forcePromptRefresh) => {
				if (toolNames.includes("failed_registration_tool")) throw new Error("expected activation failure");
				if (toolNames.includes("drained_registration_tool")) {
					laterActivationEntered.resolve();
					await releaseLaterActivation.promise;
				}
				await originalSetPresentation(toolNames, mountedToolNames, forcePromptRefresh);
			},
		);
		const runner = session.extensionRunner;
		if (!runner) throw new Error("expected extension runner");
		const errors: string[] = [];
		runner.onError(error => {
			errors.push(error.error);
		});
		let emissionCompleted = false;
		const emission = runner.emit({ type: "session_start" }).finally(() => {
			emissionCompleted = true;
		});

		try {
			await laterActivationEntered.promise;
			await Promise.resolve();
			await Promise.resolve();
			expect(emissionCompleted).toBe(false);
			expect(errors).toEqual([]);

			releaseLaterActivation.resolve();
			await emission;
			expect(errors).toContain("expected activation failure");
			expect(session.getToolByName("failed_registration_tool")).toBeUndefined();
			expect(session.getToolByName("drained_registration_tool")).toBeDefined();
			expect(session.systemPrompt.join("\n")).toContain("drained_registration_tool");
		} finally {
			releaseLaterActivation.resolve();
			await emission;
			await session.dispose();
		}
	});

	it("releases a timed-out activation so later lifecycle registrations can proceed", async () => {
		const tempDir = makeTempDir();
		const registrationExtension: ExtensionFactory = pi => {
			for (const name of ["stalled_registration_tool", "recovered_registration_tool"]) {
				pi.on("session_start", async () => {
					await Promise.resolve();
					pi.registerTool({
						name,
						label: name,
						description: `${name} lifecycle tool.`,
						parameters: type({}),
						loadMode: "essential",
						async execute() {
							return { content: [{ type: "text", text: name }] };
						},
					});
				});
			}
		};
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [registrationExtension],
		});

		try {
			const originalSetPresentation = session.setActiveToolPresentation.bind(session);
			vi.spyOn(session, "setActiveToolPresentation")
				.mockImplementationOnce((_toolNames, _mountedToolNames, _forcePromptRefresh, signal) =>
					untilAborted(signal, Promise.withResolvers<void>().promise),
				)
				.mockImplementation(originalSetPresentation);
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			const errors: string[] = [];
			const unsubscribe = runner.onError(error => {
				errors.push(error.error);
				// The 10ms budget exists only to reap the stalled first handler
				// quickly; handlers run sequentially and the budget is read per
				// handler, so restoring it here keeps machine load from timing out
				// the genuine recovery registration too (flaked in full-suite runs).
				testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
			});
			testSetExtensionHandlerTimeoutMs(10);

			await runner.emit({ type: "session_start" });
			unsubscribe();

			expect(errors).toContain("handler timed out after 10ms");
			expect(session.getToolByName("stalled_registration_tool")).toBeUndefined();
			expect(session.getToolByName("recovered_registration_tool")?.label).toBe("recovered_registration_tool");
			expect(session.getEnabledToolNames()).toContain("recovered_registration_tool");
		} finally {
			await session.dispose();
		}
	});

	it("applies explicit tool selection after preceding lifecycle registrations", async () => {
		const tempDir = makeTempDir();
		const registrationExtension: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				pi.registerTool({
					name: "register_then_select_tool",
					label: "Register Then Select Tool",
					description: "Must not overwrite the explicit selection that follows registration.",
					parameters: type({}),
					async execute() {
						return { content: [{ type: "text", text: "registered" }] };
					},
				});
				await pi.setActiveTools(["read"]);
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [registrationExtension],
		});

		try {
			await initializeExtensions(session, {
				reportSendError: vi.fn(),
				reportRuntimeError: vi.fn(),
			});

			expect(session.getAllToolNames()).toContain("register_then_select_tool");
			expect(session.getEnabledToolNames()).toContain("read");
			expect(session.getEnabledToolNames()).not.toContain("register_then_select_tool");
			expect(session.getMountedXdevToolNames()).not.toContain("register_then_select_tool");
		} finally {
			await session.dispose();
		}
	});

	it("attributes detached registration failures without waiting for another lifecycle handler", async () => {
		const tempDir = makeTempDir();
		const releaseDetachedRegistration = Promise.withResolvers<void>();
		const registrationFailure = Promise.withResolvers<{ event: string; error: string }>();
		let rejectDetachedPrompt = false;
		const detachedRegistrationExtension: ExtensionFactory = pi => {
			pi.on("session_start", () => {
				void releaseDetachedRegistration.promise.then(() => {
					pi.registerTool({
						name: "detached_registration_tool",
						label: "Detached Registration Tool",
						description: "Detached tool whose activation intentionally fails.",
						parameters: type({}),
						async execute() {
							return { content: [{ type: "text", text: "detached" }] };
						},
					});
				});
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({
				"bashInterceptor.enabled": true,
				"bashInterceptor.patterns": [
					{
						pattern: "^\\s*printf\\s+",
						tool: "detached_registration_tool",
						message: "Use the detached registration tool.",
					},
				],
			}),
			autoApprove: true,
			extensions: [detachedRegistrationExtension],
			systemPrompt: defaultPrompt => {
				if (rejectDetachedPrompt) throw new Error("expected detached registration failure");
				return defaultPrompt;
			},
		});

		try {
			await initializeExtensions(session, {
				reportSendError: vi.fn(),
				reportRuntimeError: error => {
					if (error.error === "expected detached registration failure") {
						registrationFailure.resolve({ event: error.event, error: error.error });
					}
				},
			});
			rejectDetachedPrompt = true;
			releaseDetachedRegistration.resolve();

			expect(await registrationFailure.promise).toEqual({
				event: "tool_registration",
				error: "expected detached registration failure",
			});
			expect(session.getToolByName("detached_registration_tool")).toBeUndefined();
			rejectDetachedPrompt = false;
			const toolCallId = "detached-rollback-bash";
			const mock = createMockModel({
				responses: [
					{
						content: [
							{
								type: "toolCall",
								id: toolCallId,
								name: "bash",
								arguments: { command: "printf rollback-ok" },
							},
						],
					},
					{ content: [{ type: "text", text: "done" }] },
				],
			});
			vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
			await withProviderAuth(["openai"], async () => {
				await session.prompt("verify rollback context");
				const bashResult = session.messages.find(
					(message): message is ToolResultMessage =>
						message.role === "toolResult" && message.toolCallId === toolCallId,
				);
				expect(bashResult?.isError).toBe(false);
				expect(JSON.stringify(bashResult?.content)).toContain("rollback-ok");
			});
		} finally {
			releaseDetachedRegistration.resolve();
			await session.dispose();
		}
	});

	it("times out detached activations without blocking later registrations", async () => {
		const tempDir = makeTempDir();
		const releaseStalledRegistration = Promise.withResolvers<void>();
		const releaseRecoveredRegistration = Promise.withResolvers<void>();
		const detachedRegistrationExtension: ExtensionFactory = pi => {
			pi.on("session_start", () => {
				void releaseStalledRegistration.promise.then(() => {
					pi.registerTool({
						name: "stalled_detached_tool",
						label: "Stalled Detached Tool",
						description: "Detached registration whose activation stalls.",
						parameters: type({}),
						loadMode: "essential",
						async execute() {
							return { content: [{ type: "text", text: "stalled" }] };
						},
					});
				});
				void releaseRecoveredRegistration.promise.then(() => {
					pi.registerTool({
						name: "recovered_detached_tool",
						label: "Recovered Detached Tool",
						description: "Detached registration that follows the timeout.",
						parameters: type({}),
						loadMode: "essential",
						async execute() {
							return { content: [{ type: "text", text: "recovered" }] };
						},
					});
				});
			});
		};
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [detachedRegistrationExtension],
		});

		try {
			await initializeExtensions(session, {
				reportSendError: vi.fn(),
				reportRuntimeError: vi.fn(),
			});
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			const detachedFailure = Promise.withResolvers<{ event: string; error: string }>();
			runner.onError(error => {
				if (error.event === "tool_registration") {
					detachedFailure.resolve({ event: error.event, error: error.error });
				}
			});
			const recoveredActivation = Promise.withResolvers<void>();
			const originalSetPresentation = session.setActiveToolPresentation.bind(session);
			vi.spyOn(session, "setActiveToolPresentation")
				.mockImplementationOnce((_toolNames, _mountedToolNames, _forcePromptRefresh, signal) =>
					untilAborted(signal, Promise.withResolvers<void>().promise),
				)
				.mockImplementation(async (toolNames, mountedToolNames, forcePromptRefresh, signal) => {
					await originalSetPresentation(toolNames, mountedToolNames, forcePromptRefresh, signal);
					if (toolNames.includes("recovered_detached_tool")) recoveredActivation.resolve();
				});
			testSetExtensionHandlerTimeoutMs(10);

			releaseStalledRegistration.resolve();
			const failure = await detachedFailure.promise;
			// Restore the default budget before the recovered registration flush:
			// the 10ms budget was only for reaping the stalled activation, and the
			// real presentation pass can exceed it under full-suite load.
			testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
			releaseRecoveredRegistration.resolve();
			await recoveredActivation.promise;

			expect(failure.event).toBe("tool_registration");
			expect(failure.error).toContain("timed out");
			expect(session.getToolByName("stalled_detached_tool")).toBeUndefined();
			expect(session.getToolByName("recovered_detached_tool")?.label).toBe("Recovered Detached Tool");
		} finally {
			releaseStalledRegistration.resolve();
			releaseRecoveredRegistration.resolve();
			await session.dispose();
		}
	});

	it("forwards built-in and external xd:// devices to Cursor provider contexts", async () => {
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			model: cursorModel,
		});
		const externalMcpTool: CustomTool = {
			name: "mcp__fixture_report",
			label: "fixture/report",
			description: "Report a fixture result.",
			parameters: type({}),
			strict: true,
			mcpServerName: "fixture",
			mcpToolName: "report",
			async execute() {
				return { content: [{ type: "text", text: "reported" }] };
			},
		};

		try {
			await session.refreshMCPTools([externalMcpTool]);
			const deviceNames = session.getXdevToolEntries().map(entry => entry.name);
			expect(deviceNames).toEqual(expect.arrayContaining(["ast_edit", "mcp__fixture_report"]));
			expect(session.getActiveToolNames()).not.toContain("mcp__fixture_report");

			const context = await session.agent.buildSideRequestContext([]);
			const providerToolNames = context.tools?.map(tool => tool.name);
			expect(providerToolNames).toEqual(expect.arrayContaining(["ast_edit", "mcp__fixture_report"]));
		} finally {
			await session.dispose();
		}
	});

	it("excludes hidden custom tools from the parent active set unless listed", async () => {
		const tempDir = makeTempDir();
		const hiddenTool = {
			...sdkCustomTool,
			name: "hidden_custom_tool",
			hidden: true,
		} satisfies CustomTool;

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			customTools: [hiddenTool],
		});

		try {
			expect(session.getAllToolNames()).toContain("hidden_custom_tool");
			expect(session.getActiveToolNames()).not.toContain("hidden_custom_tool");
			expect(session.getXdevToolEntries().map(e => e.name)).not.toContain("hidden_custom_tool");
			expect(session.systemPrompt.join("\n")).not.toContain("hidden_custom_tool");
		} finally {
			await session.dispose();
		}
	});

	it("keeps a hidden custom-tool winner inactive after a visible extension name collision", async () => {
		const tempDir = makeTempDir();
		const hiddenTool = {
			...sdkCustomTool,
			name: "colliding_hidden_tool",
			label: "Hidden SDK Winner",
			hidden: true,
		} satisfies CustomTool;

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [
				pi => {
					pi.registerTool({
						name: hiddenTool.name,
						label: "Visible Extension Loser",
						description: "Visible definition that loses registry precedence.",
						parameters: type({}),
						async execute() {
							return { content: [{ type: "text", text: "visible" }] };
						},
					});
				},
			],
			customTools: [hiddenTool],
		});

		try {
			expect(session.getToolByName(hiddenTool.name)?.label).toBe(hiddenTool.label);
			expect(session.getActiveToolNames()).not.toContain(hiddenTool.name);
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(hiddenTool.name);
			expect(session.systemPrompt.join("\n")).not.toContain(hiddenTool.name);
		} finally {
			await session.dispose();
		}
	});

	it("activates a hidden custom tool when an agent lists it", async () => {
		const tempDir = makeTempDir();
		const hiddenTool = {
			...sdkCustomTool,
			name: "hidden_custom_tool",
			hidden: true,
		} satisfies CustomTool;

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			customTools: [hiddenTool],
			toolNames: ["read", "hidden_custom_tool"],
		});

		try {
			expect(session.getActiveToolNames()).toContain("hidden_custom_tool");
		} finally {
			await session.dispose();
		}
	});

	it("allows explicitly requested defaultInactive extension tools into the initial active set", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [toolActivationExtension],
			toolNames: ["read", "default_inactive_tool"],
		});

		try {
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "default_inactive_tool", "write"]),
			);
			// The explicitly requested inactive tool stays top-level. The ambient
			// default-active tool mounts through the device-only xd:// transport.
			expect(session.getActiveToolNames()).not.toContain("default_active_tool");
			expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("default_active_tool");
			expect(session.systemPrompt.join("\n")).toContain("default_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("activates the yield tool when requireYieldTool is set and toolNames is explicit", async () => {
		// Regression for #1408: plan-mode subagents pass an explicit `toolNames` list
		// (e.g. `["read", "grep", "glob", "lsp", "web_search"]`). Without this
		// invariant, `yield` ended up registered but not active, and the model
		// could not satisfy the idle-reminder contract that demands a `yield` call.
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			requireYieldTool: true,
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getActiveToolNames()).toContain("yield");
		} finally {
			await session.dispose();
		}
	});

	it("normalizes legacy builtin toolNames before selecting the active SDK tools", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "search", "find"],
		});

		try {
			const activeToolNames = session.getActiveToolNames();

			expect(activeToolNames).toContain("read");
			expect(activeToolNames).toContain("grep");
			expect(activeToolNames).toContain("glob");
			expect(activeToolNames).not.toContain("search");
			expect(activeToolNames).not.toContain("find");
		} finally {
			await session.dispose();
		}
	});

	it("keeps the write tool registered for plan mode even when no deferrable tool is requested", async () => {
		// Regression for #1428 (adapted to the xd://propose device): plan mode
		// submits its finalized plan by writing the chosen slug/title to
		// xd://propose, dispatched through the plan-proposal handler
		// (interactive-mode.ts: `setPlanProposalHandler`). With an explicit
		// read-only `toolNames` (e.g. `read`, `search`, `find`, `web_search`)
		// the registry has no `write` and no `deferrable` tool; dropping it would
		// silently activate plan mode with no way to submit the plan.
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getToolByName("write")).toBeDefined();
		} finally {
			await session.dispose();
		}
	});

	it("keeps an idle device-only write out of the active tool set", async () => {
		const tempDir = makeTempDir();

		const settings = Settings.isolated();
		settings.set("plan.enabled", false);

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings,
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			// The dormant transport remains registered for later xd:// discovery,
			// but does not add an inert schema to a pure read-only surface.
			expect(session.getActiveToolNames()).not.toContain("write");
			const write = session.getToolByName("write");
			expect(write).toBeDefined();
			await expect(
				write!.execute("device-only-fs", { path: path.join(tempDir, "nope.txt"), content: "x" }),
			).rejects.toThrow("Filesystem writes are not available");
		} finally {
			await session.dispose();
		}
	});

	it("does not activate write merely because plan mode is available", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read"],
		});

		try {
			await session.setActiveToolsByName(["read"]);
			expect(session.getActiveToolNames()).not.toContain("write");
		} finally {
			await session.dispose();
		}
	});

	it("upgrades write explicitly selected by a runtime caller to filesystem access", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read"],
		});

		try {
			await session.setActiveToolsByName(["read", "write"]);
			await session.refreshMCPTools([]);
			expect(session.getActiveToolNames()).toContain("write");
			const write = session.getToolByName("write");
			expect(write).toBeDefined();
			const filePath = path.join(tempDir, "runtime-write.txt");
			await write!.execute("runtime-full-write", { path: filePath, content: "runtime\n" });
			expect(await Bun.file(filePath).text()).toBe("runtime\n");
		} finally {
			await session.dispose();
		}
	});
	it("registers vibe tools only during explicit vibe activation and exposes parent Todo bookkeeping", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession(baseOptions(tempDir));
		const previousActiveToolNames = session.getActiveToolNames();

		try {
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeUndefined();
			}

			await session.activateVibeTools(["read", "todo"]);
			const todo = session.getToolByName("todo");
			if (!todo) throw new Error("Expected real Todo tool");
			expect(session.getActiveToolNames()).toContain("todo");
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeDefined();
				expect(session.getActiveToolNames()).toContain(name);
			}

			await todo.execute("vibe-todo-init", {
				op: "init",
				list: [{ phase: "Work", items: ["Worker change"] }],
			});
			await todo.execute("vibe-todo-done", { op: "done", task: "Worker change" });
			expect(session.getTodoPhases()).toMatchObject([
				{
					name: "Work",
					tasks: [{ content: "Worker change", status: "completed" }],
				},
			]);

			await session.deactivateVibeTools(previousActiveToolNames);
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeUndefined();
			}
			expect(session.getActiveToolNames()).toEqual(previousActiveToolNames);
		} finally {
			await session.dispose();
		}
	});

	it("rehydrates completed parent Todo work from persisted session history", async () => {
		const tempDir = makeTempDir();
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager,
		});

		try {
			await session.activateVibeTools(["read", "todo"]);
			const todo = session.getToolByName("todo");
			if (!todo) throw new Error("Expected real Todo tool");
			const init = await todo.execute("vibe-todo-init", {
				op: "init",
				list: [{ phase: "Worker flow", items: ["Reconcile worker result"] }],
			});
			const done = await todo.execute("vibe-todo-done", { op: "done", task: "Reconcile worker result" });
			for (const [toolCallId, result] of [
				["vibe-todo-init", init],
				["vibe-todo-done", done],
			] as const) {
				sessionManager.appendMessage({
					role: "toolResult",
					toolCallId,
					toolName: "todo",
					content: result.content,
					details: result.details,
					isError: result.isError === true,
					timestamp: Date.now(),
				});
			}
			await sessionManager.ensureOnDisk();
			const sessionFile = session.sessionFile;
			if (!sessionFile) throw new Error("Expected persisted session file");

			session.setTodoPhases([]);
			expect(session.getTodoPhases()).toEqual([]);
			expect(await session.switchSession(sessionFile)).toBe(true);
			expect(session.getTodoPhases()).toMatchObject([
				{
					name: "Worker flow",
					tasks: [{ content: "Reconcile worker result", status: "completed" }],
				},
			]);
		} finally {
			await session.dispose();
		}
	});

	it("does not register the xAI TTS tool unless enabled", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
		});

		try {
			expect(session.getToolByName("tts")).toBeUndefined();
			expect(session.getAllToolNames()).not.toContain("tts");
			expect(session.getActiveToolNames()).not.toContain("tts");
		} finally {
			await session.dispose();
		}
	});

	it("registers the xAI TTS tool when enabled", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({ "speechgen.enabled": true }),
		});

		try {
			expect(session.getToolByName("tts")).toBeDefined();
			// tts is a discoverable custom tool → mounted as an xd:// device, not top-level.
			expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("tts");
			expect(session.getActiveToolNames()).not.toContain("tts");
		} finally {
			await session.dispose();
		}
	});

	it("keeps the stable MCP tool-name collision winner during SDK startup and warns", async () => {
		const tempDir = makeTempDir();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const createMcpTool = (serverName: string, label: string): CustomTool => ({
			name: "mcp__foo_bar_lookup",
			label,
			description: `Lookup from ${serverName}`,
			parameters: type({}),
			mcpServerName: serverName,
			mcpToolName: "lookup",
			async execute() {
				return { content: [{ type: "text", text: serverName }] };
			},
		});

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			customTools: [createMcpTool("foo.bar", "foo.bar/lookup"), createMcpTool("foo_bar", "foo_bar/lookup")],
		});

		try {
			expect(session.getToolByName("mcp__foo_bar_lookup")?.label).toBe("foo.bar/lookup");
			expect(warn).toHaveBeenCalledWith("MCP tool name collision; keeping stable winner", {
				name: "mcp__foo_bar_lookup",
				keptServer: "foo.bar",
				keptTool: "lookup",
				ignoredServer: "foo_bar",
				ignoredTool: "lookup",
			});
		} finally {
			await session.dispose();
		}
	});

	it("keeps restricted host tool lists isolated from configured custom capabilities", async () => {
		const restrictedDir = makeTempDir();
		const normalDir = makeTempDir();
		const configuredSettings = () =>
			Settings.isolated({
				"providers.imageOrder": ["openai"],
				"generate_image.enabled": true,
				"speechgen.enabled": true,
				"memory.backend": "hindsight",
				"autolearn.enabled": true,
			});

		const inheritedManager = {
			getServerInstructions: () => new Map([["private-server", "must not reach restricted child"]]),
		} as unknown as MCPManager;

		const restrictedLateExtension: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				await Promise.resolve();
				pi.registerTool({
					name: "restricted_late_extension_tool",
					label: "Restricted Late Extension Tool",
					description: "Must not enter a caller-restricted session.",
					parameters: type({}),
					async execute() {
						return { content: [{ type: "text", text: "restricted late" }] };
					},
				});
			});
		};

		const { session: restricted } = await createAgentSession({
			...baseOptions(restrictedDir),
			settings: configuredSettings(),
			extensions: [toolActivationExtension, restrictedLateExtension],
			customTools: [sdkCustomTool],
			toolNames: ["read", "lsp", "hub"],
			requireYieldTool: true,
			restrictToolNames: true,
			enableMCP: true,
			mcpManager: inheritedManager,
			enableLsp: true,
			enableIrc: true,
		});

		try {
			await initializeExtensions(restricted, {
				reportSendError: vi.fn(),
				reportRuntimeError: vi.fn(),
			});
			expect(restricted.getAllToolNames()).toEqual(["read", "lsp", "yield"]);
			expect(restricted.getActiveToolNames()).toEqual(["read", "lsp", "yield"]);
			for (const name of [
				"generate_image",
				"tts",
				"recall",
				"retain",
				"reflect",
				"learn",
				"manage_skill",
				"default_active_tool",
				"default_inactive_tool",
				"sdk_custom_tool",
				"restricted_late_extension_tool",
				"hub",
			]) {
				expect(restricted.getToolByName(name)).toBeUndefined();
			}
			expect(restricted.getXdevToolEntries()).toEqual([]);
			expect(restricted.systemPrompt.join("\n")).not.toContain("private-server");
			expect(restricted.systemPrompt.join("\n")).not.toContain("MCP Server Instructions");
		} finally {
			await restricted.dispose();
		}

		const { session: normal } = await createAgentSession({
			...baseOptions(normalDir),
			settings: configuredSettings(),
			extensions: [toolActivationExtension],
			customTools: [sdkCustomTool],
			toolNames: ["read", "generate_image"],
			requireYieldTool: true,
			restrictToolNames: false,
		});

		try {
			const activeToolNames = normal.getActiveToolNames();
			expect(activeToolNames).toEqual(
				expect.arrayContaining(["read", "yield", "generate_image", "learn", "manage_skill", "write"]),
			);
			// Explicit and force-included tools stay top-level. Ambient custom and
			// extension capabilities mount through the device-only write transport.
			const mountedNames = normal.getXdevToolEntries().map(entry => entry.name);
			expect(mountedNames).toEqual(expect.arrayContaining(["tts", "default_active_tool", "sdk_custom_tool"]));
			expect(activeToolNames).not.toContain("tts");
			expect(activeToolNames).not.toContain("default_active_tool");
			expect(activeToolNames).not.toContain("sdk_custom_tool");
			expect(normal.getAllToolNames()).toEqual(
				expect.arrayContaining([
					"generate_image",
					"read",
					"yield",
					"tts",
					"default_active_tool",
					"sdk_custom_tool",
					"recall",
					"retain",
					"reflect",
				]),
			);
		} finally {
			await normal.dispose();
		}
	});

	it("permits only explicitly named SDK custom tools when a restricted caller opts in", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			customTools: [sdkCustomTool],
			toolNames: ["read", "sdk_custom_tool"],
			restrictToolNames: true,
			allowRestrictedCustomTools: true,
		});

		try {
			expect(session.getAllToolNames()).toEqual(["read", "sdk_custom_tool"]);
			expect(session.getActiveToolNames()).toEqual(["read", "sdk_custom_tool"]);
		} finally {
			await session.dispose();
		}
	});

	it("renders report-issue guidance only for unrestricted sessions", async () => {
		const normalDir = makeTempDir();
		const restrictedDir = makeTempDir();
		const { session: normal } = await createAgentSession({
			...baseOptions(normalDir),
			settings: Settings.isolated({ "dev.autoqa": true }),
		});
		const { session: restricted } = await createAgentSession({
			...baseOptions(restrictedDir),
			settings: Settings.isolated({ "dev.autoqa": true }),
			toolNames: ["read"],
			restrictToolNames: true,
		});

		try {
			expect(normal.systemPrompt.join("\n")).toContain("xd://report_issue");
			expect(restricted.systemPrompt.join("\n")).not.toContain("xd://report_issue");
		} finally {
			await Promise.all([normal.dispose(), restricted.dispose()]);
		}
	});

	it("ignores an inherited MCP manager when MCP is disabled", async () => {
		const tempDir = makeTempDir();
		const inheritedManager = {
			getServerInstructions: () => new Map([["private-server", "must not reach restricted child"]]),
		} as unknown as MCPManager;

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			enableMCP: false,
			mcpManager: inheritedManager,
		});

		try {
			expect(session.systemPrompt.join("\n")).not.toContain("private-server");
			expect(session.systemPrompt.join("\n")).not.toContain("MCP Server Instructions");
		} finally {
			await session.dispose();
		}
	});

	// Hashline `edit` stays in the registry on Cursor so the model can still
	// call it as MCP. Native StrReplace arrives as `editToolCall` and is
	// materialized via exec read/write; `pi_edit` still uses the replace-mode
	// instance from `getEditReplaceTool`. The roster is built once at creation.
	// These two cover both directions of that wiring: the granted session must
	// still reach a replace-mode instance for `pi_edit` (whose `old_string` /
	// `new_string` args do not validate against the default `hashline` schema),
	// and the restricted one must still be refused.
	//
	// The handlers are internal to the session; `streamFn` is where they are
	// handed to the provider, which is the externally observable seam.
	const captureCursorExecHandlers = async (session: AgentSession, cursorModel: Model): Promise<CursorExecHandlers> => {
		let handlers: CursorExecHandlers | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			// The session installs the concrete class; the provider option is
			// typed as the wire-level interface, whose `piEdit` answers a proto
			// result rather than the tool result the class returns.
			handlers = options?.cursorExecHandlers as CursorExecHandlers | undefined;
			throw new Error("captured");
		};
		vi.spyOn(session.agent, "streamFn").mockImplementation(streamFn);

		await session.setModel(cursorModel);
		// Not wrapped in a catch: `prompt` resolves even when the turn fails (the
		// loop records the stream error), so a rejection here is a genuine setup
		// failure and must surface rather than be mistaken for the capture.
		await session.prompt("hi");
		if (!handlers) throw new Error("no exec handlers reached the provider");
		return handlers;
	};

	// `setModel` and `prompt` both refuse a provider with no configured auth.
	// Granted on the suite's isolated storage rather than through the provider's
	// env var — an env mutation would outlive this file — and removed after,
	// since the storage is shared by every test here.
	const withProviderAuth = async (providers: string[], run: () => Promise<void>): Promise<void> => {
		for (const provider of providers) modelRegistry.authStorage.setRuntimeApiKey(provider, "test-key");
		try {
			await run();
		} finally {
			for (const provider of providers) modelRegistry.authStorage.removeRuntimeApiKey(provider);
		}
	};

	it("answers a native pi_edit after a session switches onto Cursor", async () => {
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const target = path.join(tempDir, "sample.txt");
		fs.writeFileSync(target, "alpha\nbeta\n");

		await withProviderAuth(["cursor"], async () => {
			const { session } = await createAgentSession(baseOptions(tempDir));
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);
				const result = await handlers.piEdit({
					toolCallId: "sdk-switch-1",
					args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
				} as never);

				expect(result.isError).toBeFalsy();
				expect(fs.readFileSync(target, "utf8")).toBe("alpha\ngamma\n");
			} finally {
				await session.dispose();
			}
		});
	});

	it("keeps hashline edit advertised when the session starts on Cursor", async () => {
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");

		await withProviderAuth(["cursor"], async () => {
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				model: cursorModel,
			});
			try {
				expect(session.getActiveToolNames()).toContain("edit");
			} finally {
				await session.dispose();
			}
		});
	});

	it("refuses a native pi_edit after a read-only session switches onto Cursor", async () => {
		// The bridge instance is constructed, not looked up, so building it for
		// a roster that was never granted `edit` would hand a read-only session
		// a mutating tool the native frames reach regardless of the advertised
		// catalog (issue #5680). Making the construction provider-independent
		// must not widen it.
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const target = path.join(tempDir, "sample.txt");
		fs.writeFileSync(target, "alpha\nbeta\n");

		await withProviderAuth(["cursor"], async () => {
			const { session } = await createAgentSession({ ...baseOptions(tempDir), toolNames: ["read"] });
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);
				const result = await handlers.piEdit({
					toolCallId: "sdk-switch-2",
					args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
				} as never);

				expect(result.isError).toBe(true);
				expect(fs.readFileSync(target, "utf8")).toBe("alpha\nbeta\n");
			} finally {
				await session.dispose();
			}
		});
	});

	it("revokes native Cursor mutations when runtime write is deactivated", async () => {
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const allowedTarget = path.join(tempDir, "allowed.txt");
		const revokedTarget = path.join(tempDir, "revoked.txt");
		const transportTarget = path.join(tempDir, "transport-only.txt");
		fs.writeFileSync(allowedTarget, "remove me");
		fs.writeFileSync(revokedTarget, "keep me");
		fs.writeFileSync(transportTarget, "keep me too");

		await withProviderAuth(["cursor"], async () => {
			const { session } = await createAgentSession({ ...baseOptions(tempDir), toolNames: ["read"] });
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);
				await session.setActiveToolsByName(["read", "write"]);
				const fullWriteDescription = session.getToolByName("write")?.description;
				expect(fullWriteDescription).toBeDefined();

				const allowed = await handlers.delete({
					toolCallId: "sdk-write-active",
					path: allowedTarget,
				} as never);
				expect(allowed.isError).toBe(false);
				expect(fs.existsSync(allowedTarget)).toBe(false);

				await session.setActiveToolsByName(["read"]);
				expect(session.getActiveToolNames()).not.toContain("write");
				const revoked = await handlers.delete({
					toolCallId: "sdk-write-revoked",
					path: revokedTarget,
				} as never);
				expect(revoked.isError).toBe(true);
				expect(fs.existsSync(revokedTarget)).toBe(true);

				session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
				await session.setActiveToolsByName(["read", "write"]);
				expect(session.getActiveToolNames()).toContain("write");
				expect(session.getToolByName("write")?.description).not.toBe(fullWriteDescription);
				const transportOnly = await handlers.delete({
					toolCallId: "sdk-write-transport-only",
					path: transportTarget,
				} as never);
				expect(transportOnly.isError).toBe(true);
				expect(fs.existsSync(transportTarget)).toBe(true);
			} finally {
				await session.dispose();
			}
		});
	});

	it("revokes native Cursor mutations before a removal rebuild commits", async () => {
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const target = path.join(tempDir, "revoked-during-rebuild.txt");
		fs.writeFileSync(target, "keep me");
		const rebuildStarted = Promise.withResolvers<void>();
		const releaseRebuild = Promise.withResolvers<void>();

		await withProviderAuth(["cursor"], async () => {
			const { session } = await createAgentSession(baseOptions(tempDir));
			let deactivation: Promise<void> | undefined;
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);
				vi.spyOn(memoryBackendModule, "resolveMemoryBackend").mockResolvedValue({
					buildDeveloperInstructions: async () => {
						rebuildStarted.resolve();
						await releaseRebuild.promise;
						return undefined;
					},
				} as never);

				deactivation = session.setActiveToolsByName(["read"]);
				try {
					await rebuildStarted.promise;
					expect(session.getActiveToolNames()).toContain("write");
					const revoked = await handlers.delete({
						toolCallId: "sdk-write-revoked-during-rebuild",
						path: target,
					} as never);
					expect(revoked.isError).toBe(true);
					expect(fs.existsSync(target)).toBe(true);
				} finally {
					releaseRebuild.resolve();
				}
				await deactivation;
				expect(session.getActiveToolNames()).not.toContain("write");
			} finally {
				releaseRebuild.resolve();
				await deactivation?.catch(() => undefined);
				await session.dispose();
			}
		});
	});

	it("resolves bridge frame paths through the session's live cwd", async () => {
		// The bridge is built once, at session creation, while the session's cwd
		// moves under it (`/cd`, resume, branch restore). The path-confining
		// frames — the native `delete`, and a `download_path` resource read —
		// resolve a relative path against whichever cwd the bridge was handed, so
		// a startup snapshot means acting on the workspace the session has left
		// while reporting success for the path the server named.
		const tempDir = makeTempDir();
		const movedDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const staleTarget = path.join(tempDir, "obsolete.txt");
		const liveTarget = path.join(movedDir, "obsolete.txt");
		fs.writeFileSync(staleTarget, "preserve me");
		fs.writeFileSync(liveTarget, "remove me");

		await withProviderAuth(["cursor"], async () => {
			const sessionManager = SessionManager.inMemory();
			const { session } = await createAgentSession({ ...baseOptions(tempDir), sessionManager });
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);
				await sessionManager.moveTo(movedDir);

				const result = await handlers.delete({ toolCallId: "sdk-cwd-1", path: "obsolete.txt" } as never);

				expect(result.isError).toBe(false);
				expect(fs.existsSync(liveTarget)).toBe(false);
				expect(fs.existsSync(staleTarget)).toBe(true);
			} finally {
				await session.dispose();
			}
		});
	});

	it("does not execute an unadvertised edit call through the fallback resolver", async () => {
		// One resolver serves two roles: the session's device resolver is passed
		// to the bridge as `getTool` AND installed as the agent loop's
		// `resolveFallbackTool`, which runs for ANY call the advertised set does
		// not contain. It must stay device-only: routing `edit` through it would
		// execute a replace-mode edit for a call the model was never offered —
		// a hallucinated one, or a tool the session deselected after startup.
		// `pi_edit` gets its instance from `getEditReplaceTool` instead.
		const tempDir = makeTempDir();
		const target = path.join(tempDir, "sample.txt");
		fs.writeFileSync(target, "alpha\nbeta\n");

		await withProviderAuth(["openai"], async () => {
			// Granted at startup, so an `edit` instance exists to leak, then
			// deselected — the exact state that makes the fallback dangerous.
			const { session } = await createAgentSession(baseOptions(tempDir));
			try {
				await session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== "edit"));
				expect(session.getActiveToolNames()).not.toContain("edit");

				// A real mock provider, not a hand-rolled stream: the loop builds
				// the assistant message from the full event sequence, and an
				// incomplete one is dropped before tool dispatch ever runs.
				const toolCallId = "unadvertised-edit-1";
				const mock = createMockModel({
					responses: [
						{
							content: [
								{
									type: "toolCall",
									id: toolCallId,
									name: "edit",
									arguments: { path: target, old_string: "beta", new_string: "gamma" },
								},
							],
						},
						{ content: [{ type: "text", text: "done" }] },
					],
				});
				vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);

				await session.prompt("hi");

				// The surfaced result, not just the file: an unchanged file alone
				// would also pass if the fallback HAD resolved the tool and the
				// edit then failed validation or approval. Only "not found"
				// proves the resolver refused to hand one over.
				const result = session.messages.find(
					(message): message is ToolResultMessage =>
						message.role === "toolResult" && message.toolCallId === toolCallId,
				);
				expect(result?.isError).toBe(true);
				expect(JSON.stringify(result?.content)).toContain("Tool edit not found");
				expect(fs.readFileSync(target, "utf8")).toBe("alpha\nbeta\n");
			} finally {
				await session.dispose();
			}
		});
	});

	it("runs advisor tools through the approval gate", async () => {
		// The advisor's tools are built straight from `BUILTIN_TOOLS`, outside
		// the registry loop that wraps everything else. Its own loop and its
		// Cursor exec bridge (`piWrite`/`piBash`) run those instances directly,
		// so an unwrapped one executes whatever it is handed regardless of the
		// user's `tools.approval.<tool>` policy — the gate lives in
		// `ExtensionToolWrapper`, not in either caller.
		const tempDir = makeTempDir();
		const target = path.join(tempDir, "advisor-write.txt");

		// An advisor only builds once a model resolves for it, and both the
		// explicit override and the `advisor` role chain resolve against
		// `modelRegistry.getAvailable()` — the models this machine holds auth
		// for. Grant the suite's isolated storage a key and name the model
		// outright, or the roster silently resolves to `no_model` wherever no
		// provider is configured (CI) while passing on a developer box whose
		// environment happens to carry provider keys.
		await withProviderAuth(["openai"], async () => {
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				settings: Settings.isolated({ "advisor.enabled": true, "tools.approval": { write: "deny" } }),
			});
			try {
				// The default advisor roster is read-only (read/grep/glob); the
				// reviewed hole needs one actually granted a mutating tool.
				session.applyAdvisorConfigs([{ name: "writer", tools: ["write"], model: "gpt-4o-mini" }], undefined);
				const advisor = session.getAdvisorAgent();
				if (!advisor) throw new Error("expected an advisor agent");
				const writeTool = advisor.state.tools?.find(tool => tool.name === "write");
				if (!writeTool) throw new Error("expected the advisor to hold a write tool");

				// The gate rejects rather than returning an error result — that throw
				// IS the refusal, and it only happens when the instance is wrapped.
				await expect(
					writeTool.execute("advisor-w1", { path: target, content: "written" }, undefined, undefined, {
						settings: session.settings,
					} as never),
				).rejects.toThrow(/blocked by user policy/);
				expect(fs.existsSync(target)).toBe(false);
			} finally {
				await session.dispose();
			}
		});
	});

	it("keeps advisor write full-access when the primary has a device-only transport", async () => {
		const tempDir = makeTempDir();
		const target = path.join(tempDir, "advisor-full-write.txt");

		await withProviderAuth(["openai"], async () => {
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				settings: Settings.isolated({ "advisor.enabled": true, "tools.approval": { write: "allow" } }),
				toolNames: ["read"],
			});
			try {
				session.applyAdvisorConfigs([{ name: "writer", tools: ["write"], model: "gpt-4o-mini" }], undefined);
				const advisor = session.getAdvisorAgent();
				if (!advisor) throw new Error("expected an advisor agent");
				const writeTool = advisor.state.tools?.find(tool => tool.name === "write");
				if (!writeTool) throw new Error("expected the advisor to hold a write tool");

				const result = await writeTool.execute(
					"advisor-full-write",
					{ path: target, content: "written\n" },
					undefined,
					undefined,
					{ settings: session.settings } as never,
				);
				expect(result.isError).toBeUndefined();
				expect(fs.readFileSync(target, "utf8")).toBe("written\n");
			} finally {
				await session.dispose();
			}
		});
	});
});
