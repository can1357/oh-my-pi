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
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
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

	it("keeps a persona session's explicit CLI tool grant authoritative for the active set", async () => {
		// `--agent ... --tools read` (personaCliToolOverride): the persona path
		// leaves `restrictToolNames` unset so extension tools REGISTER (a
		// persona can grant one by naming it) and extension models resolve,
		// but the CLI grant must stay authoritative for the ACTIVE set:
		// `alwaysInclude` widening and MCP activation are suppressed, so a
		// mutating extension tool cannot ship top-level past the grant
		// (regression: it was force-activated like an unrestricted session).
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [toolActivationExtension],
			toolNames: ["read"],
			personaName: "launch-persona",
			personaCliToolOverride: true,
		});
		try {
			// The extension tool registers (persona path keeps discovery)…
			expect(session.getToolByName("default_active_tool")).toBeDefined();
			// …but stays OUT of the active set: the CLI grant named only `read`.
			expect(session.getActiveToolNames()).toEqual(["read"]);
			expect(session.systemPrompt.join("\n")).not.toContain("default_active_tool");
			// The persona baseline equals the CLI grant, and the residual
			// restriction is the same set — leaving the persona re-enables at
			// most the CLI list.
			expect(session.getBaselineToolNames()).toEqual(["read"]);
			await session.restoreBaselineTools();
			expect(session.getActiveToolNames()).toEqual(["read"]);
		} finally {
			await session.dispose();
		}
	});

	it("drops task for a spawns-disabled launch persona and restores it when the persona is left", async () => {
		// PRRT_kwDOQxs0bc6fkJJu: a `--agent` persona with `spawns: []` and NO
		// `tools:` frontmatter leaves the normal top-level baseline active —
		// which includes `task` — while `spawnsToString([])` installs the
		// disabled policy (`""`), so `task` was advertised while every
		// invocation failed spawn preflight. The registry-derived launch set
		// must drop `task` for the persona's lifetime (mirroring the
		// subagent executor's at-max-depth strip), and leaving the persona
		// restores the unrestricted baseline, which re-includes it.
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			personaName: "nospawn-persona",
			spawns: "",
		});
		try {
			expect(session.getSessionSpawns()).toBe("");
			expect(session.getActiveToolNames()).not.toContain("task");
			// Leaving the persona restores the full-registry baseline — `task`
			// returns (the caller clears the spawn policy separately).
			await session.restoreBaselineTools();
			expect(session.getActiveToolNames()).toContain("task");
		} finally {
			await session.dispose();
		}
	});

	it("retains an empty residual restriction after leaving a --no-tools persona", async () => {
		// `--agent ... --no-tools` grants nothing: the residual CLI restriction
		// must be an EMPTY set, not `undefined` — undefined would lift the gate
		// and let the next MCP/RPC/memory refresh auto-activate tools past the
		// explicit no-tools grant. The empty set rejects every late
		// registration, which is precisely the grant's meaning.
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: [],
			personaName: "launch-persona",
			personaCliToolOverride: true,
		});
		try {
			expect(session.getBaselineToolNames()).toEqual([]);
			// Leaving the persona keeps a defined (empty) restriction.
			await session.restoreBaselineTools();
			const restriction = session.getPersonaToolRestriction();
			expect(restriction).toBeDefined();
			expect(restriction!.size).toBe(0);
		} finally {
			await session.dispose();
		}
	});

	it("keeps a personaSwitchable CLI grant durable across deferred MCP refresh and late extensions", async () => {
		// PRRT_kwDOQxs0bc6fmuwt: interactive/rpc-ui/ACP sessions launched with
		// plain `--tools`/`--no-tools` (personaSwitchable, NO `--agent`) load
		// extensions and MCP for a later `/agent` switch, but nothing seeded the
		// CLI grant as a restriction — a deferred MCP refresh auto-activated
		// every connected tool and a late extension registration passed the
		// missing-restriction check, widening the active set past the explicit
		// CLI grant. The CLI grant now seeds the same durable live restriction
		// and residual a `--agent` + `--tools` launch gets, and the CLI baseline
		// lets a switch's leave path pin the restored set to the grant.
		const tempDir = makeTempDir();
		const lateWideningExtension: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				await Promise.resolve();
				pi.registerTool({
					name: "late_widening_tool",
					label: "Late Widening Tool",
					description: "Registered during session_start to try to widen the grant.",
					parameters: type({}),
					async execute() {
						return { content: [{ type: "text", text: "late" }] };
					},
				});
			});
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [toolActivationExtension, lateWideningExtension],
			toolNames: ["read"],
			personaSwitchable: true,
			personaCliToolOverride: true,
		});
		const mcpTool: CustomTool = {
			name: "mcp__fixture_lookup",
			label: "fixture/lookup",
			description: "Lookup from the fixture MCP server.",
			parameters: type({}),
			mcpServerName: "fixture",
			mcpToolName: "lookup",
			async execute() {
				return { content: [{ type: "text", text: "mcp" }] };
			},
		} satisfies CustomTool;

		try {
			// The extension tool registers (persona-switchable keeps discovery)…
			expect(session.getToolByName("default_active_tool")).toBeDefined();
			// …but stays OUT of the active set: the CLI grant named only `read`.
			expect(session.getActiveToolNames()).toEqual(["read"]);

			// A deferred MCP refresh cannot auto-activate past the CLI grant:
			// the tool registers but stays inactive.
			await session.refreshMCPTools([mcpTool]);
			expect(session.getToolByName("mcp__fixture_lookup")).toBeDefined();
			expect(session.getEnabledToolNames()).not.toContain("mcp__fixture_lookup");
			expect(session.getActiveToolNames()).toEqual(["read"]);

			// A late extension registration (the session_start handler fires the
			// same live registration path a background registration uses) cannot
			// widen past the grant either: the missing-restriction check sees the
			// seeded durable CLI restriction.
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			await initializeExtensions(session, {
				reportSendError: vi.fn(),
				reportRuntimeError: vi.fn(),
			});
			await runner.emit({ type: "session_start" });
			expect(session.getToolByName("late_widening_tool")).toBeDefined();
			expect(session.getEnabledToolNames()).not.toContain("late_widening_tool");
			expect(session.getActiveToolNames()).toEqual(["read"]);

			// A live `/agent` switch can still grant past the CLI list: the
			// persona's grant supersedes the durable restriction while active.
			await session.applyPersonaTools(["read", "default_active_tool"]);
			expect(session.getActiveToolNames()).toContain("default_active_tool");
			// …and leaving the persona restores the CLI grant exactly.
			await session.restoreBaselineTools();
			expect(session.getPersonaToolRestriction()).toBeDefined();
			expect(session.getActiveToolNames()).toEqual(["read"]);
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

	it("does not widen memory tools past a live persona restriction on backend apply", async () => {
		// A live `/agent` persona with an explicit `tools:` grant narrows the
		// session durably. A later `/set memory.backend …` (applyMemoryBackend)
		// replaces the memory tools; the replacement must register new backend
		// tools but NOT activate ones the persona did not grant — otherwise a
		// write-capable `learn` becomes callable under a read-only persona.
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({ "memory.backend": "local", "autolearn.enabled": true }),
		});
		try {
			await session.applyMemoryBackend();
			expect(session.getEnabledToolNames()).toContain("learn");

			await session.setBaselineToolNames(session.getEnabledToolNames());
			await session.applyPersonaTools(["read"]);
			expect(session.getEnabledToolNames()).toEqual(["read"]);

			// The backend apply re-creates `learn` (a MEMORY_BACKEND_TOOL_NAMES
			// member) but must not activate it past the persona grant.
			await session.applyMemoryBackend();
			expect(session.getEnabledToolNames()).toEqual(["read"]);

			// Leaving agent mode restores the unrestricted baseline, and a later
			// backend apply activates the memory tool again.
			await session.restoreBaselineTools();
			await session.applyMemoryBackend();
			expect(session.getEnabledToolNames()).toContain("learn");
		} finally {
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
			expect(activeToolNames).toEqual(expect.arrayContaining(["read", "yield", "generate_image", "write"]));
			// An explicit `toolNames` list is the user's EXACT request: the
			// auto-learn tools are NOT auto-activated from registry presence
			// (the registry is widened for baseline capture, so presence no
			// longer proves the user asked for the tool).
			expect(activeToolNames).not.toContain("manage_skill");
			expect(activeToolNames).not.toContain("learn");
			// The list grants `read` without `write`, so createTools registers a
			// device-only write transport and ambient custom and extension
			// capabilities mount through the xd:// transport instead of surfacing
			// top-level; filesystem writes stay rejected.
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

	it("revokes Cursor delete after a /agent switch to a read-only persona and restores it on switch back", async () => {
		// codex #3761853483 (wave-22 P1): `cursorCanMutateFiles` was computed at
		// launch time, so a session that started with write/edit active kept the
		// mutation permission after `/agent` switched to a read-only persona
		// (`tools: [read]`). The bridge now reads the LIVE active set, so the
		// native `delete` frame follows the persona switch in both directions.
		// The session is WRITE-ONLY at launch (`toolNames: ["read", "write"]`):
		// `editWasGranted` is false, so the launch-grant floor (wave-22 P2) does
		// not apply and the live revocation is observable.
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");

		await withProviderAuth(["cursor"], async () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				sessionManager,
				toolNames: ["read", "write"],
			});
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);

				// Control 1: write active at launch -> the delete executes.
				const firstTarget = path.join(tempDir, "first.txt");
				fs.writeFileSync(firstTarget, "remove me");
				const before = await handlers.delete({ toolCallId: "sdk-persona-1", path: "first.txt" } as never);
				expect(before.isError).toBe(false);
				expect(fs.existsSync(firstTarget)).toBe(false);

				// The fix: `/agent` switches to a read-only persona (`tools: [read]`),
				// dropping write from the active set. The delete must be REJECTED
				// and the file preserved.
				await session.applyPersonaTools(["read"]);
				expect(session.getActiveToolNames()).not.toContain("write");
				const secondTarget = path.join(tempDir, "second.txt");
				fs.writeFileSync(secondTarget, "keep me");
				const after = await handlers.delete({ toolCallId: "sdk-persona-2", path: "second.txt" } as never);
				expect(after.isError).toBe(true);
				expect(after.content).toEqual([{ type: "text", text: 'Tool "delete" not available' }]);
				expect(fs.existsSync(secondTarget)).toBe(true);

				// Control 2: switching back to a persona with write re-allows the delete.
				await session.applyPersonaTools(["read", "write"]);
				expect(session.getActiveToolNames()).toContain("write");
				const thirdTarget = path.join(tempDir, "third.txt");
				fs.writeFileSync(thirdTarget, "remove me again");
				const back = await handlers.delete({ toolCallId: "sdk-persona-3", path: "third.txt" } as never);
				expect(back.isError).toBe(false);
				expect(fs.existsSync(thirdTarget)).toBe(false);
			} finally {
				await session.dispose();
			}
		});
	});

	it("keeps the Cursor delete grant for a session that granted edit but not write (wave-22 P2)", async () => {
		// Internal review (wave-22 P2): the live `cursorCanMutateFiles` reads the
		// active set; a session that granted `edit` (not `write`) and later
		// loses `edit` from the active set (a persona switch) would lose the
		// delete/download grant below what the session was given at launch.
		// `editWasGranted` is the FLOOR: the same launch-time grant
		// `getCursorBridgeEditTool` still gates `pi_edit` on, so the session can
		// execute a file mutation but must not lose the native delete/download
		// grant it was given at launch. At launch, hashline `edit` is advertised
		// (Cursor calls it as MCP), so the live active-set check alone covers
		// the initial grant.
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");

		await withProviderAuth(["cursor"], async () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			// Created ON Cursor with `tools: [edit]` (a persona's exact tool
			// list): edit granted, write not.
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				sessionManager,
				model: cursorModel,
				toolNames: ["edit"],
			});
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);

				// Hashline `edit` stays advertised on Cursor (called as MCP),
				// so it is in the active set — the live check covers the grant
				// at launch; the `editWasGranted` floor covers a later persona
				// switch that drops it.
				expect(session.getActiveToolNames()).toContain("edit");
				expect(session.getActiveToolNames()).not.toContain("write");

				const target = path.join(tempDir, "edit-only.txt");
				fs.writeFileSync(target, "remove me");
				const result = await handlers.delete({ toolCallId: "sdk-edit-only-1", path: "edit-only.txt" } as never);
				expect(result.isError).toBe(false);
				expect(fs.existsSync(target)).toBe(false);
			} finally {
				await session.dispose();
			}
		});
	});

	it("revokes the Cursor delete/download grant after /agent readonly even when editWasGranted was true at launch", async () => {
		// codex #3762233472 (wave-23 P1): the wave-22 P2 floor
		// (`editWasGranted || ...`) was PERMANENT — a session that granted
		// `edit` (not `write`) kept the native delete/download grant after
		// `/agent` switched to a read-only persona, because the floor never
		// left. The floor is now REVOCABLE: a persona switch whose tools list
		// omits both `write` and `edit` drops the floor, and a later switch
		// back to a persona with `write` restores it.
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");

		await withProviderAuth(["cursor"], async () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			// Created ON Cursor with `tools: [edit]`: editWasGranted true,
			// write not granted.
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				sessionManager,
				model: cursorModel,
				toolNames: ["edit"],
			});
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);

				// Control 1: the floor holds at launch — the delete executes.
				const firstTarget = path.join(tempDir, "revocable-first.txt");
				fs.writeFileSync(firstTarget, "remove me");
				const before = await handlers.delete({
					toolCallId: "sdk-revocable-1",
					path: "revocable-first.txt",
				} as never);
				expect(before.isError).toBe(false);
				expect(fs.existsSync(firstTarget)).toBe(false);

				// The fix: `/agent` switches to a read-only persona
				// (`tools: [read]`), which omits both `write` and `edit`. The
				// floor must be revoked — the delete is REJECTED and the file
				// preserved.
				await session.applyPersonaTools(["read"]);
				expect(session.getActiveToolNames()).not.toContain("write");
				expect(session.getActiveToolNames()).not.toContain("edit");
				const secondTarget = path.join(tempDir, "revocable-second.txt");
				fs.writeFileSync(secondTarget, "keep me");
				const after = await handlers.delete({
					toolCallId: "sdk-revocable-2",
					path: "revocable-second.txt",
				} as never);
				expect(after.isError).toBe(true);
				expect(after.content).toEqual([{ type: "text", text: 'Tool "delete" not available' }]);
				expect(fs.existsSync(secondTarget)).toBe(true);

				// The MCP `download_path` mutation is gated on the same live
				// grant: revoked under the read-only persona (the gate throws
				// before the read, so no file is written), granted again once
				// write returns.
				await expect(
					handlers.readMcpResource({ server: "files", uri: "files://x", downloadPath: "revocable-dl.txt" }),
				).rejects.toThrow(/not available/);
				expect(fs.existsSync(path.join(tempDir, "revocable-dl.txt"))).toBe(false);

				// Control 2: switching back to a persona with write restores
				// the delete and the download.
				await session.applyPersonaTools(["read", "write"]);
				expect(session.getActiveToolNames()).toContain("write");
				const thirdTarget = path.join(tempDir, "revocable-third.txt");
				fs.writeFileSync(thirdTarget, "remove me again");
				const back = await handlers.delete({ toolCallId: "sdk-revocable-3", path: "revocable-third.txt" } as never);
				expect(back.isError).toBe(false);
				expect(fs.existsSync(thirdTarget)).toBe(false);

				// The harness has no MCP manager (`enableMCP: false`), so the
				// read itself answers `null` — the point is that the mutation
				// gate no longer throws: the download grant is restored.
				const download = await handlers.readMcpResource({
					server: "files",
					uri: "files://x",
					downloadPath: "revocable-dl.txt",
				});
				expect(download).toBeNull();
			} finally {
				await session.dispose();
			}
		});
	});

	it("revokes the Cursor pi_edit override after /agent readonly and restores it on switch back", async () => {
		// Cursor-focused review (wave-24 P1, empirically proven): the
		// revocable-floor fix (`editWasGranted && !personaDroppedMutation`)
		// landed on the native delete/downloadPath grant, but
		// `getCursorBridgeEditTool` kept checking `editWasGranted` ALONE — a
		// permanent launch-time capture. Since `executeTool` skips the live
		// `isToolGranted` re-check when an override is present, a pi_edit
		// frame still executed after `/agent` switched to a read-only persona
		// (`tools: [read]`) on a Cursor session that granted `edit` at
		// launch. The override must read the SAME live floor
		// `cursorCanMutateFiles` uses, so the read-only persona revokes it and
		// the frame falls through to the registry, where `isToolGranted`
		// rejects.
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");

		await withProviderAuth(["cursor"], async () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			// Created ON Cursor with `tools: [edit]`: editWasGranted true,
			// write not granted.
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				sessionManager,
				model: cursorModel,
				toolNames: ["edit"],
			});
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);

				// Control 1: the floor holds at launch — pi_edit executes and
				// mutates the file.
				const target = path.join(tempDir, "pi-edit-revocable.txt");
				fs.writeFileSync(target, "alpha\nbeta\n");
				const before = await handlers.piEdit({
					toolCallId: "sdk-pi-edit-revocable-1",
					args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
				} as never);
				expect(before.isError).toBe(false);
				expect(fs.readFileSync(target, "utf8")).toBe("alpha\ngamma\n");

				// The fix: `/agent` switches to a read-only persona
				// (`tools: [read]`), which omits both `write` and `edit` and
				// sets `personaDroppedMutation`. The override must be REVOKED:
				// pi_edit is rejected and the file preserved.
				await session.applyPersonaTools(["read"]);
				expect(session.getActiveToolNames()).not.toContain("write");
				expect(session.getActiveToolNames()).not.toContain("edit");
				fs.writeFileSync(target, "alpha\nbeta\n");
				const after = await handlers.piEdit({
					toolCallId: "sdk-pi-edit-revocable-2",
					args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
				} as never);
				expect(after.isError).toBe(true);
				expect(after.content).toEqual([{ type: "text", text: 'Tool "edit" not available' }]);
				expect(fs.readFileSync(target, "utf8")).toBe("alpha\nbeta\n");

				// Control 2: switching back to a persona that grants `edit` clears
				// `personaDroppedEdit` and restores the override — pi_edit executes
				// again. (A persona with `write` but not `edit` keeps the override
				// revoked — codex #3818999447.)
				await session.applyPersonaTools(["read", "edit"]);
				expect(session.getActiveToolNames()).toContain("edit");
				const back = await handlers.piEdit({
					toolCallId: "sdk-pi-edit-revocable-3",
					args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
				} as never);
				expect(back.isError).toBe(false);
				expect(fs.readFileSync(target, "utf8")).toBe("alpha\ngamma\n");
			} finally {
				await session.dispose();
			}
		});
	});

	it("restores the Cursor delete/download floor after leaving a read-only persona (agent mode exit)", async () => {
		// De-novo review (P1): leaving agent mode via
		// `#clearPersonaOwnedState` (the `/plan`, `/goal`, `/vibe`,
		// `/guided-goal` entries and the reconcile else-branches) calls
		// `restoreBaselineTools()`, which used to re-apply the baseline tools
		// WITHOUT a persona signal — the SDK's `personaDroppedMutation` flag
		// stayed `true` and the Cursor `editWasGranted` floor stayed revoked
		// forever, even though the baseline restore re-activated the session's
		// full tool set. The restore now passes an explicit `false` signal, so
		// the native delete/download grant is restored when agent mode is
		// left. Driven through the `/plan` clear path's session call
		// (`restoreBaselineTools` — what `#clearPersonaOwnedState` runs after
		// clearing the persona's spawns/prompt; the launch persona is seeded
		// with `personaAppendPrompt`/`spawns` so the clear helper would
		// recognize it as active).
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");

		await withProviderAuth(["cursor"], async () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			// Created ON Cursor with `tools: [edit]` as the LAUNCH persona's
			// exact list: `editWasGranted` true, write not granted, and the
			// baseline is the CLI list `["edit"]` (personaCliToolOverride).
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				sessionManager,
				model: cursorModel,
				toolNames: ["edit"],
				personaName: "launch-persona",
				personaCliToolOverride: true,
				personaAppendPrompt: "You are launch-persona.",
				spawns: "scout",
			});
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);

				// Control 1: the floor holds at launch — the delete executes.
				const firstTarget = path.join(tempDir, "floor-exit-first.txt");
				fs.writeFileSync(firstTarget, "remove me");
				const before = await handlers.delete({
					toolCallId: "sdk-floor-exit-1",
					path: "floor-exit-first.txt",
				} as never);
				expect(before.isError).toBe(false);
				expect(fs.existsSync(firstTarget)).toBe(false);

				// The fix: a read-only persona switch revokes the floor…
				await session.applyPersonaTools(["read"]);
				expect(session.getLastPersonaDroppedMutation()).toBe(true);
				const secondTarget = path.join(tempDir, "floor-exit-second.txt");
				fs.writeFileSync(secondTarget, "keep me");
				const revoked = await handlers.delete({
					toolCallId: "sdk-floor-exit-2",
					path: "floor-exit-second.txt",
				} as never);
				expect(revoked.isError).toBe(true);
				expect(fs.existsSync(secondTarget)).toBe(true);

				// …and leaving agent mode (the `/plan` clear path) restores
				// it: the baseline re-capture re-activates the pre-persona
				// tool set, so the persona's revocation no longer applies.
				// Hashline `edit` stays advertised on Cursor, so the baseline
				// re-activation puts it back in the active set.
				await session.restoreBaselineTools();
				expect(session.getLastPersonaDroppedMutation()).toBe(false);
				expect(session.getActiveToolNames()).toContain("edit");
				const thirdTarget = path.join(tempDir, "floor-exit-third.txt");
				fs.writeFileSync(thirdTarget, "remove me");
				const back = await handlers.delete({
					toolCallId: "sdk-floor-exit-3",
					path: "floor-exit-third.txt",
				} as never);
				expect(back.isError).toBe(false);
				expect(fs.existsSync(thirdTarget)).toBe(false);
			} finally {
				await session.dispose();
			}
		});
	});

	it("answers pi_edit after leaving a persona whose tools list omitted edit", async () => {
		// PRT_kwDOQxs0bc6fkNgL: a launch `--agent` persona whose `tools:` list
		// omits `edit` sets editWasGranted=false, and while it is active the
		// live persona restriction does not contain `edit` either. Leaving
		// agent mode (restoreBaselineTools) re-activates the baseline — which
		// includes `edit` (essential load mode) — and CLEARS the restriction,
		// so neither grant face held and getCursorBridgeEditTool returned
		// undefined: native pi_edit failed although `edit` was active and
		// advertised. The predicate now also reads the live active set.
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");

		await withProviderAuth(["cursor"], async () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			// Launch persona WITHOUT edit (no CLI override, so the baseline is
			// the full registry): editWasGranted=false, restriction=["read"].
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				sessionManager,
				model: cursorModel,
				toolNames: ["read"],
				personaName: "readonly-persona",
				personaAppendPrompt: "You are readonly-persona.",
			});
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);

				// Control: while the persona is active, no grant face holds —
				// the bridge must stay closed (issue #5680 guard unchanged).
				const target = path.join(tempDir, "persona-leave-edit.txt");
				fs.writeFileSync(target, "alpha\nbeta\n");
				const denied = await handlers.piEdit({
					toolCallId: "sdk-persona-leave-1",
					args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
				} as never);
				expect(denied.isError).toBe(true);
				expect(fs.readFileSync(target, "utf8")).toBe("alpha\nbeta\n");

				// Leaving agent mode: the baseline restore re-activates `edit`
				// and clears the persona restriction — the active set is now
				// the live grant, so pi_edit must execute.
				await session.restoreBaselineTools();
				expect(session.getPersonaToolRestriction()).toBeUndefined();
				expect(session.getActiveToolNames()).toContain("edit");
				const granted = await handlers.piEdit({
					toolCallId: "sdk-persona-leave-2",
					args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
				} as never);
				expect(granted.isError).toBe(false);
				expect(fs.readFileSync(target, "utf8")).toBe("alpha\ngamma\n");
			} finally {
				await session.dispose();
			}
		});
	});

	it("restores the Cursor delete floor after a FAILED /agent switch to a read-only persona", async () => {
		// Wave-23 P2 regression: the persona-switch rollback paths
		// (`switchAgentPersona` and the ACP `/agent` handler) re-applied the
		// pre-switch tools with NO persona signal, so the SDK's
		// `personaDroppedMutation` flag stayed `true` after a failed read-only
		// switch — the Cursor `editWasGranted` floor stayed revoked on the
		// rolled-back session. The rollback now snapshots the flag before the
		// apply and forwards it back, restoring the exact pre-switch value.
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const agentsDir = path.join(tempDir, ".omp", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "persona-readonly.md"),
			[
				"---",
				"name: persona-readonly",
				"description: read-only persona",
				"tools: [read]",
				"model: anthropic/claude-haiku-4-5",
				"---",
				"You are a read-only persona.",
			].join("\n"),
		);

		await withProviderAuth(["cursor", "anthropic"], async () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			// Created ON Cursor with `tools: [edit]`: editWasGranted true, so
			// the floor holds at launch (same setup as the revocable-floor
			// test above).
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				sessionManager,
				model: cursorModel,
				toolNames: ["edit"],
			});
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);

				// Control 1: the floor holds at launch — the delete executes.
				const firstTarget = path.join(tempDir, "rollback-first.txt");
				fs.writeFileSync(firstTarget, "remove me");
				const before = await handlers.delete({
					toolCallId: "sdk-rollback-1",
					path: "rollback-first.txt",
				} as never);
				expect(before.isError).toBe(false);
				expect(fs.existsSync(firstTarget)).toBe(false);

				// Drive the ACP `/agent` path (the shared rollback in
				// `applyAgentPersonaToSession`) and make the persona's model
				// switch fail AFTER the read-only tools were applied — the
				// exact sequence that left `personaDroppedMutation` stale.
				const output = vi.fn();
				const runtime: SlashCommandRuntime = {
					session,
					sessionManager,
					settings: session.settings,
					cwd: tempDir,
					output,
					refreshCommands: vi.fn(),
					reloadPlugins: vi.fn(),
				};
				vi.spyOn(session, "setModelTemporary").mockImplementationOnce(async () => {
					throw new Error("boom");
				});
				const result = await executeAcpBuiltinSlashCommand("/agent persona-readonly", runtime);

				expect(result).toEqual({ consumed: true });
				expect(output).toHaveBeenCalledWith(expect.stringContaining("Failed to switch to agent persona"));
				// The rollback restored the pre-switch tools AND the exact
				// pre-switch persona signal (false = floor holds).
				expect(session.getLastPersonaDroppedMutation()).toBe(false);

				// The fix: the delete EXECUTES again after the failed switch —
				// the floor was restored, not left revoked.
				const secondTarget = path.join(tempDir, "rollback-second.txt");
				fs.writeFileSync(secondTarget, "remove me");
				const after = await handlers.delete({
					toolCallId: "sdk-rollback-2",
					path: "rollback-second.txt",
				} as never);
				expect(after.isError).toBe(false);
				expect(fs.existsSync(secondTarget)).toBe(false);
			} finally {
				await session.dispose();
			}
		});
	});

	it("rejects a scoped pi_grep after /agent drops grep and restores it on switch back (codex #3762233481)", async () => {
		// The bridge is built ONCE at session creation, so the grep override
		// factory was fixed at construction: a session that started with grep
		// active kept the per-call factory after `/agent` switched to a
		// read-only persona, and `executeTool` skips the live `isToolGranted`
		// re-check for override tools — so scoped frames (`context`/`limit`)
		// kept searching. The override now consults the LIVE active set at
		// frame time: after the switch it returns undefined, the frame falls
		// through to the registry, and the live grant rejects it.
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const target = path.join(tempDir, "needle.txt");
		fs.writeFileSync(target, "needle\n");

		await withProviderAuth(["cursor"], async () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				sessionManager,
				toolNames: ["read", "grep"],
			});
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);

				// Control 1: grep active at launch -> the scoped frame executes.
				const before = await handlers.piGrep({
					toolCallId: "sdk-grep-1",
					args: { pattern: "needle", path: tempDir, context: 1, limit: 5 },
				} as never);
				expect(before.isError).toBe(false);
				expect((before.details as { matchCount?: number } | undefined)?.matchCount).toBe(1);

				// The fix: `/agent` switches to a read-only persona
				// (`tools: [read]`), dropping grep from the active set. The
				// scoped frame must be REJECTED, not executed through the
				// construction-time override.
				await session.applyPersonaTools(["read"]);
				expect(session.getActiveToolNames()).not.toContain("grep");
				const after = await handlers.piGrep({
					toolCallId: "sdk-grep-2",
					args: { pattern: "needle", path: tempDir, context: 1, limit: 5 },
				} as never);
				expect(after.isError).toBe(true);
				expect(after.content).toEqual([{ type: "text", text: 'Tool "grep" not available' }]);

				// Control 2: switching back to a persona with grep re-allows
				// the scoped frame.
				await session.applyPersonaTools(["read", "grep"]);
				expect(session.getActiveToolNames()).toContain("grep");
				const back = await handlers.piGrep({
					toolCallId: "sdk-grep-3",
					args: { pattern: "needle", path: tempDir, context: 1, limit: 5 },
				} as never);
				expect(back.isError).toBe(false);
				expect((back.details as { matchCount?: number } | undefined)?.matchCount).toBe(1);
			} finally {
				await session.dispose();
			}
		});
	});

	it("denies Cursor delete for a session that granted neither edit nor write", async () => {
		// Control for the wave-22 P2 floor: a session granted neither mutating
		// tool must still be denied — the floor only preserves a grant the
		// session actually made at launch.
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");

		await withProviderAuth(["cursor"], async () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				sessionManager,
				model: cursorModel,
				toolNames: ["read"],
			});
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);

				const target = path.join(tempDir, "read-only.txt");
				fs.writeFileSync(target, "keep me");
				const result = await handlers.delete({ toolCallId: "sdk-read-only-1", path: "read-only.txt" } as never);
				expect(result.isError).toBe(true);
				expect(result.content).toEqual([{ type: "text", text: 'Tool "delete" not available' }]);
				expect(fs.existsSync(target)).toBe(true);
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
