import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { createModelJobWidgetAuthor } from "@oh-my-pi/pi-coding-agent/job-widgets/author";
import {
	type Api,
	type AssistantMessage,
	clearCustomApis,
	type Model,
	type ModelSpec,
	registerCustomApi,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { runCli } from "@oh-my-pi/pi-coding-agent/cli";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { PRINT_MODE_COST_CAP_EXIT_CODE, runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	COST_GATE_NOTICE_SOURCE,
	CostCapError,
	CostGate,
	guardStreamFn,
} from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { wrapStreamFnWithProviderConcurrency } from "@oh-my-pi/pi-coding-agent/task/provider-concurrency";
import { cfgSessionMaxCost, cfgSessionWarnCost } from "@oh-my-pi/pi-coding-agent/session/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { rejectionOf } from "./helpers/rejection";

/** The test model's catalog fields, for registering it as a provider's model. */
const costModelSpec = {
	id: "cost-gate-model",
	name: "Cost Gate Model",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
};

/** A keyless model on a custom API, so the stubbed provider needs no credentials. */
function createCostModel(api: string): Model<Api> {
	return buildModel({
		...costModelSpec,
		api,
		provider: "llama.cpp",
		baseUrl: "http://127.0.0.1:8080/v1",
	} as ModelSpec<Api>) as Model<Api>;
}

/** A finished response costing `cost`; with `toolCall`, the loop has to send another request. */
function response(cost: number, toolCall = false): AssistantMessage {
	const message = createAssistantMessage(toolCall ? "" : "Answer");
	message.usage.cost.total = cost;
	if (toolCall) {
		message.content = [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }];
		message.stopReason = "toolUse";
	}
	return message;
}

function streamOf(message: AssistantMessage): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() =>
		stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }),
	);
	return stream;
}

describe("CostGate", () => {
	function gateWith(values: Record<string, unknown>, recordedSpend = 0) {
		const warnings: string[] = [];
		const settings = Settings.isolated(values);
		return { gate: new CostGate(settings, recordedSpend, message => warnings.push(message)), settings, warnings };
	}

	it("admits requests below session.maxCost and refuses them from the cap on", () => {
		const { gate } = gateWith({ "session.maxCost": 1 });
		gate.record(0.6);
		expect(gate.check()).toBeUndefined();
		gate.record(0.4);
		const refusal = gate.check();
		expect(refusal?.cap).toBe(1);
		expect(refusal?.spent).toBeCloseTo(1, 10);
		expect(refusal?.message).toContain("Cost cap reached");
		expect(refusal?.message).toContain("$1.00");
	});

	it("starts from the resumed session's recorded spend", () => {
		const { gate } = gateWith({ "session.maxCost": 1 }, 1.2);
		expect(gate.check()?.spent).toBe(1.2);
	});

	it("reads the cap on every check, so raising session.maxCost admits the next request", () => {
		const { gate, settings } = gateWith({ "session.maxCost": 1 }, 1.5);
		expect(gate.check()).toBeDefined();
		cfgSessionMaxCost.override(settings, 2);
		expect(gate.check()).toBeUndefined();
	});

	it("warns once, when spend first reaches session.warnCost", () => {
		const { gate, warnings } = gateWith({ "session.warnCost": 0.5 });
		gate.record(0.4);
		expect(warnings).toEqual([]);
		gate.record(0.2);
		gate.record(1);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("$0.60");
		expect(warnings[0]).toContain("$0.50");
	});

	it("does not warn again for a session resumed past its warning threshold", () => {
		const { gate, warnings } = gateWith({ "session.warnCost": 0.5 }, 0.7);
		gate.record(0.1);
		expect(warnings).toEqual([]);
	});

	it("ignores costs that are not positive numbers", () => {
		const { gate } = gateWith({ "session.maxCost": 1 });
		gate.record(Number.NaN);
		gate.record(-1);
		gate.record(0);
		expect(gate.spent).toBe(0);
	});

	it("guardStreamFn refuses at the cap without calling the provider and records each response", async () => {
		const { gate } = gateWith({ "session.maxCost": 1 });
		let calls = 0;
		const provider: StreamFn = () => {
			calls++;
			return streamOf(response(1.5));
		};
		const guarded = guardStreamFn(provider, () => gate);
		const model = createCostModel("test-cost-gate-guard");

		const stream = await guarded(model, { messages: [] });
		await stream.result();
		expect(gate.spent).toBe(1.5);

		const refused = await rejectionOf(Promise.resolve(guarded(model, { messages: [] })));
		expect(refused).toBeInstanceOf(CostCapError);
		expect(calls).toBe(1);
	});

	it("checks a request that waited for a provider slot when it goes out", async () => {
		const { gate, settings } = gateWith({ "session.maxCost": 1, "providers.ollama-cloud.maxConcurrency": 1 });
		const first = new AssistantMessageEventStream();
		let calls = 0;
		const provider: StreamFn = () => (++calls === 1 ? first : streamOf(response(0.1)));
		const send = wrapStreamFnWithProviderConcurrency(
			settings,
			guardStreamFn(provider, () => gate),
		);
		const model = { ...createCostModel("test-cost-gate-slot"), provider: "ollama-cloud" };

		await send(model, { messages: [] });
		const queued = rejectionOf(Promise.resolve(send(model, { messages: [] })));
		first.push({ type: "done", reason: "stop", message: response(1.2) });

		expect(await queued).toBeInstanceOf(CostCapError);
		expect(calls).toBe(1);
	});
});

