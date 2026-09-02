import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { AuthStorage, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { EVAL_AGENT_BRIDGE_NAME } from "../src/eval/agent-bridge";
import { EVAL_BUDGET_BRIDGE_NAME } from "../src/eval/budget-bridge";
import { EVAL_COMPLETION_BRIDGE_NAME } from "../src/eval/completion-bridge";
import { EVAL_CONCURRENCY_BRIDGE_NAME } from "../src/eval/concurrency-bridge";
import { createAgentSession } from "../src/sdk";
import { AgentSession } from "../src/session/agent-session";
import type { ToolNamespacesInfo } from "../src/session/code-mode";
import { buildToolNamespacesInfo, resolveCodeMode } from "../src/session/code-mode";
import { SessionManager } from "../src/session/session-manager";
import { generateCodeModeDeclarations } from "../src/tools/eval-format/code-mode-declarations";

const ENABLED = [
	"eval",
	"ask",
	"todo",
	"yield",
	"think",
	"checkpoint",
	"rewind",
	"read",
	"bash",
	"edit",
	"mcp__gmail__search",
];

describe("resolveCodeMode", () => {
	test("off: inactive regardless of catalog flag", () => {
		const r = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "off",
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});
		expect(r.active).toBe(false);
		expect(r.directToolNames).toEqual(new Set(ENABLED));
	});
	test("auto + code_mode_only: active, keep-set only", () => {
		const r = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "auto",
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});
		expect(r.active).toBe(true);
		expect([...r.directToolNames].sort()).toEqual(["ask", "checkpoint", "eval", "rewind", "think", "todo", "yield"]);
	});
	test("auto without flag: inactive", () => {
		expect(
			resolveCodeMode({
				provider: "openai-codex",
				setting: "auto",
				enabledToolNames: ENABLED,
				evalTransportAvailable: true,
			}).active,
		).toBe(false);
	});
	test("on: active without catalog flag", () => {
		expect(
			resolveCodeMode({
				provider: "openai-codex",
				setting: "on",
				enabledToolNames: ENABLED,
				evalTransportAvailable: true,
			}).active,
		).toBe(true);
	});
	test("non-codex provider: inactive even when on", () => {
		expect(
			resolveCodeMode({
				provider: "anthropic",
				setting: "on",
				enabledToolNames: ENABLED,
				evalTransportAvailable: true,
			}).active,
		).toBe(false);
	});
	test("inactive when eval is unavailable", () => {
		expect(
			resolveCodeMode({
				provider: "openai-codex",
				toolMode: "code_mode_only",
				setting: "auto",
				enabledToolNames: ["read", "bash"],
				evalTransportAvailable: true,
			}).active,
		).toBe(false);
	});
	test("inactive when the eval transport lacks JavaScript", () => {
		expect(
			resolveCodeMode({
				provider: "openai-codex",
				toolMode: "code_mode_only",
				setting: "auto",
				enabledToolNames: ["eval", "read"],
				evalTransportAvailable: false,
			}).active,
		).toBe(false);
	});
	test("extra direct tools honored only when enabled", () => {
		const r = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "auto",
			extraDirectTools: ["read", "nonexistent"],
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});
		expect(r.directToolNames.has("read")).toBe(true);
		expect(r.directToolNames.has("nonexistent")).toBe(false);
	});
	test("keep-set intersects enabled tools", () => {
		const r = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "auto",
			enabledToolNames: ["eval", "read"],
			evalTransportAvailable: true,
		});
		expect([...r.directToolNames]).toEqual(["eval"]);
	});
	test("prototype-named tools do not bypass the keep-set", () => {
		const r = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "auto",
			enabledToolNames: ["eval", "toString", "__proto__"],
			evalTransportAvailable: true,
		});
		expect([...r.directToolNames]).toEqual(["eval"]);
	});
	test("reserved eval bridge names stay direct", () => {
		// `callSessionTool` consumes these before the registry, so demoting a tool
		// that shares one of those names would make it unreachable.
		const reserved = [
			EVAL_AGENT_BRIDGE_NAME,
			EVAL_BUDGET_BRIDGE_NAME,
			EVAL_COMPLETION_BRIDGE_NAME,
			EVAL_CONCURRENCY_BRIDGE_NAME,
		];
		const r = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "auto",
			enabledToolNames: ["eval", "read", ...reserved],
			evalTransportAvailable: true,
		});
		expect([...r.directToolNames]).toEqual(["eval", ...reserved]);
	});
});

