import { afterAll, afterEach, beforeAll, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import * as classifier from "@oh-my-pi/pi-coding-agent/auto-prewalk/classifier";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { $which, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
const prewalkTarget = getBundledModel("anthropic", "claude-sonnet-4-6");
if (!primary || !prewalkTarget) throw new Error("Expected bundled prewalk models");

let tempDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
const sessions: AgentSession[] = [];

beforeAll(async () => {
	tempDir = TempDir.createSync("@pi-disposal-boundary-");
	await initTheme();
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
});

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	vi.restoreAllMocks();
});

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
});

async function createSession(
	options: {
		agent?: Agent;
		settings?: Settings;
		extensionRunner?: ExtensionRunner;
		toolRegistry?: Map<string, AgentTool>;
		sideStreamFn?: StreamFn;
	} = {},
): Promise<{ session: AgentSession; manager: SessionManager; agent: Agent; afterDisposal: string[] }> {
	const manager = SessionManager.inMemory(tempDir.path());
	const agent =
		options.agent ??
		new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["done"] }] }).stream,
		});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: options.settings ?? Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		extensionRunner: options.extensionRunner,
		toolRegistry: options.toolRegistry,
		sideStreamFn: options.sideStreamFn,
	});
	sessions.push(session);
	const afterDisposal: string[] = [];
	session.subscribe(event => {
		if (session.isDisposed) afterDisposal.push(event.type);
	});
	return { session, manager, agent, afterDisposal };
}

async function waitForFile(file: string): Promise<void> {
	await withTimeout(
		(async () => {
			while (!(await Bun.file(file).exists())) await Bun.sleep(10);
		})(),
		15_000,
		`Timed out waiting for ${file}`,
	);
}

test("beginDispose aborts an active user Bash and does not append its result", async () => {
	const { session, manager } = await createSession();
	const ready = path.join(tempDir.path(), "bash-ready");
	const release = path.join(tempDir.path(), "bash-release");
	const late = path.join(tempDir.path(), "bash-late");
	const command = `printf ready > '${ready}'; while [ ! -e '${release}' ]; do sleep 0.01; done; printf late > '${late}'; printf result`;

	const running = session.executeBash(command);
	await waitForFile(ready);
	const entriesBefore = manager.getEntries().length;
	session.beginDispose();
	// The command waits for `release`, so only the abort can end it. `release` is written after
	// the run settled: a shell still alive then would write `late`. Writing it before would race
	// the kill signal, and a busy machine could let the loop see it first.
	const result = await withTimeout(running, 15_000, "beginDispose did not end the running Bash");
	await Bun.write(release, "go");
	// A real shell process that no fake clock reaches: 200 ms is twenty of its 10 ms polls, so a
	// surviving loop would have written `late` by now.
	await Bun.sleep(200);

	expect(result.cancelled).toBe(true);
	expect(manager.getEntries().slice(entriesBefore)).toEqual([]);
	expect(await Bun.file(late).exists()).toBe(false);
}, 30_000);

test("beginDispose drops a Bash result already waiting for the active turn's persistence boundary", async () => {
	const providerEntered = Promise.withResolvers<void>();
	const mock = createMockModel({ responses: [{ content: ["held"], delayMs: 600_000 }] });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (requestModel, context, options) => {
			providerEntered.resolve();
			return mock.stream(requestModel, context, options);
		},
	});
	const { session, manager } = await createSession({ agent });
	const active = session.prompt("hold the agent turn").catch(() => undefined);
	await withTimeout(providerEntered.promise, 15_000, "Active provider request did not start");

	await session.executeBash("printf result");
	expect(session.hasPendingBashMessages).toBe(true);
	session.beginDispose();
	await session.flushToDisk();

	expect(session.hasPendingBashMessages).toBe(false);
	expect(manager.getEntries().some(entry => entry.type === "message" && entry.message.role === "bashExecution")).toBe(
		false,
	);
	await session.dispose();
	await active;
}, 30_000);

test("beginDispose stops a user_bash hook from launching its command after the hook resumes", async () => {
	const manager = SessionManager.inMemory(tempDir.path());
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("user_bash", async () => {
				started.resolve();
				await release.promise;
			});
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"begin-dispose-bash-hook",
	);
	const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), manager, modelRegistry);
	const { session } = await createSession({ extensionRunner });
	const late = path.join(tempDir.path(), "bash-hook-late");

	const running = session.executeBash(`printf late > '${late}'`, undefined, { useUserShell: true });
	await started.promise;
	session.beginDispose();
	release.resolve();
	const result = await running;

	expect(result.cancelled).toBe(true);
	expect(await Bun.file(late).exists()).toBe(false);
	expect(manager.getEntries()).toEqual([]);
}, 30_000);

test("beginDispose aborts an active user Python execution and does not append its result", async () => {
	const { session, manager } = await createSession({
		settings: Settings.isolated({
			"compaction.enabled": false,
			"python.kernelMode": "per-call",
			"python.interpreter": Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "",
		}),
	});
	const ready = path.join(tempDir.path(), "python-ready");
	const release = path.join(tempDir.path(), "python-release");
	const late = path.join(tempDir.path(), "python-late");
	const code = [
		"import pathlib, time",
		`pathlib.Path(${JSON.stringify(ready)}).write_text("ready")`,
		`while not pathlib.Path(${JSON.stringify(release)}).exists(): time.sleep(0.01)`,
		`pathlib.Path(${JSON.stringify(late)}).write_text("late")`,
		'print("python result")',
	].join("\n");

	const running = session.executePython(code);
	await waitForFile(ready);
	const entriesBefore = manager.getEntries().length;
	session.beginDispose();
	await Bun.write(release, "go");
	const result = await running;

	expect(result.cancelled).toBe(true);
	expect(manager.getEntries().slice(entriesBefore)).toEqual([]);
	expect(await Bun.file(late).exists()).toBe(false);
}, 30_000);

