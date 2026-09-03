import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { AsyncJobRegisterOptions } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface CapturedJobRunContext {
	jobId: string;
	signal: AbortSignal;
	reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
}

type CapturedJobRun = (ctx: CapturedJobRunContext) => Promise<string>;

const model = { provider: "anthropic", id: "claude-sonnet-4-5" } as Model;

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

interface TanSessionEvent {
	type: string;
	result?: unknown;
	aborted?: boolean;
}

/** Minimal tan clone session stub covering the surface `TanCommandController` drives. */
function createCloneStub(overrides?: {
	prompt?: () => Promise<void>;
	abort?: () => void;
	sessionManager?: { appendSessionInit: (init: unknown) => void };
	lastAssistantText?: string;
	activeToolNames?: string[];
	enabledToolNames?: string[];
}) {
	const appendMessage = vi.fn();
	let listener: ((event: TanSessionEvent) => void) | undefined;
	const clone = {
		agent: { appendMessage },
		sessionManager: overrides?.sessionManager,
		setTodoPhases: vi.fn(),
		getActiveToolNames: vi.fn(() => overrides?.activeToolNames ?? ["read", "bash"]),
		getEnabledToolNames: vi.fn(() => overrides?.enabledToolNames ?? overrides?.activeToolNames ?? ["read", "bash"]),
		subscribe: vi.fn((l: (event: TanSessionEvent) => void) => {
			listener = l;
			return () => {
				listener = undefined;
			};
		}),
		prompt: vi.fn(overrides?.prompt ?? (async () => {})),
		waitForIdle: vi.fn(async () => {}),
		getLastAssistantMessage: vi.fn(() => assistantText(overrides?.lastAssistantText ?? "done")),
		abort: vi.fn(overrides?.abort ?? (() => {})),
		dispose: vi.fn(async () => {}),
	};
	return {
		clone,
		appendMessage,
		get compactionListener() {
			return listener;
		},
	};
}

