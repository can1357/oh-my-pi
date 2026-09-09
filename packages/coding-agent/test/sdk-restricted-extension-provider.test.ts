import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
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
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
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

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-restricted-provider-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		settings = Settings.isolated();
		settings.setModelRole("default", `${providerName}/${modelId}`);
		providerRequests = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		modelRegistry.clearSourceRegistrations(sourceId);
		authStorage.close();
		removeSyncWithRetries(tempDir);
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

	test("does not unregister the parent's provider when extension loading is restricted", async () => {
		const { session: parent } = await createAgentSession({
			...createOptions(),
			extensions: [providerExtension],
		});

		try {
			expect(parent.model?.provider).toBe(providerName);
			expect(modelRegistry.authStorage.hasAuth(providerName)).toBe(true);
			expect(getCustomApi(apiId)).toBeDefined();

			const { session: child } = await createAgentSession({
				...createOptions(),
				model: parent.model,
				restrictToolNames: true,
				toolNames: ["read"],
			});

			try {
				expect(child.model?.provider).toBe(providerName);
				expect(modelRegistry.find(providerName, modelId)).toBeDefined();
				expect(modelRegistry.authStorage.hasAuth(providerName)).toBe(true);
				expect(getCustomApi(apiId)).toBeDefined();
			} finally {
				await child.dispose();
			}
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
				changelogTargets: [],
				requireChangelog: false,
			});

			expect(providerRequests).toBe(2);
			expect(state.proposal?.summary).toBe("fix(commit): retained extension provider");
			expect(modelRegistry.authStorage.hasAuth(providerName)).toBe(true);
		} finally {
			await parent.dispose();
		}
	});
});
