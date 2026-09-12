/**
 * Tests that a `tool_call` event reports the calling session's identity through
 * the real session dispatch path. Extensions need this to scope policy to the
 * top-level agent without also constraining the subagents it delegates to —
 * blocking a tool on an undifferentiated event blocks both.
 *
 * These drive `AgentSession` via `createAgentSession` rather than invoking the
 * tool wrapper directly: for a model-dispatched call `#beforeToolCall` marks the
 * event as already emitted and the wrapper suppresses its own, so the session
 * path is the only one that runs in practice.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { type Api, clearCustomApis, type Model, type ModelSpec, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

interface ObservedIdentity {
	agentKind?: "main" | "sub";
	taskDepth?: number;
}

describe("tool_call session identity", () => {
	afterEach(() => {
		clearCustomApis();
	});

	/** Model that dispatches one `read` call, then finishes. */
	function registerToolCallingApi(api: string): void {
		let requests = 0;
		registerCustomApi(api, () => {
			requests++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (requests === 1) {
					const message = createAssistantMessage("");
					const toolCall = {
						type: "toolCall",
						id: "call-identity-1",
						name: "read",
						arguments: { path: "identity.txt" },
					} as const;
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall as never, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage("done");
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			return stream;
		});
	}

	function buildStubModel(api: string, id: string): Model<Api> {
		return buildModel({
			id,
			name: id,
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
	}

	/**
	 * Runs one model-dispatched tool call in a session at `taskDepth`, returning
	 * the identity fields the `tool_call` handler observed. `undefined` omits the
	 * option entirely, exercising the default top-level case.
	 */
	async function observeIdentity(taskDepth: number | undefined): Promise<ObservedIdentity[]> {
		using tempDir = TempDir.createSync("@pi-tool-call-identity-");
		const api = `test-identity-${taskDepth ?? "default"}`;
		registerToolCallingApi(api);
		const observed: ObservedIdentity[] = [];
		const recordIdentity: ExtensionFactory = pi => {
			pi.on("tool_call", async event => {
				observed.push({ agentKind: event.agentKind, taskDepth: event.taskDepth });
				return undefined;
			});
		};
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildStubModel(api, `identity-model-${taskDepth ?? "default"}`),
			disableExtensionDiscovery: true,
			extensions: [recordIdentity],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read"],
			...(taskDepth === undefined ? {} : { taskDepth }),
		});
		try {
			await session.sendUserMessage("read it");
			return observed;
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}

	it("reports main and depth 0 for a top-level session", async () => {
		expect(await observeIdentity(undefined)).toEqual([{ agentKind: "main", taskDepth: 0 }]);
	});

	it("reports sub and the child depth for a delegated session", async () => {
		expect(await observeIdentity(1)).toEqual([{ agentKind: "sub", taskDepth: 1 }]);
	});

	it("distinguishes a nested subagent from a first-level one", async () => {
		// `agentKind` collapses every subagent to "sub"; depth is what separates a
		// nested agent from a first-level one, so it must survive the real path.
		expect(await observeIdentity(2)).toEqual([{ agentKind: "sub", taskDepth: 2 }]);
	});
});