function createContext(overrides?: {
	isStreaming?: boolean;
	model?: Model;
	agentId?: string;
	parentPromptCacheKey?: string;
	register?: (run: CapturedJobRun, options?: AsyncJobRegisterOptions) => string;
	activeToolNames?: string[];
	enabledToolNames?: string[];
	preparedExtensions?: unknown;
	effectiveExtensionRoots?: unknown;
	extensionPaths?: unknown;
}) {
	const tempDir = TempDir.createSync("@omp-tan-controller-");
	const parentFile = path.join(tempDir.path(), "parent.jsonl");
	// The clone nests inside the parent's artifact directory, like a subagent.
	const cloneFile = path.join(parentFile.slice(0, -6), "clone.jsonl");
	let capturedRun: CapturedJobRun | undefined;
	let capturedOptions: AsyncJobRegisterOptions | undefined;
	const sequence: string[] = [];
	const register = vi.fn(
		(_type: "bash" | "task", _label: string, run: CapturedJobRun, options?: AsyncJobRegisterOptions): string => {
			sequence.push("register");
			capturedRun = run;
			capturedOptions = options;
			return overrides?.register ? overrides.register(run, options) : "job-123";
		},
	);
	const session = {
		isStreaming: overrides?.isStreaming ?? false,
		agent: { promptCacheKey: overrides?.parentPromptCacheKey },
		model: overrides?.model ?? model,
		asyncJobManager: { register },
		sessionId: "parent-session",
		configuredThinkingLevel: vi.fn(() => undefined),
		systemPrompt: ["system prompt"],
		getActiveToolNames: vi.fn(() => overrides?.activeToolNames ?? ["read", "bash"]),
		getEnabledToolNames: vi.fn(() => overrides?.enabledToolNames ?? overrides?.activeToolNames ?? ["read", "bash"]),
		modelRegistry: { authStorage: { marker: "auth" } },
		preparedExtensions: overrides?.preparedExtensions,
		effectiveExtensionRoots: overrides?.effectiveExtensionRoots,
		extensionPaths: overrides?.extensionPaths,
		getAgentId: vi.fn(() => overrides?.agentId),
		sendCustomMessage: vi.fn(async () => {
			sequence.push("sendCustomMessage");
		}),
	} as unknown as InteractiveModeContext["session"];
	const parentArtifactsDir = parentFile.slice(0, -6);
	const getArtifactsDir = vi.fn(() => parentArtifactsDir);
	const getSessionId = vi.fn(() => "parent-local-session");
	const sessionManager = {
		getSessionFile: vi.fn(() => parentFile),
		getCwd: vi.fn(() => tempDir.path()),
		getSessionDir: vi.fn(() => tempDir.path()),
		getArtifactsDir,
		getSessionId,
		ensureOnDisk: vi.fn(async () => {}),
		flush: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext["sessionManager"];
	const cloneManager = {
		getSessionFile: vi.fn(() => cloneFile),
		appendCustomEntry: vi.fn(),
	} as unknown as SessionManager;
	const ctx = {
		session,
		sessionManager,
		settings: Settings.isolated({ "task.enableLsp": true }),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
	} as unknown as InteractiveModeContext;
	return {
		tempDir,
		parentFile,
		parentArtifactsDir,
		cloneFile,
		cloneManager,
		ctx,
		getArtifactsDir,
		getSessionId,
		register,
		sequence,
		get capturedRun() {
			return capturedRun;
		},
		get capturedOptions() {
			return capturedOptions;
		},
	};
}

describe("TanCommandController", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects empty work before forking", async () => {
		const harness = createContext();
		const forkSpy = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("   ");

		expect(forkSpy).not.toHaveBeenCalled();
		expect(harness.ctx.showStatus).toHaveBeenCalledWith("Usage: /tan <work>");
	});

	it("dispatches without disturbing an in-flight turn while streaming", async () => {
		const harness = createContext({ isStreaming: true });
		const forkSpy = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("check something");

		expect(forkSpy).toHaveBeenCalled();
		expect(harness.ctx.showWarning).not.toHaveBeenCalled();
		// The breadcrumb is queued for the next turn, not steered into the live one,
		// and the live chat is left to the streaming renderer (no synchronous rebuild).
		expect(harness.ctx.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "background-tan-dispatch" }),
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
		expect(harness.ctx.rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(harness.ctx.showStatus).toHaveBeenCalledWith("Dispatched background tan job-123");
	});

	it("forks with breadcrumb suppression, registers under Main, and dispatches after receiving the job id", async () => {
		const harness = createContext();
		const forkSpy = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("write the release note");

		expect(forkSpy).toHaveBeenCalledWith(
			harness.parentFile,
			harness.tempDir.path(),
			harness.parentFile.slice(0, -6),
			undefined,
			{
				copyArtifacts: false,
				suppressBreadcrumb: true,
				sessionFile: expect.stringMatching(/Tan-.+\.jsonl$/),
				resetInheritedCost: true,
			},
		);
		expect(harness.register).toHaveBeenCalledWith("task", "/tan write the release note", expect.any(Function), {
			ownerId: MAIN_AGENT_ID,
			agentId: expect.stringMatching(/^Tan-/) as unknown as string,
		});
		expect(harness.capturedOptions?.ownerId).toBe(MAIN_AGENT_ID);
		expect(harness.sequence).toEqual(["register", "sendCustomMessage"]);
		expect(harness.ctx.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "background-tan-dispatch",
				details: {
					jobId: "job-123",
					work: "write the release note",
					sessionFile: expect.stringMatching(/Tan-.+\.jsonl$/),
				},
			}),
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
		expect(harness.ctx.rebuildChatFromMessages).toHaveBeenCalled();
		expect(harness.ctx.showStatus).toHaveBeenCalledWith("Dispatched background tan job-123");
	});

	it("keeps the dispatching session's local:// root after the interactive session switches", async () => {
		const harness = createContext();
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const { clone } = createCloneStub({ lastAssistantText: "done" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: clone } as unknown as CreateAgentSessionResult;
		});
		const controller = new TanCommandController(harness.ctx);

		await controller.start("read local://paste-1.md");
		harness.getArtifactsDir.mockReturnValue(path.join(harness.tempDir.path(), "other-session"));
		harness.getSessionId.mockReturnValue("other-session");
		const capturedRun = harness.capturedRun;
		if (!capturedRun) throw new Error("run function was not captured");
		await capturedRun({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });

		const opts = capturedOptions?.localProtocolOptions;
		if (!opts) throw new Error("localProtocolOptions was not passed");
		expect(resolveLocalRoot(opts)).toBe(path.join(harness.parentArtifactsDir, "local"));
		// The local mapping keys off the session-manager id (not `session.sessionId`,
		// still "parent-session"), matching the parent's large-paste / local:// writes.
		expect(opts.getSessionId?.()).toBe("parent-local-session");
	});

	it("forwards the parent's prepared extensions and root policy so the tan child rebinds runtime providers", async () => {
		// Regression: the tan clone reuses the parent's shared ModelRegistry. If it
		// is built without the parent's extensions, the SDK's syncExtensionSources
		// prune unregisters extension-provided providers from that shared registry,
		// so the child fails its API-key check ("No API key found for <provider>")
		// and the parent loses the registration too. The child MUST rebind the
		// parent's prepared extensions before that prune runs.
		const preparedExtensions: PreparedExtension[] = [
			{ path: "/ext/provider.ts", resolvedPath: "/ext/provider.ts", factory: null, error: null },
		];
		const effectiveExtensionRoots: EffectiveExtensionRoots = {
			explicit: ["/ext/provider.ts"],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		};
		const extensionPaths = ["/ext/provider.ts"];
		const harness = createContext({ preparedExtensions, effectiveExtensionRoots, extensionPaths });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const { clone } = createCloneStub({ lastAssistantText: "done" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: clone } as unknown as CreateAgentSessionResult;
		});
		const controller = new TanCommandController(harness.ctx);

		await controller.start("chase the tangent");
		const capturedRun = harness.capturedRun;
		if (!capturedRun) throw new Error("run function was not captured");
		await capturedRun({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });

		expect(capturedOptions?.preloadedPreparedExtensions).toBe(preparedExtensions);
		// Path-list fallback is forwarded (fresh copy) for parent builds without prepared factories.
		expect(capturedOptions?.preloadedExtensionPaths).toEqual(extensionPaths);
		expect(capturedOptions?.extensionRoots?.()).toBe(effectiveExtensionRoots);
		expect(capturedOptions?.disableExtensionDiscovery).toBe(true);
	});

	it("collapses an empty prepared-extensions list to undefined so the child selects the path fallback", async () => {
		// `[]` is truthy: if forwarded verbatim the child would bind an empty
		// factory list and skip the populated path fallback, then prune the shared
		// registry from an empty source set — the exact failure the fix prevents.
		const effectiveExtensionRoots: EffectiveExtensionRoots = {
			explicit: ["/ext/provider.ts"],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		};
		const extensionPaths = ["/ext/provider.ts"];
		const harness = createContext({ preparedExtensions: [], effectiveExtensionRoots, extensionPaths });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const { clone } = createCloneStub({ lastAssistantText: "done" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: clone } as unknown as CreateAgentSessionResult;
		});
		const controller = new TanCommandController(harness.ctx);

		await controller.start("chase the tangent");
		const capturedRun = harness.capturedRun;
		if (!capturedRun) throw new Error("run function was not captured");
		await capturedRun({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });

		expect(capturedOptions?.preloadedPreparedExtensions).toBeUndefined();
		expect(capturedOptions?.preloadedExtensionPaths).toEqual(extensionPaths);
	});

	it("aborts the cloned agent when the background job signal aborts", async () => {
		const harness = createContext({ agentId: MAIN_AGENT_ID });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const promptStarted = Promise.withResolvers<void>();
		const abortObserved = Promise.withResolvers<void>();
		const { clone } = createCloneStub({
			prompt: async () => {
				promptStarted.resolve();
				await abortObserved.promise;
			},
			abort: () => {
				abortObserved.resolve();
			},
			lastAssistantText: "finished",
		});
		const createAgentSessionSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue({ session: clone } as unknown as CreateAgentSessionResult);
		const controller = new TanCommandController(harness.ctx);
		await controller.start("follow the tangent");
		const capturedRun = harness.capturedRun;
		expect(capturedRun).toBeDefined();
		if (!capturedRun) throw new Error("run function was not captured");
		const abortController = new AbortController();

		const resultPromise = capturedRun({
			jobId: "job-123",
			signal: abortController.signal,
			reportProgress: async () => {},
		});
		await promptStarted.promise;
		abortController.abort();
		const result = await resultPromise;

		expect(result).toBe("finished");
		expect(clone.abort).toHaveBeenCalled();
		expect(clone.dispose).toHaveBeenCalled();
		expect(createAgentSessionSpy.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				providerPromptCacheKey: "parent-session",
				parentTaskPrefix: expect.stringMatching(/^Tan-/) as unknown as string,
				agentDisplayName: "tan",
			}),
		);
	});

	it("parents the tan clone to the spawning agent, not to the clone itself", async () => {
		const harness = createContext({ agentId: "FocusedParent" });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const { clone } = createCloneStub();
		const createAgentSessionSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue({ session: clone } as unknown as CreateAgentSessionResult);
		const controller = new TanCommandController(harness.ctx);
		await controller.start("follow the tangent");
		const capturedRun = harness.capturedRun;
		if (!capturedRun) throw new Error("run function was not captured");
		await capturedRun({ jobId: "job-1", signal: new AbortController().signal, reportProgress: async () => {} });

		const opts = createAgentSessionSpy.mock.calls[0]?.[0];
		// The clone's registry parent is the spawning (focused) agent. Its own
		// `Tan-<id>` artifact prefix must never double as the parent link, or the
		// hub would render the tan parented to itself.
		expect(opts?.parentAgentId).toBe("FocusedParent");
		expect(opts?.parentTaskPrefix).toMatch(/^Tan-/);
		expect(opts?.parentTaskPrefix).not.toBe("FocusedParent");
	});

	it("pins the parent's effective cache key when the parent itself carries a pinned promptCacheKey", async () => {
		// A parent that is itself a fork/tan caches under `agent.promptCacheKey`,
		// not its own session id — the clone must read that exact shard.
		const harness = createContext({ parentPromptCacheKey: "grandparent-cache-key" });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const { clone } = createCloneStub();
		const createAgentSessionSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue({ session: clone } as unknown as CreateAgentSessionResult);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("follow the tangent");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		await run({ jobId: "job-1", signal: new AbortController().signal, reportProgress: async () => {} });

		const opts = createAgentSessionSpy.mock.calls[0]?.[0];
		expect(opts?.providerPromptCacheKey).toBe("grandparent-cache-key");
		expect(opts?.providerSessionId).toMatch(/^parent-session:tan:/);
	});

	it("parks the finished tan in the registry so it stays visible in the Agent Hub", async () => {
		const harness = createContext();
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const appendSessionInit = vi.fn();
		const { clone } = createCloneStub({ sessionManager: { appendSessionInit } });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: clone,
		} as unknown as CreateAgentSessionResult);
		const registry = AgentRegistry.global();
		const setStatus = vi.spyOn(registry, "setStatus");
		const detachSession = vi.spyOn(registry, "detachSession");
		const unregister = vi.spyOn(registry, "unregister");
		const controller = new TanCommandController(harness.ctx);

		await controller.start("park me");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		const result = await run({
			jobId: "job-123",
			signal: new AbortController().signal,
			reportProgress: async () => {},
		});

		expect(result).toBe("done");
		expect(appendSessionInit).toHaveBeenCalledWith({
			systemPrompt: "system prompt",
			task: "park me",
			tools: ["read", "bash"],
		});
		// Parked (not unregistered) before dispose, then the disposed session is nulled
		// out — the hub keeps the ref and reads its transcript from the session file.
		expect(setStatus).toHaveBeenCalledWith(expect.stringMatching(/^Tan-/), "parked");
		expect(detachSession).toHaveBeenCalledWith(expect.stringMatching(/^Tan-/));
		expect(clone.dispose).toHaveBeenCalled();
		expect(unregister).not.toHaveBeenCalled();
	});

	it("copies and persists the full enabled tool set", async () => {
		const enabledToolNames = ["eval", "read", "bash"];
		const harness = createContext({ activeToolNames: ["eval"], enabledToolNames });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const appendSessionInit = vi.fn();
		const { clone } = createCloneStub({
			sessionManager: { appendSessionInit },
			activeToolNames: ["eval"],
			enabledToolNames,
		});
		const createAgentSessionSpy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: clone,
		} as unknown as CreateAgentSessionResult);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("preserve bridge tools");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		await run({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });

		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.toolNames).toEqual(enabledToolNames);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: enabledToolNames }));
	});

	it("isolates the fork: clears inherited todos, injects the fork notice, and re-injects after compaction", async () => {
		const harness = createContext();
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const compacted = Promise.withResolvers<void>();
		const stub = createCloneStub({
			prompt: async () => {
				// Simulate the clone's history compacting mid-run: the summarizer
				// erases the fork notice, so the controller must append it again.
				stub.compactionListener?.({ type: "auto_compaction_end", result: {}, aborted: false });
				compacted.resolve();
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: stub.clone,
		} as unknown as CreateAgentSessionResult);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("follow the tangent");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		await run({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });
		await compacted.promise;

		// Inherited parent todos are wiped both in-memory and in the persisted
		// session so reloads agree; otherwise todo reminders drag the tan back
		// onto the parent's task.
		expect(stub.clone.setTodoPhases).toHaveBeenCalledWith([]);
		expect(harness.cloneManager.appendCustomEntry).toHaveBeenCalledWith("user_todo_edit", { phases: [] });
		// Fork notice injected before the prompt and again after compaction.
		expect(stub.appendMessage).toHaveBeenCalledTimes(2);
		for (const call of stub.appendMessage.mock.calls) {
			expect(call[0]).toEqual(
				expect.objectContaining({
					role: "developer",
					content: expect.stringContaining('<system-notice cause="fork">'),
				}),
			);
		}
		// The compaction listener is released once the tan finishes.
		expect(stub.compactionListener).toBeUndefined();
	});
});
