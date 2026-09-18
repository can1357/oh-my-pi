import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { type AssistantMessage, createAssistantMessageEventStream, getCustomApi, type ToolCall } from "@oh-my-pi/pi-ai";
import { runCommitAgentSession } from "@oh-my-pi/pi-coding-agent/commit/agentic/agent";
import * as commitTools from "@oh-my-pi/pi-coding-agent/commit/agentic/tools";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, setAgentDir, Snowflake } from "@oh-my-pi/pi-utils";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const providerName = "restricted-session-provider";
const modelId = "restricted-session-model";
const apiId = "restricted-session-api";
const sourceId = "<inline-0>";

describe("restricted sessions sharing extension providers", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let providerRequests: number;
	let settings: Settings;

	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalPiProfile = process.env.PI_PROFILE;
	const originalOmpProfile = process.env.OMP_PROFILE;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-restricted-provider-${Snowflake.next()}`);
		const testAgentDir = path.join(tempDir, "agent");
		fs.mkdirSync(testAgentDir, { recursive: true });
		setAgentDir(testAgentDir);
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		settings = Settings.isolated();
		settings.setModelRole("default", `${providerName}/${modelId}`);
		providerRequests = 0;
	});

	afterEach(() => {
		try {
			vi.restoreAllMocks();
			modelRegistry.clearSourceRegistrations(sourceId);
			authStorage.close();
		} finally {
			restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
			restoreEnv("PI_PROFILE", originalPiProfile);
			restoreEnv("OMP_PROFILE", originalOmpProfile);
			__resetDirsFromEnvForTests();
			removeSyncWithRetries(tempDir);
		}
	});

	afterAll(() => {
		restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
		restoreEnv("PI_PROFILE", originalPiProfile);
		restoreEnv("OMP_PROFILE", originalOmpProfile);
		__resetDirsFromEnvForTests();
	});

	const providerExtension: ExtensionFactory = pi => {
		pi.registerProvider(providerName, {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: apiId,
			streamSimple: () => {
				providerRequests++;
				const stream = createAssistantMessageEventStream();
				if (providerRequests === 1) {
					const toolCall: ToolCall = {
						type: "toolCall",
						id: "complete-commit",
						name: "complete_commit",
						arguments: {},
					};
					const message: AssistantMessage = {
						...createAssistantMessage(""),
						content: [toolCall],
						api: apiId,
						provider: providerName,
						model: modelId,
						stopReason: "toolUse",
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message: AssistantMessage = {
						...createAssistantMessage("Commit proposal complete."),
						api: apiId,
						provider: providerName,
						model: modelId,
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				}
				return stream;
			},
			models: [
				{
					id: modelId,
					name: "Restricted Session Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	};

	function createOptions(): CreateAgentSessionOptions {
		return {
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		};
	}

	async function withRestrictedChild(
		extension: ExtensionFactory,
		run: (child: AgentSession, parent: AgentSession) => Promise<void>,
	): Promise<void> {
		const { session: parent } = await createAgentSession({
			...createOptions(),
			agentId: "PolicyParent",
			extensions: [providerExtension, extension],
		});
		try {
			const { session: child } = await createAgentSession({
				...createOptions(),
				model: parent.model,
				agentId: "PolicyChild",
				parentAgentId: parent.getAgentId(),
				restrictToolNames: true,
				preloadedPreparedExtensions: parent.preparedExtensions,
				extensions: [
					() => {
						throw new Error("New inline extensions must not run in restricted children");
					},
				],
				additionalExtensionPaths: [path.join(tempDir, "untrusted.mjs")],
			});
			try {
				await initializeExtensions(child, { reportSendError: vi.fn(), reportRuntimeError: vi.fn() });
				await run(child, parent);
			} finally {
				await child.dispose();
			}
		} finally {
			await parent.dispose();
		}
	}

	test("rebinds inherited policy to restricted children and their descendants", async () => {
		const blocked = path.join(tempDir, "blocked.txt");
		const allowed = path.join(tempDir, "allowed.txt");
		await Bun.write(blocked, "private fixture");
		await Bun.write(allowed, "allowed fixture");
		await Bun.write(path.join(tempDir, "untrusted.mjs"), "throw new Error('New extension path executed');");
		const policy: ExtensionFactory = pi => {
			let initialized = false;
			pi.on("session_start", () => {
				initialized = true;
			});
			pi.on("tool_call", (event, ctx) => {
				if (!initialized) throw new Error("Policy has not initialized");
				if (event.toolName === "read" && event.input.path === blocked) {
					return { block: true, reason: `Denied by ${ctx.agentId}, child of ${ctx.parentAgentId}` };
				}
			});
		};
		await withRestrictedChild(policy, async (child, parent) => {
			const { session: grandchild } = await createAgentSession({
				...createOptions(),
				model: child.model,
				agentId: "PolicyGrandchild",
				parentAgentId: child.getAgentId(),
				restrictToolNames: true,
				preloadedPreparedExtensions: child.preparedExtensions,
			});
			try {
				await initializeExtensions(grandchild, { reportSendError: vi.fn(), reportRuntimeError: vi.fn() });
				for (const [session, owner] of [
					[child, parent],
					[grandchild, child],
				]) {
					const read = session.getToolByName("read");
					if (!read) throw new Error("Missing restricted read tool");
					expect(session.sessionManager.getSessionId()).not.toBe(parent.sessionManager.getSessionId());
					await expect(read.execute("denied", { path: blocked })).rejects.toThrow(
						`Denied by ${session.getAgentId()}, child of ${owner.getAgentId()}`,
					);
					const result = await read.execute("allowed", { path: allowed });
					expect(result.content).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ type: "text", text: expect.stringContaining("allowed fixture") }),
						]),
					);
				}
			} finally {
				await grandchild.dispose();
			}
		});
	});

	test("ignores inherited extension tools and replacements, including late registration", async () => {
		const allowed = path.join(tempDir, "allowed.txt");
		await Bun.write(allowed, "built-in reader");
		await withRestrictedChild(
			pi => {
				const register = (name: string) =>
					pi.registerTool({
						name,
						label: name,
						description: "Must not replace or expand restricted tools",
						parameters: type({}),
						async execute() {
							throw new Error("Extension tool escaped the restriction");
						},
					});
				register("extra");
				register("read");
				pi.on("session_start", () => {
					register("late_extra");
					register("read");
				});
			},
			async child => {
				expect(child.getAllToolNames()).toEqual(["read"]);
				const read = child.getToolByName("read");
				if (!read) throw new Error("Missing restricted read tool");
				const result = await read.execute("allowed", { path: allowed });
				expect(result.content).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ type: "text", text: expect.stringContaining("built-in reader") }),
					]),
				);
			},
		);
	});

	test("fails closed when inherited tool policy throws, times out, or is cancelled", async () => {
		const blocked = path.join(tempDir, "blocked.txt");
		await Bun.write(blocked, "must not be read");
		settings.set("extensionHandlers.toolCallTimeoutMs", 25);
		await withRestrictedChild(
			pi => {
				pi.on("tool_call", event => {
					if (event.toolCallId === "throw") throw new Error("Policy failed");
					return Promise.withResolvers<undefined>().promise;
				});
			},
			async child => {
				const read = child.getToolByName("read");
				if (!read) throw new Error("Missing restricted read tool");
				await expect(read.execute("throw", { path: blocked })).rejects.toThrow("Policy failed");
				await expect(read.execute("timeout", { path: blocked })).rejects.toThrow("timed out");
				const controller = new AbortController();
				const cancelled = read.execute("cancel", { path: blocked }, controller.signal);
				queueMicrotask(() => controller.abort());
				await expect(cancelled).rejects.toThrow(/cancel|abort/i);
			},
		);
	});

	test("does not unregister the parent's provider when extension loading is restricted", async () => {
		const { session: parent } = await createAgentSession({
			...createOptions(),
			extensions: [providerExtension],
		});

		try {
			expect(parent.model?.provider).toBe(providerName);
			expect(modelRegistry.authStorage.keys.source(providerName) !== undefined).toBe(true);
			expect(getCustomApi(apiId)).toBeDefined();

			const { session: child } = await createAgentSession({
				...createOptions(),
				model: parent.model,
				restrictToolNames: true,
				preloadedPreparedExtensions: parent.preparedExtensions,
				toolNames: ["read"],
			});

			try {
				expect(child.model?.provider).toBe(providerName);
				expect(modelRegistry.find(providerName, modelId)).toBeDefined();
				expect(modelRegistry.authStorage.keys.source(providerName) !== undefined).toBe(true);
				expect(getCustomApi(apiId)).toBeDefined();
			} finally {
				await child.dispose();
			}
			// Provider registration rebound in the child must remain usable after disposal.
			providerRequests = 1;
			await parent.prompt("Use the registered provider.");
			expect(parent.messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "Commit proposal complete." }],
			});
		} finally {
			await parent.dispose();
		}
	});

	test("commit agent keeps the selected extension provider credential", async () => {
		await $`git init --initial-branch=main`.cwd(tempDir).quiet();
		vi.spyOn(commitTools, "createCommitTools").mockImplementation(options => [
			{
				name: "complete_commit",
				label: "Complete Commit",
				description: "Complete the commit proposal.",
				parameters: type({}),
				async execute() {
					options.state.proposal = {
						analysis: {
							type: "fix",
							scope: "commit",
							details: [],
							issueRefs: [],
						},
						summary: "fix(commit): retained extension provider",
						warnings: [],
					};
					return { content: [{ type: "text", text: "complete" }] };
				},
			},
		]);
		const { session: parent } = await createAgentSession({
			...createOptions(),
			extensions: [providerExtension],
		});

		try {
			const model = modelRegistry.find(providerName, modelId);
			if (!model) throw new Error("Expected extension model registration");

			const state = await runCommitAgentSession({
				cwd: tempDir,
				model,
				settings,
				modelRegistry,
				authStorage,
				sessionManager: SessionManager.inMemory(),
				changelogTargets: [],
				requireChangelog: false,
			});

			expect(providerRequests).toBe(2);
			expect(state.proposal?.summary).toBe("fix(commit): retained extension provider");
			expect(modelRegistry.authStorage.keys.source(providerName) !== undefined).toBe(true);
		} finally {
			await parent.dispose();
		}
	});
});