describe("buildToolNamespacesInfo", () => {
	test("shape and flags", () => {
		const info = buildToolNamespacesInfo({
			tools: [
				{ name: "eval", loadMode: "essential" },
				{ name: "read", loadMode: "essential" },
				{ name: "browser", loadMode: "discoverable" },
				{ name: "mcp__gmail__search", mcpServerName: "gmail" },
			],
			directToolNames: new Set(["eval"]),
		});
		expect(info.functions.name).toBe("functions");
		expect(info.functions.functions.eval).toEqual({
			name: "eval",
			direct: true,
			code_mode_name: "eval",
			deferred: false,
			source: { kind: "harness" },
		});
		expect(info.functions.functions.read).toEqual({
			name: "read",
			direct: false,
			code_mode_name: "read",
			deferred: false,
			source: { kind: "harness" },
		});
		expect(info.functions.functions.browser.deferred).toBe(true);
		expect(info.functions.functions.mcp__gmail__search.source).toEqual({ kind: "mcp", server_name: "gmail" });
	});
	test("direct tools use wire names while retaining bridge names", () => {
		const info = buildToolNamespacesInfo({
			tools: [{ name: "edit", customWireName: "apply_patch" }],
			directToolNames: new Set(["edit"]),
		});

		expect(info.functions.functions.apply_patch).toEqual({
			name: "apply_patch",
			direct: true,
			code_mode_name: "edit",
			deferred: false,
			source: { kind: "harness" },
		});
		expect(info.functions.functions.edit).toBeUndefined();
	});
	test("a direct wire alias wins its name regardless of registry order", () => {
		const tools = [{ name: "edit", customWireName: "apply_patch" }, { name: "apply_patch" }];
		const direct = new Set(["edit"]);
		const forward = buildToolNamespacesInfo({ tools, directToolNames: direct });
		const reversed = buildToolNamespacesInfo({ tools: [...tools].reverse(), directToolNames: direct });

		for (const info of [forward, reversed]) {
			expect(info.functions.functions.apply_patch).toEqual({
				name: "apply_patch",
				direct: true,
				code_mode_name: "edit",
				deferred: false,
				source: { kind: "harness" },
			});
		}
	});

	test("an exact direct name wins over a colliding direct alias", () => {
		const tools = [{ name: "edit", customWireName: "apply_patch" }, { name: "apply_patch" }];
		const direct = new Set(["edit", "apply_patch"]);

		for (const ordered of [tools, [...tools].reverse()]) {
			const info = buildToolNamespacesInfo({ tools: ordered, directToolNames: direct });
			expect(info.functions.functions.apply_patch?.code_mode_name).toBe("apply_patch");
		}
	});

	test("a tool losing its wire name stays reachable through the bridge", () => {
		// The metadata advertises one callable per wire name, so the loser is
		// unadvertised there - but the bridge resolves by real tool name, and the
		// eval declarations are generated from the bridge names, so it stays
		// callable as `tool.apply_patch()`.
		const info = buildToolNamespacesInfo({
			tools: [{ name: "edit", customWireName: "apply_patch" }, { name: "apply_patch" }],
			directToolNames: new Set(["edit"]),
		});
		expect(Object.keys(info.functions.functions)).toEqual(["apply_patch"]);

		const declarations = generateCodeModeDeclarations([{ name: "apply_patch", parameters: undefined }]);
		expect(declarations).toContain("apply_patch(args: unknown): Promise<unknown>;");
	});

	test("prototype-named tools land as own entries", () => {
		const info = buildToolNamespacesInfo({
			tools: [{ name: "toString" }, { name: "__proto__" }],
			directToolNames: new Set<string>(),
		});

		const wire = new Map<string, { code_mode_name: string }>(
			Object.entries(JSON.parse(JSON.stringify(info)).functions.functions),
		);
		expect([...wire.keys()].sort()).toEqual(["__proto__", "toString"]);
		expect(wire.get("toString")?.code_mode_name).toBe("toString");
		expect(wire.get("__proto__")?.code_mode_name).toBe("__proto__");
	});
});