describe("job widget authoring", () => {
	afterEach(() => vi.restoreAllMocks());

	it("counts the spec request against the cost cap and refuses at it", async () => {
		const model = createCostModel("test-cost-gate-widget");
		const billed = response(1.2);
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(billed);
		const settings = Settings.isolated({ "session.maxCost": 1 });
		settings.setModelRole("widget", "llama.cpp/cost-gate-model");
		const modelRegistry = {
			getAvailable: () => [model],
			find: () => model,
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as unknown as ModelRegistry;
		const costGate = new CostGate(settings, 0, () => {});
		const author = createModelJobWidgetAuthor({
			settings,
			modelRegistry,
			sessionId: () => "sess",
			costGate: () => costGate,
		});
		const request = { jobId: "job-1", brief: { kind: "bash" as const, command: "make" }, sources: [] };

		await author(request, new AbortController().signal).catch(() => undefined);
		expect(costGate.spent).toBe(1.2);
		expect(await rejectionOf(author(request, new AbortController().signal))).toBeInstanceOf(CostCapError);
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe("session.warnCost / session.maxCost settings", () => {
	it("reject a configured value that is not a positive USD amount", () => {
		for (const value of [-1, 0, Number.NaN, "5"]) {
			expect(() => Settings.isolated({ "session.maxCost": value })).toThrow("Invalid session.maxCost");
			expect(() => Settings.isolated({ "session.warnCost": value })).toThrow("Invalid session.warnCost");
		}
	});
});

describe("--warn-cost / --max-cost", () => {
	it("parse positive USD amounts", () => {
		const parsed = parseArgs(["--warn-cost", "8", "--max-cost", "0.0001", "--print", "hello"]);
		expect(parsed.warnCost).toBe(8);
		expect(parsed.maxCost).toBe(0.0001);
	});

	it("reject amounts that are not positive", () => {
		for (const value of ["-1", "0", "Infinity", "NaN", "abc", ""]) {
			expect(() => parseArgs(["--max-cost", value])).toThrow("Invalid --max-cost value");
		}
	});

	it("report an invalid amount as a usage error", async () => {
		const previousExitCode = process.exitCode;
		let observedExitCode: string | number | null | undefined;
		const captured: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		try {
			await runCli(["--warn-cost", "abc", "--print", "hello"]);
			observedExitCode = process.exitCode;
		} finally {
			vi.restoreAllMocks();
			process.exitCode = previousExitCode ?? 0;
		}
		expect(observedExitCode).toBe(2);
		expect(captured.join("")).toContain("Invalid --warn-cost value");
	});

	it("override the configured thresholds for the session", async () => {
		using tempDir = TempDir.createSync("@omp-cost-gate-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			"session.warnCost": 1,
			"session.maxCost": 2,
		});
		const argv = ["--warn-cost", "8", "--max-cost", "10", "--print", "hello"];
		const parsed = parseArgs(argv);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();
		let sessionSettings: Settings | undefined;
		try {
			await runRootCommand(parsed, argv, {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					sessionSettings = options?.settings;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") throw error;
		} finally {
			authStorage.close();
		}
		expect(sessionSettings && cfgSessionWarnCost.get(sessionSettings)).toBe(8);
		expect(sessionSettings && cfgSessionMaxCost.get(sessionSettings)).toBe(10);
	});
});

describe("cost gate in a running session", () => {
	const sessions: AgentSession[] = [];
	const tempDirs: TempDir[] = [];
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCustomApis();
		for (const session of sessions.splice(0)) await session.dispose();
		for (const storage of authStorages.splice(0)) storage.close();
		for (const dir of tempDirs.splice(0)) dir.removeSync();
	});

	/** Registers a provider that answers with `responses` in order and counts the requests it got. */
	function scriptedProvider(api: string, responses: AssistantMessage[]): { calls: () => number } {
		let calls = 0;
		registerCustomApi(api, () => streamOf(responses[Math.min(calls++, responses.length - 1)]));
		return { calls: () => calls };
	}

	async function createSession(
		api: string,
		values: Record<string, unknown>,
		extra: Partial<CreateAgentSessionOptions> = {},
	): Promise<AgentSession> {
		const tempDir = TempDir.createSync("@omp-cost-gate-session-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false, ...values }),
			model: createCostModel(api),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			...extra,
		});
		sessions.push(session);
		return session;
	}

	function costNotices(session: AgentSession): Extract<AgentSessionEvent, { type: "notice" }>[] {
		const notices: Extract<AgentSessionEvent, { type: "notice" }>[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === COST_GATE_NOTICE_SOURCE) notices.push(event);
		});
		return notices;
	}

	it("refuses the next request of a turn once a response reaches the cap", async () => {
		const api = "test-cost-gate-midturn";
		const provider = scriptedProvider(api, [response(1.5, true), response(0.1)]);
		const session = await createSession(api, { "session.maxCost": 1 });
		const notices = costNotices(session);

		await session.prompt("go");
		await session.waitForIdle();

		expect(provider.calls()).toBe(1);
		expect(session.costCapRefusal?.spent).toBe(1.5);
		expect(notices.map(notice => notice.level)).toEqual(["error"]);
		expect(notices[0]?.message).toContain("Cost cap reached");
	});

	it("warns once at session.warnCost and keeps sending requests", async () => {
		const api = "test-cost-gate-warn";
		const provider = scriptedProvider(api, [response(0.6, true), response(0.6, true), response(0.6)]);
		const session = await createSession(api, { "session.warnCost": 1 });
		const notices = costNotices(session);

		await session.prompt("go");
		await session.waitForIdle();

		expect(provider.calls()).toBe(3);
		expect(notices.map(notice => notice.level)).toEqual(["warning"]);
		expect(session.costCapRefusal).toBeUndefined();
	});

	it("counts a subagent's spend against the shared cap", async () => {
		const api = "test-cost-gate-child";
		const provider = scriptedProvider(api, [response(1.2)]);
		const parent = await createSession(api, { "session.maxCost": 1 });
		const child = await createSession(api, {}, { costGate: parent.costGate });

		await child.prompt("child work");
		await child.waitForIdle();
		await parent.prompt("parent work");
		await parent.waitForIdle();

		expect(provider.calls()).toBe(1);
		expect(parent.costCapRefusal?.spent).toBe(1.2);
	});

	it("hands a prompt back, unsent and unrecorded, when a resumed session is already past its cap", async () => {
		const api = "test-cost-gate-resume";
		const provider = scriptedProvider(api, [response(0.1)]);
		const tempDir = TempDir.createSync("@omp-cost-gate-resume-");
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		sessionManager.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() });
		sessionManager.appendMessage(response(2));
		const session = await createSession(api, { "session.maxCost": 1 }, { sessionManager });
		const dropped: { text: string; reason?: string }[] = [];
		session.setPromptDropped(prompt => dropped.push({ text: prompt.text, reason: prompt.reason }));

		await session.prompt("continue");
		await session.waitForIdle();

		expect(provider.calls()).toBe(0);
		expect(session.costCapRefusal?.spent).toBe(2);
		expect(dropped).toEqual([{ text: "continue", reason: session.costCapRefusal?.message }]);
		expect(sessionManager.getEntries().filter(entry => entry.type === "message")).toHaveLength(2);
	});

	it("applies a cap set while the session is open", async () => {
		const api = "test-cost-gate-enable";
		const provider = scriptedProvider(api, [response(1.2)]);
		const session = await createSession(api, {});

		await session.prompt("first");
		await session.waitForIdle();
		cfgSessionMaxCost.override(session.settings, 1);
		await session.prompt("second");
		await session.waitForIdle();

		expect(provider.calls()).toBe(1);
		expect(session.costCapRefusal?.spent).toBe(1.2);
	});

	it("sends no title request once the session is at its cap", async () => {
		const api = "test-cost-gate-title";
		const provider = scriptedProvider(api, [response(1.2)]);
		const session = await createSession(api, {
			"session.maxCost": 1,
			"modelRoles.tiny": "llama.cpp/cost-gate-model",
		});
		session.modelRegistry.registerProvider("llama.cpp", {
			api,
			baseUrl: "http://127.0.0.1:8080/v1",
			apiKey: "test-key",
			models: [costModelSpec],
		});

		await session.prompt("first");
		await session.waitForIdle();
		const title = await session.generateTitle("Implement a native cost gate for this command line tool");

		expect(title).toBeNull();
		expect(provider.calls()).toBe(1);
	});

	it("keeps the spent budget when the session is forked from an earlier message", async () => {
		const api = "test-cost-gate-fork";
		const provider = scriptedProvider(api, [response(1.2), response(0.1)]);
		const tempDir = TempDir.createSync("@omp-cost-gate-fork-");
		tempDirs.push(tempDir);
		const session = await createSession(
			api,
			{ "session.maxCost": 1 },
			{ sessionManager: SessionManager.create(tempDir.path(), tempDir.path()) },
		);

		await session.prompt("first");
		await session.waitForIdle();
		// Forking from the first message leaves the paid response out of the new file.
		const firstMessage = session.sessionManager.getEntries().find(entry => entry.type === "message");
		expect(firstMessage && (await session.fork(firstMessage.id))).toBe(true);
		await session.prompt("after fork");
		await session.waitForIdle();

		expect(provider.calls()).toBe(1);
		expect(session.costCapRefusal?.spent).toBe(1.2);
	});

	it("gives a new session a fresh budget", async () => {
		const api = "test-cost-gate-new-session";
		const provider = scriptedProvider(api, [response(1.2), response(0.1)]);
		const session = await createSession(api, { "session.maxCost": 1 });

		await session.prompt("first");
		await session.waitForIdle();
		expect(await session.newSession()).toBe(true);
		await session.prompt("new work");
		await session.waitForIdle();

		expect(provider.calls()).toBe(2);
		expect(session.costGate.spent).toBe(0.1);
	});

	it("starts a resumed session from its recorded spend when switching to it", async () => {
		const api = "test-cost-gate-switch";
		const provider = scriptedProvider(api, [response(0.1)]);
		const tempDir = TempDir.createSync("@omp-cost-gate-switch-");
		tempDirs.push(tempDir);
		const saved = SessionManager.create(tempDir.path(), tempDir.path());
		saved.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() });
		saved.appendMessage({ ...response(2), api, provider: "llama.cpp", model: "cost-gate-model" });
		await saved.flush();
		const savedFile = saved.getSessionFile();
		await saved.close();
		const session = await createSession(
			api,
			{ "session.maxCost": 1 },
			{ sessionManager: SessionManager.create(tempDir.path(), tempDir.path()) },
		);
		session.modelRegistry.registerProvider("llama.cpp", {
			api,
			baseUrl: "http://127.0.0.1:8080/v1",
			apiKey: "test-key",
			models: [costModelSpec],
		});

		expect(savedFile && (await session.switchSession(savedFile))).toBe(true);
		await session.prompt("continue");
		await session.waitForIdle();

		expect(provider.calls()).toBe(0);
		expect(session.costCapRefusal?.spent).toBe(2);
	});

	describe("print mode", () => {
		function captureOutput(): { stdout: string[]; stderr: string[] } {
			const stdout: string[] = [];
			const stderr: string[] = [];
			vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
				stdout.push(String(args[0]));
				const cb = args[args.length - 1];
				if (typeof cb === "function") (cb as (err?: Error | null) => void)(null);
				return true;
			});
			vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
				stderr.push(String(chunk));
				return true;
			});
			return { stdout, stderr };
		}

		it("exits with the cost-cap status and reports the refusal on stderr", async () => {
			const api = "test-cost-gate-print";
			scriptedProvider(api, [response(1.5, true), response(0.1)]);
			const session = await createSession(api, { "session.maxCost": 1 });
			const output = captureOutput();

			const exitCode = await runPrintMode(session, { mode: "text", initialMessage: "go" });

			expect(exitCode).toBe(PRINT_MODE_COST_CAP_EXIT_CODE);
			expect(output.stderr.join("")).toContain("Cost cap reached");
			expect(output.stdout.join("")).toBe("");
		});

		it("emits the refusal as a cost-gate notice in JSON mode", async () => {
			const api = "test-cost-gate-print-json";
			scriptedProvider(api, [response(1.5, true), response(0.1)]);
			const session = await createSession(api, { "session.maxCost": 1 });
			const output = captureOutput();

			const exitCode = await runPrintMode(session, { mode: "json", initialMessage: "go" });

			expect(exitCode).toBe(PRINT_MODE_COST_CAP_EXIT_CODE);
			const notices = output.stdout
				.flatMap(line => line.split("\n"))
				.filter(line => line.startsWith("{"))
				.map(line => JSON.parse(line) as { type: string; source?: string; level?: string })
				.filter(event => event.type === "notice" && event.source === COST_GATE_NOTICE_SOURCE);
			expect(notices.map(notice => notice.level)).toEqual(["error"]);
		});

		it("exits 0 when the run stays under the cap", async () => {
			const api = "test-cost-gate-print-ok";
			scriptedProvider(api, [response(0.1)]);
			const session = await createSession(api, { "session.maxCost": 1 });
			const output = captureOutput();

			const exitCode = await runPrintMode(session, { mode: "text", initialMessage: "go" });

			expect(exitCode).toBe(0);
			expect(output.stdout.join("")).toContain("Answer");
		});

		it("exits 0 for a run after the cap was raised, though an earlier run was capped", async () => {
			const api = "test-cost-gate-print-recover";
			scriptedProvider(api, [response(1.2, true), response(0.1)]);
			const session = await createSession(api, { "session.maxCost": 1 });
			const output = captureOutput();

			expect(await runPrintMode(session, { mode: "text", initialMessage: "first" })).toBe(
				PRINT_MODE_COST_CAP_EXIT_CODE,
			);
			cfgSessionMaxCost.override(session.settings, 10);
			expect(await runPrintMode(session, { mode: "text", initialMessage: "second" })).toBe(0);
			expect(output.stdout.join("")).toContain("Answer");
		});

		it("reports a refusal that lands between the loop's check and the dispatch as the cost cap", async () => {
			const api = "test-cost-gate-print-race";
			const provider = scriptedProvider(api, [response(1.2)]);
			let dispatches = 0;
			const session = await createSession(
				api,
				{ "session.maxCost": 1 },
				{ onFirstChatDispatch: () => dispatches++ },
			);
			// A side request finishes after the loop's own cap check passed.
			let sideSent = false;
			session.agent.addBeforeModelCall(async () => {
				if (sideSent) return;
				sideSent = true;
				await session.runEphemeralTurn({ promptText: "side work" });
			});
			const output = captureOutput();

			const exitCode = await runPrintMode(session, { mode: "text", initialMessage: "main work" });

			expect(provider.calls()).toBe(1);
			expect(exitCode).toBe(PRINT_MODE_COST_CAP_EXIT_CODE);
			expect(dispatches).toBe(0);
			expect(output.stderr.join("")).toContain("Cost cap reached");
		});
	});
});