test("beginDispose prevents a deferred automatic prewalk restoration from switching models", async () => {
	vi.spyOn(classifier, "classifyAutoPrewalk").mockResolvedValue({
		route: "prewalk",
		probabilities: { prewalk: 0.9, primary: 0.07, direct: 0.03 },
		confidence: 0.9,
		arm: true,
	});
	const schema = type({});
	const written = path.join(tempDir.path(), "prewalk-written");
	const tool: AgentTool<typeof schema, undefined> = {
		name: "write",
		label: "Write",
		description: "Write a marker",
		parameters: schema,
		execute: async () => {
			await Bun.write(written, "written");
			return { content: [{ type: "text", text: "written" }], details: undefined };
		},
	};
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: primary, systemPrompt: ["Test"], tools: [tool as AgentTool], messages: [] },
		streamFn: createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "write-1", name: "write", arguments: {} }], stopReason: "toolUse" },
				{ content: ["done"] },
			],
		}).stream,
	});
	const settings = Settings.isolated({ "compaction.enabled": false, "prewalk.auto": "on", "prewalk.enabled": false });
	settings.setModelRole("smol", `${prewalkTarget.provider}/${prewalkTarget.id}`);
	const { session, manager, afterDisposal } = await createSession({
		agent,
		settings,
		toolRegistry: new Map([["write", tool as AgentTool]]),
	});
	await session.prompt("inspect then implement a change");
	expect(session.model?.id).toBe(prewalkTarget.id);
	expect(await Bun.file(written).text()).toBe("written");

	const refreshStarted = Promise.withResolvers<void>();
	const releaseRefresh = Promise.withResolvers<void>();
	const refresh = modelRegistry.refreshSelectedModelMetadata.bind(modelRegistry);
	vi.spyOn(modelRegistry, "refreshSelectedModelMetadata").mockImplementation(async model => {
		if (model.id === primary.id) {
			refreshStarted.resolve();
			await releaseRefresh.promise;
		}
		return await refresh(model);
	});
	const prompt = session.prompt("start a second task");
	await refreshStarted.promise;
	const entriesBefore = manager.getEntries().length;
	session.beginDispose();
	releaseRefresh.resolve();

	await expect(prompt).rejects.toMatchObject({ name: "PromptDroppedError", sessionDisposed: true });
	expect(session.model?.id).toBe(prewalkTarget.id);
	expect(manager.getEntries().slice(entriesBefore)).toEqual([]);
	expect(afterDisposal).not.toContain("model_changed");
}, 30_000);

test("beginDispose clears extension timers before wrapper teardown continues", async () => {
	vi.useFakeTimers();
	try {
		const manager = SessionManager.inMemory(tempDir.path());
		const runtime = new ExtensionRuntime();
		let fired = false;
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerCommand("arm-dispose-timer", {
					handler: async (_args, ctx) => {
						ctx.setTimeout(() => {
							fired = true;
							manager.appendCustomEntry("timer-after-dispose", { late: true });
						}, 10);
					},
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"begin-dispose-timer",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), manager, modelRegistry);
		const { session } = await createSession({ extensionRunner });

		expect(await session.prompt("/arm-dispose-timer")).toBe(false);
		session.beginDispose();
		vi.advanceTimersByTime(10);

		expect(fired).toBe(false);
		expect(manager.getEntries()).toEqual([]);
	} finally {
		vi.useRealTimers();
	}
}, 30_000);

test("beginDispose ends an ephemeral turn started while live before it sends a request", async () => {
	let requests = 0;
	const side = createMockModel({ responses: [{ content: ["a side answer sent after disposal"] }] });
	const { session } = await createSession({
		sideStreamFn: (requestModel, context, options) => {
			requests++;
			return side.stream(requestModel, context, options);
		},
	});

	const turn = session.runEphemeralTurn({ promptText: "a side question asked before disposal" });
	session.beginDispose();

	await expect(turn).rejects.toMatchObject({ name: "AbortError" });
	expect(requests).toBe(0);
}, 30_000);

test("beginDispose aborts the request of an ephemeral turn already in flight", async () => {
	const requested = Promise.withResolvers<AbortSignal | undefined>();
	const stream = new AssistantMessageEventStream();
	const { session } = await createSession({
		sideStreamFn: (_model, _context, options) => {
			requested.resolve(options?.signal);
			// No terminal event: a real transport ends on its signal; this one ends in `finally`.
			return stream;
		},
	});

	const turn = session.runEphemeralTurn({ promptText: "a side question in flight at disposal" });
	const settled = turn.then(
		() => "resolved",
		() => "rejected",
	);
	try {
		const providerSignal = await withTimeout(requested.promise, 15_000, "The side request did not start");
		expect(providerSignal?.aborted).toBe(false);
		session.beginDispose();

		expect(providerSignal?.aborted).toBe(true);
	} finally {
		stream.fail(new Error("side stream closed by the test"));
		await settled;
	}
}, 30_000);