describe("Code Mode session reconciliation", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	function model(provider: string, toolMode?: "code_mode_only"): Model {
		return buildModel({
			id: `${provider}-${toolMode ?? "direct"}`,
			name: provider,
			api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
			provider,
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
			toolMode,
		});
	}

	function tool(name: string): AgentTool {
		return {
			name,
			label: name,
			description: name,
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text", text: name }] };
			},
		};
	}

	function createSession(
		settings: Settings,
		rebuildSystemPrompt: (
			names: string[],
			tools?: Map<string, AgentTool>,
			options?: { directToolNames?: readonly string[] },
		) => Promise<{ systemPrompt: string[] }> = async names => ({
			systemPrompt: [`tools:${names.join(",")}`],
		}),
		setActiveToolNames?: (names: Iterable<string>) => void,
		extraTools: AgentTool[] = [],
		evalOverride?: AgentTool,
	): { session: AgentSession; directModel: Model; codeModel: Model } {
		const codeModel = model("openai-codex", "code_mode_only");
		const directModel = model("openai");
		const evalTool = evalOverride ?? { ...tool("eval"), supportsCodeModeTransport: () => settings.get("eval.js") };
		const tools = [evalTool, tool("read"), ...extraTools];
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: codeModel, systemPrompt: [], tools } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: {
				getApiKey: async () => "test-key",
				hasConfiguredAuth: () => true,
				refreshSelectedModelMetadata: async (value: Model) => value,
				clearSuppressedSelector: () => undefined,
			} as never,
			toolRegistry: new Map(tools.map(value => [value.name, value])),
			builtInToolNames: tools.map(value => value.name),
			rebuildSystemPrompt,
			setActiveToolNames,
		});
		sessions.push(session);
		return { session, directModel, codeModel };
	}
	test("prompt rebuilds receive the direct keep-set for the tool inventory", async () => {
		const directCalls: Array<readonly string[] | undefined> = [];
		const { session, directModel } = createSession(
			Settings.isolated({ "providers.openai-codex.codeMode": "auto" }),
			async (names, _tools, options) => {
				directCalls.push(options?.directToolNames);
				return { systemPrompt: [`tools:${names.join(",")}`] };
			},
		);
		await session.setActiveToolsByName(["eval", "read"]);
		expect(directCalls.at(-1)).toEqual(["eval"]);

		await session.setModel(directModel);
		expect(directCalls.at(-1)).toBeUndefined();
	});

	test("model switches reapply the full enabled set across Code Mode boundaries", async () => {
		const { session, directModel, codeModel } = createSession(
			Settings.isolated({ "providers.openai-codex.codeMode": "auto" }),
		);
		await session.setActiveToolsByName(["eval", "read"]);
		expect(session.agent.state.tools.map(value => value.name)).toEqual(["eval"]);
		expect(session.getEnabledToolNames()).toEqual(["eval", "read"]);

		await session.setModel(directModel);
		expect(session.agent.state.tools.map(value => value.name)).toEqual(["eval", "read"]);

		await session.setModel(codeModel);
		expect(session.agent.state.tools.map(value => value.name)).toEqual(["eval"]);
	});

	test("a caller slate without eval keeps Code Mode inactive", async () => {
		const { session } = createSession(Settings.isolated({ "providers.openai-codex.codeMode": "auto" }));

		await session.setActiveToolsByName(["read"]);

		expect(session.getEnabledToolNames()).toEqual(["read"]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.codeModeNamespacesInfo).toBeUndefined();
	});

	test("startup reconcile survives a transiently narrow live tool set", async () => {
		const { session } = createSession(Settings.isolated({ "providers.openai-codex.codeMode": "auto" }));
		// Before the first apply, a startup-time mutation can shrink the live
		// agent tools. A reconcile landing in that window must reapply the
		// construction slate, not commit the shrunken set as sticky.
		session.agent.setTools([]);
		await session.initializeCodeMode();

		expect(session.getEnabledToolNames()).toEqual(["eval", "read"]);
		expect(session.getActiveToolNames()).toEqual(["eval"]);
	});

	test("an eval replacement that cannot state transport support keeps the direct surface", async () => {
		const { session } = createSession(
			Settings.isolated({ "providers.openai-codex.codeMode": "auto" }),
			undefined,
			undefined,
			[],
			tool("eval"),
		);
		await session.setActiveToolsByName(["eval", "read"]);

		expect(session.getActiveToolNames()).toEqual(["eval", "read"]);
		expect(session.codeModeNamespacesInfo).toBeUndefined();
	});

	test("model switches refresh direct wire-name metadata", async () => {
		let wireName: string | undefined = "apply_patch";
		const edit = {
			...tool("edit"),
			get customWireName() {
				return wireName;
			},
		};
		const { session, codeModel } = createSession(
			Settings.isolated({
				"providers.openai-codex.codeMode": "auto",
				"providers.openai-codex.codeModeDirectTools": ["edit"],
			}),
			undefined,
			undefined,
			[edit],
		);
		await session.setActiveToolsByName(["eval", "edit"]);
		expect((session.codeModeNamespacesInfo as ToolNamespacesInfo).functions.functions.apply_patch).toBeDefined();

		wireName = undefined;
		await session.setModel({ ...codeModel, id: `${codeModel.id}-next` });

		const info = session.codeModeNamespacesInfo as ToolNamespacesInfo;
		expect(info.functions.functions.edit).toBeDefined();
		expect(info.functions.functions.apply_patch).toBeUndefined();
	});

	test("runtime setting changes immediately reconcile the Code Mode surface", async () => {
		const settings = Settings.isolated();
		settings.set("providers.openai-codex.codeMode", "auto");
		const { session } = createSession(settings);
		await session.setActiveToolsByName(["eval", "read"]);
		expect(session.agent.state.tools.map(value => value.name)).toEqual(["eval"]);

		settings.set("providers.openai-codex.codeMode", "off");
		await session.runToolRegistryMutation(async () => undefined);
		expect(session.agent.state.tools.map(value => value.name)).toEqual(["eval", "read"]);
	});

	test("runtime eval.js changes reconcile Code Mode transport availability", async () => {
		const settings = Settings.isolated();
		settings.set("eval.js", true);
		settings.set("providers.openai-codex.codeMode", "auto");
		const { session } = createSession(settings);
		await session.setActiveToolsByName(["eval", "read"]);
		expect(session.getActiveToolNames()).toEqual(["eval"]);

		settings.set("eval.js", false);
		await session.runToolRegistryMutation(async () => undefined);
		expect(session.getActiveToolNames()).toEqual(["eval", "read"]);
		expect(session.codeModeNamespacesInfo).toBeUndefined();

		settings.set("eval.js", true);
		await session.runToolRegistryMutation(async () => undefined);
		expect(session.getActiveToolNames()).toEqual(["eval"]);
	});

	test("Vibe teardown preserves bridge-enabled Code Mode tools", async () => {
		const { session } = createSession(Settings.isolated({ "providers.openai-codex.codeMode": "auto" }));
		await session.setActiveToolsByName(["eval", "read"]);

		await session.removeVibeToolsPreservingActive();

		expect(session.getEnabledToolNames()).toEqual(["eval", "read"]);
		expect(session.getToolForEvalBridge("read")?.name).toBe("read");
	});

	test("prompt rebuilds retain safety gates for bridge-enabled tools", async () => {
		const promptToolSets: string[][] = [];
		const { session } = createSession(
			Settings.isolated({ "providers.openai-codex.codeMode": "auto" }),
			async names => {
				promptToolSets.push([...names]);
				return { systemPrompt: [`tools:${names.join(",")}`] };
			},
			undefined,
			[tool("computer")],
		);

		await session.setActiveToolsByName(["eval", "computer"]);

		expect(session.agent.state.tools.map(value => value.name)).toEqual(["eval"]);
		expect(promptToolSets.at(-1)).toEqual(["eval", "computer"]);

		await session.setActiveToolsByName(["eval"]);
		expect(promptToolSets.at(-1)).toEqual(["eval"]);
	});

	test("bridge-enabled task retains eager delegation", async () => {
		const settings = Settings.isolated({
			"providers.openai-codex.codeMode": "auto",
			"task.eager": "always",
			"todo.enabled": false,
		});
		const { session } = createSession(settings, undefined, undefined, [tool("task")]);
		await session.setActiveToolsByName(["eval", "task"]);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("implement the parser");

		const messages = promptSpy.mock.calls[0]?.[0] as unknown as Array<{ customType?: string }>;
		expect(session.getActiveToolNames()).toEqual(["eval"]);
		expect(messages.some(message => message.customType === "eager-task-prelude")).toBe(true);
	});

	test("bridge-enabled task retains orchestration notices", async () => {
		const { session } = createSession(
			Settings.isolated({ "providers.openai-codex.codeMode": "auto" }),
			undefined,
			undefined,
			[tool("task")],
		);
		await session.setActiveToolsByName(["eval", "task"]);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate and workflowz this");

		const messages = promptSpy.mock.calls[0]?.[0] as unknown as Array<{ customType?: string }>;
		expect(messages.map(message => message.customType).filter(Boolean)).toEqual([
			"orchestrate-notice",
			"workflow-notice",
		]);
	});

	test("prompt refresh preserves the full Code Mode tool predicate", async () => {
		const predicateUpdates: string[][] = [];
		const { session } = createSession(
			Settings.isolated({ "providers.openai-codex.codeMode": "auto" }),
			undefined,
			names => predicateUpdates.push([...names]),
		);
		await session.setActiveToolsByName(["eval", "read"]);
		expect(predicateUpdates.at(-1)).toEqual(["eval", "read"]);

		await session.refreshBaseSystemPrompt();

		expect(predicateUpdates.at(-1)).toEqual(["eval", "read"]);
	});

	test("failed tool application leaves Code Mode namespace metadata unchanged", async () => {
		const { session } = createSession(Settings.isolated({ "providers.openai-codex.codeMode": "auto" }), async () => {
			throw new Error("rebuild failed");
		});

		await expect(session.setActiveToolsByName(["eval", "read"])).rejects.toThrow("rebuild failed");

		expect(session.codeModeNamespacesInfo).toBeUndefined();
		expect(session.getActiveToolNames()).toEqual(["eval", "read"]);
	});

	test("plan guidance keeps task delegation after Code Mode demotes the tool", async () => {
		async function planPrompt(codeMode: "on" | "off", extraTools: AgentTool[], names: string[]): Promise<string> {
			const { session } = createSession(
				Settings.isolated({ "providers.openai-codex.codeMode": codeMode }),
				undefined,
				undefined,
				extraTools,
			);
			await session.setActiveToolsByName(names);
			session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
			await session.sendPlanModeContext();
			const planMessage = session.state.messages.find(
				message => (message as { customType?: string }).customType === "plan-mode-context",
			);
			return String((planMessage as { content?: string })?.content);
		}

		// The contract is invariance: demoting `task` off the direct surface is a
		// transport change, so the guidance must match a session where `task` is
		// directly callable, and must differ from one that cannot delegate at all.
		const demoted = await planPrompt("on", [tool("task")], ["eval", "task"]);
		const direct = await planPrompt("off", [tool("task")], ["eval", "task"]);
		const unavailable = await planPrompt("on", [], ["eval"]);

		expect(demoted).toBe(direct);
		expect(demoted).not.toBe(unavailable);
	});
});

describe("Code Mode session startup", () => {
	// Regression: a session created directly on a `code_mode_only` Codex model
	// (or with `codeMode: "on"`) used to keep the unrestricted initial tool
	// surface and omit `tool_namespaces_info` until an unrelated model, setting,
	// or tool-selection change reconciled. Startup itself must apply the
	// restricted surface so the very first provider turn sees it.
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	test("fresh session on a code_mode_only model starts restricted with namespaces info", async () => {
		registryDir = path.join(os.tmpdir(), `pi-code-mode-startup-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(registryDir, "models.yml"));
		const codeModel = buildModel({
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
			toolMode: "code_mode_only",
		});
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "providers.openai-codex.codeMode": "auto" }),
			model: codeModel,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(session);

		const active = session.getActiveToolNames();
		expect(active).toContain("eval");
		expect(active).not.toContain("read");
		expect(active).not.toContain("bash");
		// Demoted tools stay enabled and bridge-reachable instead of vanishing.
		expect(session.getEnabledToolNames()).toContain("read");
		expect(session.getToolForEvalBridge("read")?.name).toBe("read");
		// The namespaces snapshot feeding `tool_namespaces_info` exists before
		// any turn runs.
		const info = session.codeModeNamespacesInfo as ToolNamespacesInfo;
		expect(info.functions.functions.eval.direct).toBe(true);
		expect(info.functions.functions.read.direct).toBe(false);
	});

	test("fresh session with code mode off keeps the direct surface and no namespaces info", async () => {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "providers.openai-codex.codeMode": "off" }),
			model: buildModel({
				id: "gpt-5.6-sol",
				name: "GPT-5.6 Sol",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
				toolMode: "code_mode_only",
			}),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(session);

		const active = session.getActiveToolNames();
		expect(active).toContain("read");
		expect(active).toContain("bash");
		expect(session.codeModeNamespacesInfo).toBeUndefined();
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
		authStorage?.close();
		if (registryDir && fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});
});
