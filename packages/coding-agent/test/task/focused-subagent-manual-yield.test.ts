/**
 * Kept-alive subagent turns publish consumed parent follow-ups from focused,
 * peer-woken, queued and async continuations without adopting peer-only replies.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import { AgentBusyError, type AgentMessage, type AgentPromptOptions } from "@oh-my-pi/pi-agent-core";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { scheduler, setImmediate } from "node:timers/promises";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import * as artifacts from "@oh-my-pi/pi-coding-agent/session/artifacts";
import type { DrivenTurnLease } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { IrcBridge } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import { hasRestorableTurn } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir, untilAborted } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";

const AGENT_ID = "FocusedYield";
const PARENT_ID = "Main";
const MOCK_API_SOURCE = "test/focused-subagent-manual-yield";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let manager: AsyncJobManager;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-focused-yield-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	manager = new AsyncJobManager({ maxRunningJobs: 4 });
	AsyncJobManager.setInstance(manager);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AsyncJobManager.setInstance(undefined);
	await manager.dispose({ timeoutMs: 1_000 });
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	// The subagent session opened agent.db and models.db under root; Windows cannot delete open files.
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

/** Result each typed prompt asks for; the spawn task and any non-user turn yield `initial result`. */
const PROMPT_RESULTS: Record<string, string> = { "go on": "manual result", "finish up": "final result" };

/** The yield data for the newest typed (user-role) prompt the mock model sees. */
function resultForLatestPrompt(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content
							.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
							.join("")
					: "";
		for (const prompt in PROMPT_RESULTS) {
			if (text.includes(prompt)) return PROMPT_RESULTS[prompt];
		}
	}
	return "initial result";
}

/** Starts an idle child with an accepted result and records subsequent parent deliveries. */
async function spawnKeptAliveChild(options?: {
	handler?: MockHandler;
	structured?: boolean;
	enableIrc?: boolean;
	tools?: string[];
}) {
	// Under the isolated HOME: project discovery walks up from cwd and stops at os.homedir(). On Windows
	// os.tmpdir() lives under the real home, so a cwd outside the fake HOME would walk into the real
	// ~/.omp and load the developer's installed plugins as project plugins.
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
	const mock = createMockModel({
		handler:
			options?.handler ??
			(context => {
				if (!(context.tools ?? []).some(tool => tool.name === "yield")) return { content: ["label"] };
				// A turn that already yielded ends on the tool result; answer it with prose.
				if (context.messages.at(-1)?.role === "toolResult") return { content: ["ok"] };
				const data = resultForLatestPrompt(context.messages);
				return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data } }] };
			}),
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);

	const deliveries: string[] = [];
	const firstDelivery = Promise.withResolvers<string>();
	const unregisterSink = manager.registerDeliverySink(PARENT_ID, (_jobId, text) => {
		deliveries.push(text);
		firstDelivery.resolve(text);
	});
	const close = (): void => {
		unregisterSink();
		authStorage.close();
	};
	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: {
				name: "task",
				description: "test",
				systemPrompt: "test",
				tools: options?.tools ?? ["read"],
				source: "bundled",
			},
			task: "report",
			index: 0,
			id: AGENT_ID,
			parentAgentId: PARENT_ID,
			asyncJobManager: manager,
			structured: options?.structured,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings,
			enableLsp: false,
			enableMCP: false,
			enableIrc: options?.enableIrc ?? false,
		});
		expect(result.exitCode).toBe(0);
	} catch (error) {
		close();
		throw error;
	}
	const artifact = path.join(artifactsDir, `${AGENT_ID}.md`);
	if (options?.structured === false) expect(await Bun.file(artifact).text()).toContain("INITIAL_FINAL");
	else expect(await Bun.file(artifact).text()).toContain("initial result");
	const session = AgentRegistry.global().get(AGENT_ID)?.session;
	if (!session) {
		close();
		throw new Error("kept-alive subagent has no live session");
	}
	return {
		cwd,
		authStorage,
		settings,
		session: localSession(session),
		artifact,
		artifactsDir,
		deliveries,
		firstDelivery: firstDelivery.promise,
		close,
		mock,
		modelRegistry,
	};
}

it("finishes an admitted focused prompt before driving a follow-up", async () => {
	const loaderEntered = Promise.withResolvers<void>();
	const releaseLoader = Promise.withResolvers<void>();
	const monitorAttached = Promise.withResolvers<void>();
	const admissionWait = Promise.withResolvers<void>();
	const inputs: string[] = [];
	const child = await spawnKeptAliveChild({
		structured: false,
		handler: context => {
			const input = JSON.stringify(context.messages.at(-1));
			inputs.push(input);
			return {
				content: [
					input.includes("go on")
						? "FOCUSED_FINAL"
						: input.includes("report again")
							? "DRIVEN_FINAL"
							: "INITIAL_FINAL",
				],
			};
		},
	});
	let focused: Promise<boolean> | undefined;
	let driven: Promise<SingleResult> | undefined;
	const subscribe = child.session.subscribe.bind(child.session);
	vi.spyOn(child.session, "subscribe").mockImplementation(listener => {
		const unsubscribe = subscribe(listener);
		monitorAttached.resolve();
		return unsubscribe;
	});
	const waitForAdmitted = child.session.waitForAdmittedSubmissions.bind(child.session);
	vi.spyOn(child.session, "waitForAdmittedSubmissions").mockImplementation((...args) => {
		const waiting = waitForAdmitted(...args);
		admissionWait.resolve();
		return waiting;
	});
	try {
		child.session.setDeferredExtensionLoader(async () => {
			loaderEntered.resolve();
			await releaseLoader.promise;
		});
		focused = child.session.prompt("go on");
		await loaderEntered.promise;
		expect(child.session.hasAdmittedSubmission).toBe(true);
		driven = runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			message: "report again",
			structured: false,
			artifactsDir: child.artifactsDir,
		});
		await Promise.race([monitorAttached.promise, admissionWait.promise]);
		releaseLoader.resolve();
		await focused;
		const result = await driven;
		await manager.waitForOwnerJobs(PARENT_ID);
		await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
		expect(inputs.findIndex(input => input.includes("go on"))).toBeLessThan(
			inputs.findIndex(input => input.includes("report again")),
		);
		expect(child.deliveries.filter(text => text.includes("FOCUSED_FINAL"))).toHaveLength(1);
		expect(child.deliveries.filter(text => text.includes("FOCUSED_FINAL"))[0]).not.toContain("DRIVEN_FINAL");
		expect(result.output).toBe("DRIVEN_FINAL");
		expect(await Bun.file(child.artifact).text()).toContain("DRIVEN_FINAL");
	} finally {
		releaseLoader.resolve();
		await Promise.allSettled([focused, driven].filter(promise => promise !== undefined));
		child.close();
	}
}, 20_000);

it("waits for autonomous artifact finalization before attaching a driven monitor", async () => {
	const artifactEntered = Promise.withResolvers<void>();
	const releaseArtifact = Promise.withResolvers<void>();
	const focusedArtifactReady = Promise.withResolvers<void>();
	void focusedArtifactReady.promise.catch(() => {});
	const availabilityEntered = Promise.withResolvers<"waiting">();
	const drivenEntered = Promise.withResolvers<"provider">();
	let focusedArtifact = "";
	const child = await spawnKeptAliveChild({
		structured: false,
		handler: context => {
			const input = JSON.stringify(context.messages.at(-1));
			if (input.includes("report again")) {
				drivenEntered.resolve("provider");
				return { content: ["DRIVEN_FINAL"] };
			}
			return { content: [input.includes("go on") ? "FOCUSED_FINAL" : "INITIAL_FINAL"] };
		},
	});
	let focused: Promise<boolean> | undefined;
	let driven: Promise<SingleResult> | undefined;
	const writeArtifact = artifacts.writeArtifact;
	const waitForAvailability = child.session.waitForDrivenTurnAvailability.bind(child.session);
	vi.spyOn(artifacts, "writeArtifact").mockImplementation(async (file, content) => {
		if (file === child.artifact && content.includes("FOCUSED_FINAL")) {
			artifactEntered.resolve();
			await releaseArtifact.promise;
			try {
				const bytes = await writeArtifact(file, content);
				focusedArtifact = await Bun.file(file).text();
				focusedArtifactReady.resolve();
				return bytes;
			} catch (error) {
				focusedArtifactReady.reject(error);
				throw error;
			}
		}
		return writeArtifact(file, content);
	});
	vi.spyOn(child.session, "waitForDrivenTurnAvailability").mockImplementation(() => {
		const waiting = waitForAvailability();
		availabilityEntered.resolve("waiting");
		return waiting;
	});
	try {
		focused = child.session.prompt("go on");
		await artifactEntered.promise;
		driven = runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			message: "report again",
			structured: false,
			artifactsDir: child.artifactsDir,
		});
		expect(await Promise.race([availabilityEntered.promise, drivenEntered.promise])).toBe("waiting");
		releaseArtifact.resolve();
		await focused;
		await focusedArtifactReady.promise;
		expect(focusedArtifact).toContain("FOCUSED_FINAL");
		expect(await child.firstDelivery).toContain("FOCUSED_FINAL");
		const result = await driven;
		await manager.waitForOwnerJobs(PARENT_ID);
		await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
		expect(child.deliveries.filter(text => text.includes("FOCUSED_FINAL"))).toHaveLength(1);
		expect(result.output).toBe("DRIVEN_FINAL");
		expect(await Bun.file(child.artifact).text()).toContain("DRIVEN_FINAL");
	} finally {
		releaseArtifact.resolve();
		await Promise.allSettled([focused, driven].filter(promise => promise !== undefined));
		child.close();
	}
}, 20_000);

it("does not replay an admitted assignment when engine dispatch loses a busy race", async () => {
	const keyEntered = Promise.withResolvers<void>();
	const releaseKey = Promise.withResolvers<void>();
	const winnerEntered = Promise.withResolvers<void>();
	const releaseWinner = Promise.withResolvers<void>();
	const busyObserved = Promise.withResolvers<void>();
	let admissions = 0;
	const child = await spawnKeptAliveChild({
		structured: false,
		handler: async context => {
			const input = JSON.stringify(context.messages.at(-1));
			if (input.includes("engine winner")) {
				winnerEntered.resolve();
				await releaseWinner.promise;
				return { content: ["ENGINE_WINNER"] };
			}
			return { content: [input.includes("report again") ? "DRIVEN_FINAL" : "INITIAL_FINAL"] };
		},
	});
	let driven: Promise<SingleResult> | undefined;
	let winner: Promise<void> | undefined;
	try {
		const getApiKey = child.modelRegistry.getApiKey.bind(child.modelRegistry);
		let holdKey = true;
		vi.spyOn(child.modelRegistry, "getApiKey").mockImplementation(async (...args) => {
			const key = await getApiKey(...args);
			if (holdKey) {
				holdKey = false;
				keyEntered.resolve();
				await releaseKey.promise;
			}
			return key;
		});
		const prompt = child.session.prompt.bind(child.session);
		vi.spyOn(child.session, "prompt").mockImplementation((text, options) =>
			prompt(
				text,
				text === "report again"
					? {
							...options,
							onPromptAdmitted: () => {
								admissions++;
								options?.onPromptAdmitted?.();
							},
						}
					: options,
			),
		);
		const enginePrompt = child.session.agent.prompt.bind(child.session.agent);
		vi.spyOn(child.session.agent, "prompt").mockImplementation(
			async (
				input: string | AgentMessage | AgentMessage[],
				imagesOrOptions?: ImageContent[] | AgentPromptOptions,
				options?: AgentPromptOptions,
			) => {
				try {
					await Reflect.apply(enginePrompt, child.session.agent, [input, imagesOrOptions, options]);
				} catch (error) {
					if (error instanceof AgentBusyError) busyObserved.resolve();
					throw error;
				}
			},
		);
		driven = runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			message: "report again",
			structured: false,
			artifactsDir: child.artifactsDir,
		});
		await keyEntered.promise;
		expect(admissions).toBe(1);
		winner = child.session.agent.prompt("engine winner");
		await winnerEntered.promise;
		releaseKey.resolve();
		await busyObserved.promise;
		releaseWinner.resolve();
		await winner;
		const result = await driven;
		expect(admissions).toBe(1);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Agent is already processing");
		expect(result.output).not.toContain("ENGINE_WINNER");
		expect(
			child.mock.calls.filter(call => JSON.stringify(call.context.messages.at(-1)).includes("report again")),
		).toHaveLength(0);
	} finally {
		releaseKey.resolve();
		releaseWinner.resolve();
		await Promise.allSettled([driven, winner].filter(promise => promise !== undefined));
		child.close();
	}
}, 20_000);

it("retries an independent admitted prompt after a competing engine turn", async () => {
	const keyEntered = Promise.withResolvers<void>();
	const releaseKey = Promise.withResolvers<void>();
	const winnerEntered = Promise.withResolvers<void>();
	const releaseWinner = Promise.withResolvers<void>();
	const busyObserved = Promise.withResolvers<void>();
	let admissions = 0;
	const child = await spawnKeptAliveChild({
		structured: false,
		handler: async context => {
			const input = JSON.stringify(context.messages.at(-1));
			if (input.includes("engine winner")) {
				winnerEntered.resolve();
				await releaseWinner.promise;
				return { content: ["ENGINE_WINNER"] };
			}
			return { content: [input.includes("ordinary prompt") ? "ORDINARY_FINAL" : "INITIAL_FINAL"] };
		},
	});
	let ordinary: Promise<boolean> | undefined;
	let winner: Promise<void> | undefined;
	try {
		const getApiKey = child.modelRegistry.getApiKey.bind(child.modelRegistry);
		let holdKey = true;
		vi.spyOn(child.modelRegistry, "getApiKey").mockImplementation(async (...args) => {
			const key = await getApiKey(...args);
			if (holdKey) {
				holdKey = false;
				keyEntered.resolve();
				await releaseKey.promise;
			}
			return key;
		});
		const enginePrompt = child.session.agent.prompt.bind(child.session.agent);
		vi.spyOn(child.session.agent, "prompt").mockImplementation(
			async (
				input: string | AgentMessage | AgentMessage[],
				imagesOrOptions?: ImageContent[] | AgentPromptOptions,
				options?: AgentPromptOptions,
			) => {
				try {
					await Reflect.apply(enginePrompt, child.session.agent, [input, imagesOrOptions, options]);
				} catch (error) {
					if (error instanceof AgentBusyError) busyObserved.resolve();
					throw error;
				}
			},
		);
		ordinary = child.session.prompt("ordinary prompt", {
			onPromptAdmitted: () => {
				admissions++;
			},
		});
		await keyEntered.promise;
		expect(admissions).toBe(1);
		winner = child.session.agent.prompt("engine winner");
		await winnerEntered.promise;
		releaseKey.resolve();
		await busyObserved.promise;
		releaseWinner.resolve();
		await winner;
		expect(await ordinary).toBe(true);
		await child.session.waitForIdle();
		expect(admissions).toBe(1);
		expect(
			child.mock.calls.filter(call => JSON.stringify(call.context.messages.at(-1)).includes("ordinary prompt")),
		).toHaveLength(1);
		expect(JSON.stringify(child.session.getLastAssistantMessage()?.content)).toContain("ORDINARY_FINAL");
	} finally {
		releaseKey.resolve();
		releaseWinner.resolve();
		await Promise.allSettled([ordinary, winner].filter(promise => promise !== undefined));
		child.close();
	}
}, 20_000);

it("restarts only after an engine turn wins before the driven assignment is admitted", async () => {
	const installEntered = Promise.withResolvers<void>();
	const releaseInstall = Promise.withResolvers<void>();
	const winnerEntered = Promise.withResolvers<void>();
	const releaseWinner = Promise.withResolvers<void>();
	const rejectedBeforeAdmission = Promise.withResolvers<void>();
	const order: string[] = [];
	let admissions = 0;
	const child = await spawnKeptAliveChild({
		structured: false,
		handler: async context => {
			const input = JSON.stringify(context.messages.at(-1));
			if (input.includes("engine winner")) {
				order.push("winner entered");
				winnerEntered.resolve();
				await releaseWinner.promise;
				order.push("winner released");
				return { content: ["ENGINE_WINNER"] };
			}
			if (input.includes("report again")) order.push("assignment entered");
			return { content: [input.includes("report again") ? "DRIVEN_FINAL" : "INITIAL_FINAL"] };
		},
	});
	let driven: Promise<SingleResult> | undefined;
	let winner: Promise<void> | undefined;
	try {
		const install = child.session.setWorkPoolYieldItems.bind(child.session);
		let holdInstall = true;
		vi.spyOn(child.session, "setWorkPoolYieldItems").mockImplementation(async items => {
			const installed = install(items);
			if (holdInstall) {
				holdInstall = false;
				installEntered.resolve();
				await releaseInstall.promise;
			}
			await installed;
		});
		const prompt = child.session.prompt.bind(child.session);
		vi.spyOn(child.session, "prompt").mockImplementation(async (text, options) => {
			try {
				return await prompt(
					text,
					text === "report again"
						? {
								...options,
								onPromptAdmitted: () => {
									admissions++;
									options?.onPromptAdmitted?.();
								},
							}
						: options,
				);
			} catch (error) {
				if (text === "report again" && admissions === 0) rejectedBeforeAdmission.resolve();
				throw error;
			}
		});
		driven = runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			message: "report again",
			structured: false,
			artifactsDir: child.artifactsDir,
		});
		await installEntered.promise;
		winner = child.session.agent.prompt("engine winner");
		await winnerEntered.promise;
		releaseInstall.resolve();
		await rejectedBeforeAdmission.promise;
		releaseWinner.resolve();
		await winner;
		const result = await driven;
		expect(admissions).toBe(1);
		expect(order).toEqual(["winner entered", "winner released", "assignment entered"]);
		expect(result.output).toBe("DRIVEN_FINAL");
	} finally {
		releaseInstall.resolve();
		releaseWinner.resolve();
		await Promise.allSettled([driven, winner].filter(promise => promise !== undefined));
		child.close();
	}
}, 20_000);

it("keeps an independent queued note out of the driven result", async () => {
	const drivenEntered = Promise.withResolvers<void>();
	const releaseDriven = Promise.withResolvers<void>();
	const afterToolEntered = Promise.withResolvers<void>();
	const releaseAfterTool = Promise.withResolvers<void>();
	let afterToolContext = "";
	let receiptSettled = false;
	let assignmentStarted = false;
	const child = await spawnKeptAliveChild({
		structured: false,
		handler: async context => {
			const input = JSON.stringify(context.messages.at(-1));
			if (input.includes("report again")) {
				assignmentStarted = true;
				drivenEntered.resolve();
				await releaseDriven.promise;
				return {
					content: [
						{
							type: "toolCall",
							id: "read-note",
							name: "read",
							arguments: { path: path.join(root, "home", "work", "notes.txt") },
						},
					],
				};
			}
			if (assignmentStarted && !afterToolContext) {
				afterToolContext = JSON.stringify(context.messages);
				afterToolEntered.resolve();
				await releaseAfterTool.promise;
				return { content: ["DRIVEN_FINAL"] };
			}
			return { content: [input.includes("INDEPENDENT_NOTE") ? "INDEPENDENT_FINAL" : "INITIAL_FINAL"] };
		},
	});
	let driven: Promise<SingleResult> | undefined;
	let receipt: Promise<void> | undefined;
	const unregister = child.session.yieldQueue.register<string>("independent-note", {
		build: entries => ({
			role: "custom",
			customType: "independent-note",
			content: entries.join("\n"),
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
		}),
	});
	try {
		await Bun.write(path.join(root, "home", "work", "notes.txt"), "tool result");
		driven = runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			message: "report again",
			structured: false,
			artifactsDir: child.artifactsDir,
		});
		await drivenEntered.promise;
		receipt = child.session.yieldQueue.enqueueWithReceipt("independent-note", "INDEPENDENT_NOTE");
		void receipt.then(
			() => {
				receiptSettled = true;
			},
			() => {
				receiptSettled = true;
			},
		);
		releaseDriven.resolve();
		await afterToolEntered.promise;
		expect(afterToolContext).not.toContain("INDEPENDENT_NOTE");
		expect(receiptSettled).toBe(false);
		releaseAfterTool.resolve();
		const result = await driven;
		expect(result.output).toBe("DRIVEN_FINAL");
		await receipt;
		await child.session.waitForIdle();
		expect(
			child.mock.calls.filter(call => JSON.stringify(call.context.messages.at(-1)).includes("INDEPENDENT_NOTE")),
		).toHaveLength(1);
	} finally {
		releaseDriven.resolve();
		releaseAfterTool.resolve();
		unregister();
		await Promise.allSettled([driven, receipt].filter(promise => promise !== undefined));
		child.close();
	}
}, 20_000);

it("joins a required owner result with its current queued batch", async () => {
	const providerEntered = Promise.withResolvers<void>();
	const releaseProvider = Promise.withResolvers<void>();
	const jobEntered = Promise.withResolvers<void>();
	const releaseJob = Promise.withResolvers<void>();
	const resultQueued = Promise.withResolvers<void>();
	const joinEntered = Promise.withResolvers<void>();
	let assignmentStarted = false;
	let batchContext = "";
	const child = await spawnKeptAliveChild({
		structured: false,
		handler: async context => {
			const input = JSON.stringify(context.messages.at(-1));
			if (input.includes("report again")) {
				assignmentStarted = true;
				manager.register(
					"bash",
					"owned work",
					async () => {
						jobEntered.resolve();
						await releaseJob.promise;
						return "REQUIRED_OWNER_RESULT";
					},
					{ ownerId: AGENT_ID, agentId: AGENT_ID },
				);
				providerEntered.resolve();
				await releaseProvider.promise;
				return { content: ["Waiting for owned work"] };
			}
			if (assignmentStarted && JSON.stringify(context.messages).includes("REQUIRED_OWNER_RESULT")) {
				batchContext = JSON.stringify(context.messages);
				return { content: ["DRIVEN_FINAL"] };
			}
			return { content: ["INITIAL_FINAL"] };
		},
	});
	let driven: Promise<SingleResult> | undefined;
	let receipt: Promise<void> | undefined;
	const unregister = child.session.yieldQueue.register<string>("batch-note", {
		build: entries => ({
			role: "custom",
			customType: "batch-note",
			content: entries.join("\n"),
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
		}),
	});
	const enqueue = child.session.yieldQueue.enqueueWithReceipt.bind(child.session.yieldQueue);
	vi.spyOn(child.session.yieldQueue, "enqueueWithReceipt").mockImplementation((kind, entry) => {
		const result = enqueue(kind, entry);
		if (kind === "async-result") resultQueued.resolve();
		return result;
	});
	const settle = child.session.settleAsyncWork.bind(child.session);
	vi.spyOn(child.session, "settleAsyncWork").mockImplementation((...args) => {
		joinEntered.resolve();
		return settle(...args);
	});
	try {
		driven = runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			message: "report again",
			structured: false,
			artifactsDir: child.artifactsDir,
		});
		await providerEntered.promise;
		await jobEntered.promise;
		releaseProvider.resolve();
		await joinEntered.promise;
		releaseJob.resolve();
		await resultQueued.promise;
		receipt = child.session.yieldQueue.enqueueWithReceipt("batch-note", "SAME_BATCH_NOTE");
		const result = await driven;
		await receipt;
		await manager.drainDeliveries({ filter: { ownerId: AGENT_ID } });
		expect(batchContext).toContain("REQUIRED_OWNER_RESULT");
		expect(batchContext).toContain("SAME_BATCH_NOTE");
		expect(result.output).toBe("DRIVEN_FINAL");
		expect(manager.getAllJobs({ ownerId: PARENT_ID })).toHaveLength(0);
	} finally {
		releaseProvider.resolve();
		releaseJob.resolve();
		unregister();
		await Promise.allSettled([driven, receipt].filter(promise => promise !== undefined));
		child.close();
	}
}, 20_000);

it("answers an awaited child's message during a driven async join", async () => {
	const childId = `${AGENT_ID}.AwaitedChild`;
	const jobId = "RequiredChildJob";
	const question = "AWAITED_CHILD_QUESTION";
	const jobEntered = Promise.withResolvers<void>();
	const joinEntered = Promise.withResolvers<void>();
	const releaseChildProvider = Promise.withResolvers<void>();
	const childWaitRegistered = Promise.withResolvers<void>();
	const releaseOwnerAnswer = Promise.withResolvers<void>();
	let childRun: Promise<SingleResult> | undefined;
	let replyBody: string | undefined;
	let jobRunningAtReply = false;
	let childAsked = false;
	let childWaited = false;
	let questionContext = "";
	const owner = await spawnKeptAliveChild({
		structured: false,
		enableIrc: true,
		handler: async context => {
			const input = JSON.stringify(context.messages.at(-1));
			const history = JSON.stringify(context.messages);
			if (history.includes("ASK_OWNER")) {
				if (history.includes("CHILD_ANSWER")) return { content: ["DEPENDENT_DONE"] };
				if (!childAsked) {
					childAsked = true;
					await releaseChildProvider.promise;
					return {
						content: [
							{ type: "toolCall", name: "write", arguments: { path: `agent://${AGENT_ID}`, content: question } },
						],
					};
				}
				childWaited = true;
				return { content: [{ type: "toolCall", name: "wait", arguments: {} }] };
			}
			if (input.includes("report again")) {
				manager.register(
					"task",
					"awaited child work",
					async ({ signal }) => {
						childRun = runSubprocess({
							cwd: owner.cwd,
							artifactsDir: owner.artifactsDir,
							authStorage: owner.authStorage,
							modelRegistry: owner.modelRegistry,
							settings: owner.settings,
							agent: {
								name: "task",
								description: "test",
								systemPrompt: "test",
								tools: ["write", "wait"],
								source: "bundled",
							},
							task: "ASK_OWNER",
							index: 1,
							id: childId,
							parentAgentId: AGENT_ID,
							asyncJobManager: manager,
							structured: false,
							modelOverride: "mock/mock-model",
							enableLsp: false,
							enableMCP: false,
							enableIrc: true,
							signal,
						});
						jobEntered.resolve();
						const result = await childRun;
						if (result.exitCode !== 0) throw new Error(result.error ?? result.output);
						return { text: result.output };
					},
					{ id: jobId, ownerId: AGENT_ID, agentId: childId },
				);
				return { content: ["Waiting for child work"] };
			}
			if (input.includes(question)) {
				questionContext = history;
				await releaseOwnerAnswer.promise;
				return { content: ["CHILD_ANSWER"] };
			}
			if (input.includes("DEPENDENT_DONE")) return { content: ["DRIVEN_FINAL"] };
			return { content: ["INITIAL_FINAL"] };
		},
	});
	const settle = owner.session.settleAsyncWork.bind(owner.session);
	vi.spyOn(owner.session, "settleAsyncWork").mockImplementation((...args) => {
		const joining = settle(...args);
		joinEntered.resolve();
		return joining;
	});
	const bus = IrcBus.global();
	const wait = bus.wait.bind(bus);
	vi.spyOn(bus, "wait").mockImplementation((...args) => {
		const reply = wait(...args);
		if (args[0] === childId) {
			void reply.then(
				message => {
					if (message?.from === AGENT_ID) {
						replyBody = message.body;
						jobRunningAtReply = manager.getJob(jobId)?.status === "running";
					}
				},
				() => {},
			);
			childWaitRegistered.resolve();
		}
		return reply;
	});
	let driven: Promise<SingleResult> | undefined;
	try {
		driven = runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			message: "report again",
			structured: false,
			artifactsDir: owner.artifactsDir,
		});
		await jobEntered.promise;
		await joinEntered.promise;
		await owner.session.waitForIdle();
		expect(owner.session.agent.state.isStreaming).toBe(false);
		expect(owner.session.isStreaming).toBe(false);
		expect(manager.getJob(jobId)).toMatchObject({
			type: "task",
			status: "running",
			ownerId: AGENT_ID,
			agentId: childId,
		});
		expect(owner.session.yieldQueue.hasDeliverable("async-result")).toBe(false);
		releaseChildProvider.resolve();
		await childWaitRegistered.promise;
		expect(childWaited).toBe(true);
		releaseOwnerAnswer.resolve();
		await owner.session.waitForIdle();
		expect(replyBody?.includes("CHILD_ANSWER") ?? false).toBe(true);
		expect(jobRunningAtReply).toBe(true);
		expect(questionContext).toContain(question);
		const childResult = await childRun;
		expect(childResult?.exitCode).toBe(0);
		expect(childResult?.output).toBe("DEPENDENT_DONE");
		const result = await driven;
		await owner.session.waitForIdle();
		await manager.waitForOwnerJobs(PARENT_ID);
		await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
		expect(result.output).toBe("DRIVEN_FINAL");
		expect(await Bun.file(owner.artifact).text()).toContain("DRIVEN_FINAL");
		expect(manager.getAllJobs({ ownerId: PARENT_ID })).toHaveLength(0);
	} finally {
		releaseChildProvider.resolve();
		releaseOwnerAnswer.resolve();
		manager.cancel(jobId, { ownerId: AGENT_ID });
		await Promise.allSettled([driven, childRun].filter(promise => promise !== undefined));
		owner.close();
	}
}, 20_000);

/** Real task children and IRC waiters for driven continuation lifecycle cases. */
async function drivenChildFixture(options?: {
	structured?: boolean;
	explicit?: boolean;
	count?: number;
	holdChildFinal?: boolean;
	grandchild?: boolean;
	softRequestBudget?: number;
	readAfterExplicit?: boolean;
	plainChildReply?: boolean;
	plainOuterReport?: boolean;
}) {
	const count = options?.count ?? 1;
	const childIds = Array.from({ length: count }, (_, index) => `${AGENT_ID}.Dependency${index}`);
	const senderIds = childIds.map(id => (options?.grandchild ? `${id}.Grandchild` : id));
	const jobIds = childIds.map((_, index) => `DependencyJob${index}`);
	const starts = childIds.map(() => Promise.withResolvers<void>());
	const releaseChild = childIds.map(() => Promise.withResolvers<void>());
	const waits = childIds.map(() => Promise.withResolvers<void>());
	const answerGate = Promise.withResolvers<void>();
	const childFinalGate = Promise.withResolvers<void>();
	const ownerQuestion = Promise.withResolvers<void>();
	const joined = Promise.withResolvers<void>();
	const replies: Array<string | undefined> = [];
	const runs: Array<Promise<SingleResult> | undefined> = [];
	const asked = new Set<number>();
	const contexts: string[] = [];
	let explicitSent = false;
	let outerReportStarted = false;
	let lease: DrivenTurnLease | undefined;
	let driven: Promise<SingleResult> | undefined;
	const owner = await spawnKeptAliveChild({
		structured: options?.structured ?? false,
		enableIrc: true,
		tools: options?.explicit ? ["read", "write"] : ["read"],
		handler: async (context, streamOptions) => {
			const input = JSON.stringify(context.messages.at(-1));
			const history = JSON.stringify(context.messages);
			for (let index = 0; index < count; index++) {
				if (
					options?.grandchild &&
					history.includes(`ASK_OWNER_${index}`) &&
					!history.includes(`ASK_GRANDCHILD_${index}`)
				) {
					const result = await runSubprocess({
						cwd: owner.cwd,
						artifactsDir: owner.artifactsDir,
						authStorage: owner.authStorage,
						modelRegistry: owner.modelRegistry,
						settings: owner.settings,
						agent: {
							name: "task",
							description: "test",
							systemPrompt: "test",
							tools: ["write", "wait"],
							source: "bundled",
						},
						task: `ASK_GRANDCHILD_${index}`,
						index: index + 10,
						id: senderIds[index]!,
						parentAgentId: childIds[index]!,
						asyncJobManager: manager,
						structured: false,
						modelOverride: "mock/mock-model",
						enableLsp: false,
						enableMCP: false,
						enableIrc: true,
						signal: streamOptions?.signal,
					});
					if (result.exitCode !== 0) throw new Error(result.error ?? result.output);
					return { content: [`DEPENDENT_DONE_${index}`] };
				}
				if (!history.includes(`ASK_OWNER_${index}`) && !history.includes(`ASK_GRANDCHILD_${index}`)) continue;
				if (history.includes(`CHILD_ANSWER_${index}`)) {
					if (options?.holdChildFinal) await untilAborted(streamOptions?.signal, childFinalGate.promise);
					return { content: [`DEPENDENT_DONE_${index}`] };
				}
				if (!asked.has(index)) {
					asked.add(index);
					await releaseChild[index]!.promise;
					return {
						content: [
							{
								type: "toolCall",
								name: "write",
								arguments: {
									path: `agent://${AGENT_ID}`,
									content: `CHILD_QUESTION_${index}`,
								},
							},
						],
					};
				}
				return { content: [{ type: "toolCall", name: "wait", arguments: {} }] };
			}
			if (input.includes("report again")) {
				for (let index = 0; index < count; index++) {
					manager.register(
						"task",
						"dependent child",
						async ({ signal }) => {
							const run = runSubprocess({
								cwd: owner.cwd,
								artifactsDir: owner.artifactsDir,
								authStorage: owner.authStorage,
								modelRegistry: owner.modelRegistry,
								settings: owner.settings,
								agent: {
									name: "task",
									description: "test",
									systemPrompt: "test",
									tools: ["write", "wait"],
									source: "bundled",
								},
								task: `ASK_OWNER_${index}`,
								index: index + 1,
								id: childIds[index]!,
								parentAgentId: AGENT_ID,
								asyncJobManager: manager,
								structured: false,
								modelOverride: "mock/mock-model",
								enableLsp: false,
								enableMCP: false,
								enableIrc: true,
								signal,
							});
							runs[index] = run;
							starts[index]!.resolve();
							const result = await run;
							if (result.exitCode !== 0) throw new Error(result.error ?? result.output);
							return { text: result.output };
						},
						{ id: jobIds[index], ownerId: AGENT_ID, agentId: childIds[index] },
					);
				}
				return { content: ["Waiting for dependent work"] };
			}
			const questionIndex = childIds.findIndex((_, index) => input.includes(`CHILD_QUESTION_${index}`));
			if (questionIndex >= 0) {
				contexts.push(history);
				ownerQuestion.resolve();
				await untilAborted(streamOptions?.signal, answerGate.promise);
				if (options?.explicit && !explicitSent) {
					explicitSent = true;
					return {
						content: [
							{
								type: "toolCall",
								name: "write",
								arguments: {
									path: `agent://${childIds[questionIndex]}`,
									content: `CHILD_ANSWER_${questionIndex}`,
								},
							},
						],
					};
				}
				if (options?.structured && !options.plainChildReply) {
					return {
						content: [
							{
								type: "toolCall",
								name: "yield",
								arguments: { type: "result", data: `CHILD_ANSWER_${questionIndex}` },
							},
						],
						usage: { input: 37, output: 13 },
					};
				}
				return { content: [`CHILD_ANSWER_${questionIndex}`] };
			}
			if (options?.readAfterExplicit && explicitSent && input.includes('"toolName":"write"')) {
				return { content: [{ type: "toolCall", name: "read", arguments: { path: "held-read.txt" } }] };
			}
			if (input.includes("PARKED_REQUEST")) return { content: ["PARKED_REPLY"] };
			if (input.includes("SUCCESSOR")) return { content: ["SUCCESSOR_FINAL"] };
			if (input.includes("DEPENDENT_DONE_")) {
				outerReportStarted = true;
				return options?.structured && !options.plainOuterReport
					? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "DRIVEN_FINAL" } }] }
					: { content: ["DRIVEN_FINAL"] };
			}
			if (options?.plainOuterReport && outerReportStarted) return { content: ["DRIVEN_FINAL"] };
			if (input.includes("toolResult")) return { content: ["ok"] };
			return options?.structured
				? {
						content: [
							{
								type: "toolCall",
								name: "yield",
								arguments: { type: "result", data: "initial result INITIAL_FINAL" },
							},
						],
					}
				: { content: ["INITIAL_FINAL"] };
		},
	});
	const acquire = owner.session.tryAcquireDrivenTurn.bind(owner.session);
	vi.spyOn(owner.session, "tryAcquireDrivenTurn").mockImplementation(() => {
		const result = acquire();
		if (result) lease = result;
		return result;
	});
	const settle = owner.session.settleAsyncWork.bind(owner.session);
	vi.spyOn(owner.session, "settleAsyncWork").mockImplementation((...args) => {
		const result = settle(...args);
		if (args[0]?.drivenTurn) joined.resolve();
		return result;
	});
	const bus = IrcBus.global();
	const wait = bus.wait.bind(bus);
	vi.spyOn(bus, "wait").mockImplementation((...args) => {
		const result = wait(...args);
		const index = senderIds.indexOf(args[0]);
		if (index >= 0) {
			void result.then(
				message => {
					if (message?.from === AGENT_ID) replies[index] = message.body;
				},
				() => {},
			);
			waits[index]!.resolve();
		}
		return result;
	});
	return {
		owner,
		childIds,
		senderIds,
		jobIds,
		starts,
		releaseChild,
		waits,
		answerGate,
		childFinalGate,
		ownerQuestion,
		joined,
		replies,
		runs,
		contexts,
		bus,
		get lease() {
			return lease;
		},
		get driven() {
			return driven;
		},
		async start() {
			driven = runSubagentFollowUpTurn({
				id: AGENT_ID,
				agent: {
					name: "task",
					description: "test",
					systemPrompt: "test",
					tools: options?.explicit ? ["read", "write"] : ["read"],
					source: "bundled",
				},
				message: "report again",
				structured: options?.structured ?? false,
				artifactsDir: owner.artifactsDir,
				softRequestBudget: options?.softRequestBudget,
				softRequestBudgetNotice: false,
			});
			await Promise.all(starts.map(start => start.promise));
			await joined.promise;
			await owner.session.waitForIdle();
		},
		async cleanup() {
			for (const gate of releaseChild) gate.resolve();
			answerGate.resolve();
			childFinalGate.resolve();
			for (const id of jobIds) manager.cancel(id, { ownerId: AGENT_ID });
			await Promise.allSettled([driven, ...runs].filter(promise => promise !== undefined));
			owner.close();
		},
	};
}

it("relays an awaited child's structured answer without publishing an intermediate result", async () => {
	const fixture = await drivenChildFixture({ structured: true, holdChildFinal: true });
	try {
		await fixture.start();
		fixture.releaseChild[0]!.resolve();
		await fixture.waits[0]!.promise;
		fixture.answerGate.resolve();
		await fixture.owner.session.waitForIdle();
		expect(fixture.replies[0]?.includes("CHILD_ANSWER_0") ?? false).toBe(true);
		expect(manager.getJob(fixture.jobIds[0]!)?.status).toBe("running");
		expect(await Bun.file(fixture.owner.artifact).text()).toContain("INITIAL_FINAL");
		fixture.childFinalGate.resolve();
		expect((await fixture.runs[0])?.output).toBe("DEPENDENT_DONE_0");
		const result = await fixture.driven;
		expect(result?.output).toBe('"DRIVEN_FINAL"');
		expect(result?.usage?.input).toBe(37);
		expect(result?.usage?.output).toBe(13);
		expect(result?.tokens).toBe(50);
		expect(result?.requests).toBeGreaterThanOrEqual(3);
		expect(await Bun.file(fixture.owner.artifact).text()).toContain("DRIVEN_FINAL");
		expect(manager.getAllJobs({ ownerId: PARENT_ID })).toHaveLength(0);
	} finally {
		await fixture.cleanup();
	}
}, 20_000);

it("does not duplicate an explicit reply to an awaited child", async () => {
	const fixture = await drivenChildFixture({ structured: false, explicit: true });
	const send = fixture.bus.send.bind(fixture.bus);
	const answers: string[] = [];
	vi.spyOn(fixture.bus, "send").mockImplementation(async message => {
		const receipt = await send(message);
		if (message.from === AGENT_ID && message.to === fixture.childIds[0] && receipt.outcome !== "failed")
			answers.push(message.body);
		return receipt;
	});
	try {
		await fixture.start();
		fixture.releaseChild[0]!.resolve();
		await fixture.waits[0]!.promise;
		fixture.answerGate.resolve();
		expect((await fixture.runs[0])?.output).toBe("DEPENDENT_DONE_0");
		expect((await fixture.driven)?.output).toBe("DRIVEN_FINAL");
		await fixture.owner.session.waitForIrcReplies();
		expect(answers).toEqual(["CHILD_ANSWER_0"]);
		expect(manager.getAllJobs({ ownerId: AGENT_ID }).filter(job => job.id === fixture.jobIds[0])).toHaveLength(1);
	} finally {
		await fixture.cleanup();
	}
}, 20_000);

it("publishes the fresh driven report when a child completes during reply-only tool work", async () => {
	const fixture = await drivenChildFixture({
		structured: false,
		explicit: true,
		holdChildFinal: true,
		readAfterExplicit: true,
	});
	const readEntered = Promise.withResolvers<void>();
	const releaseRead = Promise.withResolvers<void>();
	const resultQueued = Promise.withResolvers<void>();
	await Bun.write(path.join(fixture.owner.cwd, "held-read.txt"), "Actual owner read work\n");
	const read = fixture.owner.session.getToolByName("read");
	if (!read) throw new Error("expected the owner's real read tool");
	const execute = read.execute.bind(read);
	const readSpy = vi.spyOn(read, "execute").mockImplementation(async (...args) => {
		const result = await execute(...args);
		readEntered.resolve();
		await untilAborted(args[2], releaseRead.promise);
		return result;
	});
	const enqueue = fixture.owner.session.yieldQueue.enqueueWithReceipt.bind(fixture.owner.session.yieldQueue);
	const enqueueSpy = vi
		.spyOn(fixture.owner.session.yieldQueue, "enqueueWithReceipt")
		.mockImplementation((kind, entry) => {
			const receipt = enqueue(kind, entry);
			if (kind === "async-result") resultQueued.resolve();
			return receipt;
		});
	try {
		await fixture.start();
		fixture.releaseChild[0]!.resolve();
		await fixture.waits[0]!.promise;
		fixture.answerGate.resolve();
		await readEntered.promise;
		expect(fixture.replies[0]).toContain("CHILD_ANSWER_0");
		expect(manager.getJob(fixture.jobIds[0]!)?.status).toBe("running");
		fixture.childFinalGate.resolve();
		expect((await fixture.runs[0])?.output).toBe("DEPENDENT_DONE_0");
		await manager.waitForOwnerJobs(AGENT_ID);
		await resultQueued.promise;
		releaseRead.resolve();
		const result = await fixture.driven;
		const artifact = await Bun.file(fixture.owner.artifact).text();
		expect(result?.output).toBe("DRIVEN_FINAL");
		expect(artifact).toContain("DRIVEN_FINAL");
		expect(artifact).not.toContain("CHILD_ANSWER_0");
	} finally {
		releaseRead.resolve();
		await fixture.cleanup();
		readSpy.mockRestore();
		enqueueSpy.mockRestore();
	}
}, 20_000);

it("excludes an awaited child's plain reply from the structured outer fallback", async () => {
	const fixture = await drivenChildFixture({
		structured: true,
		plainChildReply: true,
		plainOuterReport: true,
	});
	try {
		await fixture.start();
		fixture.releaseChild[0]!.resolve();
		await fixture.waits[0]!.promise;
		fixture.answerGate.resolve();
		expect((await fixture.runs[0])?.output).toBe("DEPENDENT_DONE_0");
		const result = await fixture.driven;
		expect(fixture.replies[0]).toContain("CHILD_ANSWER_0");
		expect(result?.output).toContain("DRIVEN_FINAL");
		expect(result?.output).not.toContain("CHILD_ANSWER_0");
	} finally {
		await fixture.cleanup();
	}
}, 20_000);

for (const invalidation of ["lease cancellation", "session abort", "session generation change"] as const) {
	it(`does not dispatch an awaited-child continuation after ${invalidation}`, async () => {
		const fixture = await drivenChildFixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let staleEvents = 0;
		let successor: Promise<SingleResult> | undefined;
		let unsubscribe: (() => void) | undefined;
		try {
			await fixture.start();
			const lease = fixture.lease;
			if (!lease) throw new Error("expected a driven lease");
			unsubscribe = fixture.owner.session.subscribe(event => {
				if (
					event.type === "message_end" &&
					JSON.stringify(event.message).includes("CHILD_QUESTION_0") &&
					fixture.owner.session.isDrivenTurnEvent(lease.token)
				)
					staleEvents++;
			});
			const settled = fixture.owner.session.whenWorkPoolYieldSettled.bind(fixture.owner.session);
			vi.spyOn(fixture.owner.session, "whenWorkPoolYieldSettled").mockImplementation(async () => {
				await settled();
				entered.resolve();
				await release.promise;
			});
			fixture.releaseChild[0]!.resolve();
			await entered.promise;
			if (invalidation === "lease cancellation") await lease.cancel();
			else if (invalidation === "session abort") await fixture.owner.session.abort();
			else expect(await fixture.owner.session.newSession()).toBe(true);
			release.resolve();
			fixture.answerGate.resolve();
			manager.cancel(fixture.jobIds[0]!, { ownerId: AGENT_ID });
			await Promise.allSettled([fixture.driven, ...fixture.runs].filter(promise => promise !== undefined));
			await fixture.owner.session.waitForDrivenTurnAvailability();
			await fixture.owner.session.waitForIdle();
			successor = runSubagentFollowUpTurn({
				id: AGENT_ID,
				agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
				message: "SUCCESSOR",
				structured: false,
				artifactsDir: fixture.owner.artifactsDir,
			});
			expect((await successor).output).toBe("SUCCESSOR_FINAL");
			expect(staleEvents).toBe(0);
			expect(await Bun.file(fixture.owner.artifact).text()).toContain("SUCCESSOR_FINAL");
			if (invalidation === "session generation change") {
				expect(fixture.contexts).toHaveLength(0);
				expect(manager.getAllJobs({ ownerId: PARENT_ID })).toHaveLength(0);
				expect(JSON.stringify(fixture.owner.mock.calls.at(-1)?.context.messages)).not.toContain("CHILD_QUESTION_0");
			}
		} finally {
			release.resolve();
			unsubscribe?.();
			await Promise.allSettled([successor].filter(promise => promise !== undefined));
			await fixture.cleanup();
		}
	}, 20_000);
}

it("does not strand an awaited-child join when abort skips its scheduled callback", async () => {
	const fixture = await drivenChildFixture();
	const abortStarted = Promise.withResolvers<void>();
	let aborting: Promise<void> | undefined;
	let staleEvents = 0;
	let callbackEntered = false;
	let abortQueued = false;
	let unsubscribe: (() => void) | undefined;
	let restoreSpies = () => {};
	try {
		await fixture.start();
		const lease = fixture.lease;
		if (!lease) throw new Error("expected a driven lease");
		unsubscribe = fixture.owner.session.subscribe(event => {
			if (
				event.type === "message_end" &&
				JSON.stringify(event.message).includes("CHILD_QUESTION_0") &&
				fixture.owner.session.isDrivenTurnEvent(lease.token)
			)
				staleEvents++;
		});
		const settled = fixture.owner.session.whenWorkPoolYieldSettled.bind(fixture.owner.session);
		const settledSpy = vi.spyOn(fixture.owner.session, "whenWorkPoolYieldSettled").mockImplementation(() => {
			callbackEntered = true;
			return settled();
		});
		const queue = IrcBridge.prototype.queueDeferredWake;
		const queueSpy = vi
			.spyOn(IrcBridge.prototype, "queueDeferredWake")
			.mockImplementation(function (this: IrcBridge, records) {
				queue.call(this, records);
				if (abortQueued || !records.some(record => JSON.stringify(record).includes("CHILD_QUESTION_0"))) return;
				abortQueued = true;
				queueMicrotask(() => {
					aborting = fixture.owner.session.abort();
					abortStarted.resolve();
				});
			});
		restoreSpies = () => {
			queueSpy.mockRestore();
			settledSpy.mockRestore();
		};
		fixture.releaseChild[0]!.resolve();
		await abortStarted.promise;
		await aborting;
		restoreSpies();
		expect(callbackEntered).toBe(false);
		expect(staleEvents).toBe(0);
		manager.cancel(fixture.jobIds[0]!, { ownerId: AGENT_ID });
		fixture.answerGate.resolve();
		expect((await fixture.driven)?.exitCode).toBe(1);
		await fixture.owner.session.waitForDrivenTurnAvailability();
		await fixture.owner.session.waitForIdle();
		const successor = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			message: "SUCCESSOR",
			structured: false,
			artifactsDir: fixture.owner.artifactsDir,
		});
		expect(successor.output).toBe("SUCCESSOR_FINAL");
	} finally {
		restoreSpies();
		unsubscribe?.();
		await Promise.allSettled([aborting].filter(promise => promise !== undefined));
		await fixture.cleanup();
	}
}, 20_000);

it("settles an awaited-child continuation when its request budget stops the owner", async () => {
	const fixture = await drivenChildFixture({ softRequestBudget: 1 });
	try {
		await fixture.start();
		fixture.releaseChild[0]!.resolve();
		await Promise.all([fixture.waits[0]!.promise, fixture.ownerQuestion.promise]);
		fixture.answerGate.resolve();
		const result = await fixture.driven;
		await fixture.owner.session.waitForIrcReplies();
		await fixture.owner.session.waitForIdle();
		expect(result?.exitCode).toBe(1);
		expect(result?.requests).toBeGreaterThanOrEqual(2);
		expect(fixture.owner.session.agent.state.isStreaming).toBe(false);
		expect(fixture.replies[0]).toMatch(/cancel|abort|fail/i);
		expect(fixture.replies[0]).not.toContain("CHILD_ANSWER_0");
	} finally {
		await fixture.cleanup();
	}
}, 20_000);

it("cancels a running awaited-child continuation without stranding its join", async () => {
	const fixture = await drivenChildFixture();
	try {
		await fixture.start();
		const lease = fixture.lease;
		if (!lease) throw new Error("expected a driven lease");
		fixture.releaseChild[0]!.resolve();
		await Promise.all([fixture.waits[0]!.promise, fixture.ownerQuestion.promise]);
		await lease.cancel();
		await fixture.owner.session.waitForIrcReplies();
		expect((await fixture.driven)?.exitCode).toBe(1);
		expect(fixture.owner.session.agent.state.isStreaming).toBe(false);
		expect(fixture.replies[0]).toMatch(/cancel|abort|fail/i);
		expect(fixture.replies[0]).not.toContain("INITIAL_FINAL");
	} finally {
		await fixture.cleanup();
	}
}, 20_000);

it("fails the driven join when an awaited-child reply cannot be delivered", async () => {
	const fixture = await drivenChildFixture();
	try {
		await fixture.start();
		fixture.releaseChild[0]!.resolve();
		await Promise.all([fixture.waits[0]!.promise, fixture.ownerQuestion.promise]);
		AgentRegistry.global().unregister(fixture.childIds[0]!);
		fixture.answerGate.resolve();
		const result = await fixture.driven;
		expect(result?.exitCode).toBe(1);
		expect(result?.error).toContain(`Unknown agent "${fixture.childIds[0]}"`);
		await fixture.owner.session.waitForIrcReplies();
		await fixture.owner.session.waitForIdle();
	} finally {
		await fixture.cleanup();
	}
}, 20_000);

async function spawnLiveFixtureAgent(
	owner: {
		cwd: string;
		artifactsDir: string;
		authStorage: AuthStorage;
		modelRegistry: ModelRegistry;
		settings: Settings;
	},
	id: string,
	parentAgentId: string,
): Promise<void> {
	const result = await runSubprocess({
		cwd: owner.cwd,
		artifactsDir: owner.artifactsDir,
		authStorage: owner.authStorage,
		modelRegistry: owner.modelRegistry,
		settings: owner.settings,
		agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
		task: `BOOT_${id}`,
		index: 20,
		id,
		parentAgentId,
		asyncJobManager: manager,
		structured: false,
		modelOverride: "mock/mock-model",
		enableLsp: false,
		enableMCP: false,
		enableIrc: true,
	});
	expect(result.exitCode).toBe(0);
	expect(AgentRegistry.global().get(id)?.session).toBeDefined();
}

it("keeps unrelated IRC parked while answering an awaited child", async () => {
	const fixture = await drivenChildFixture({ grandchild: true, holdChildFinal: true });
	const releaseOtherJobs = Promise.withResolvers<void>();
	const waiterAbort = new AbortController();
	const unrelated = `${AGENT_ID}.Unrelated`;
	const suppressed = `${AGENT_ID}.Suppressed`;
	const nonTask = `${AGENT_ID}.NonTask`;
	const peer = "PeerDependency";
	const senders = [unrelated, suppressed, nonTask, peer];
	const received: string[] = [];
	try {
		await fixture.start();
		for (const id of senders) await spawnLiveFixtureAgent(fixture.owner, id, id === peer ? PARENT_ID : AGENT_ID);
		manager.register(
			"task",
			"suppressed child",
			async () => {
				await releaseOtherJobs.promise;
				return "SUPPRESSED_JOB_RESULT";
			},
			{ id: "SuppressedDependency", ownerId: AGENT_ID, agentId: suppressed, foreground: true },
		);
		manager.register(
			"bash",
			"non-task child",
			async () => {
				await releaseOtherJobs.promise;
				return "OTHER_JOB_RESULT";
			},
			{ id: "NonTaskDependency", ownerId: AGENT_ID, agentId: nonTask },
		);
		for (const id of senders) {
			void fixture.bus.wait(id, { from: AGENT_ID }, 0, waiterAbort.signal).then(
				message => {
					if (message?.body.includes("PARKED_REPLY")) received.push(id);
				},
				() => {},
			);
			const receipt = await fixture.bus.send({ from: id, to: AGENT_ID, body: `PARKED_REQUEST_${id}` });
			expect(receipt.outcome).toBe("woken");
		}
		await fixture.bus.send({ from: PARENT_ID, to: AGENT_ID, body: "PARKED_REQUEST_PARENT" });
		fixture.releaseChild[0]!.resolve();
		await fixture.waits[0]!.promise;
		fixture.answerGate.resolve();
		await fixture.owner.session.waitForIdle();
		expect(fixture.replies[0]?.includes("CHILD_ANSWER_0") ?? false).toBe(true);
		expect(fixture.contexts[0]).not.toContain("PARKED_REQUEST");
		expect(manager.getJob(fixture.jobIds[0]!)?.status).toBe("running");
		releaseOtherJobs.resolve();
		fixture.childFinalGate.resolve();
		expect((await fixture.runs[0])?.output).toBe("DEPENDENT_DONE_0");
		await fixture.driven;
		await fixture.owner.session.waitForIdle();
		await fixture.owner.session.waitForIrcReplies();
		expect(received.sort()).toEqual([...senders].sort());
	} finally {
		releaseOtherJobs.resolve();
		waiterAbort.abort();
		await fixture.cleanup();
	}
}, 30_000);

it("answers an awaited child's next message queued while its previous reply is finishing", async () => {
	const fixture = await drivenChildFixture({ count: 2 });
	const relayEntered = Promise.withResolvers<void>();
	const releaseRelay = Promise.withResolvers<void>();
	const peer = "PeerDuringReply";
	let secondDelivery = "";
	let peerReply = "";
	let streaming = false;
	let overlappingStreams = 0;
	const unsubscribeRunState = fixture.owner.session.subscribeRunState(state => {
		if (state === "running") {
			if (streaming) overlappingStreams++;
			streaming = true;
		} else streaming = false;
	});
	const waiterAbort = new AbortController();
	const send = fixture.bus.send.bind(fixture.bus);
	vi.spyOn(fixture.bus, "send").mockImplementation(async message => {
		if (message.from === AGENT_ID && message.to === fixture.childIds[0] && message.wakeRelay) {
			relayEntered.resolve();
			await releaseRelay.promise;
		}
		const receipt = await send(message);
		if (message.from === fixture.childIds[1] && message.to === AGENT_ID) secondDelivery = receipt.outcome;
		return receipt;
	});
	try {
		await fixture.start();
		await spawnLiveFixtureAgent(fixture.owner, peer, PARENT_ID);
		fixture.releaseChild[0]!.resolve();
		await fixture.waits[0]!.promise;
		fixture.answerGate.resolve();
		await relayEntered.promise;
		expect(fixture.owner.session.agent.state.isStreaming).toBe(false);
		expect(fixture.owner.session.isStreaming).toBe(true);
		fixture.releaseChild[1]!.resolve();
		await fixture.waits[1]!.promise;
		expect(secondDelivery).toBe("injected");
		void fixture.bus.wait(peer, { from: AGENT_ID }, 0, waiterAbort.signal).then(
			message => {
				peerReply = message?.body ?? "";
			},
			() => {},
		);
		expect((await fixture.bus.send({ from: peer, to: AGENT_ID, body: "PARKED_REQUEST_PEER" })).outcome).toBe(
			"injected",
		);
		releaseRelay.resolve();
		expect((await fixture.runs[0])?.output).toBe("DEPENDENT_DONE_0");
		expect((await fixture.runs[1])?.output).toBe("DEPENDENT_DONE_1");
		expect((await fixture.driven)?.output).toBe("DRIVEN_FINAL");
		await fixture.owner.session.waitForIdle();
		await fixture.owner.session.waitForIrcReplies();
		expect(fixture.replies[0]).toContain("CHILD_ANSWER_0");
		expect(fixture.replies[1]).toContain("CHILD_ANSWER_1");
		expect(fixture.contexts[1]).not.toContain("PARKED_REQUEST_PEER");
		expect(overlappingStreams).toBe(0);
		expect(peerReply).toContain("PARKED_REPLY");
	} finally {
		releaseRelay.resolve();
		unsubscribeRunState();
		waiterAbort.abort();
		await fixture.cleanup();
	}
}, 30_000);

it("settles a suppressed in-flight result without draining independent entries", async () => {
	const providerEntered = Promise.withResolvers<void>();
	const releaseProvider = Promise.withResolvers<void>();
	const joinEntered = Promise.withResolvers<void>();
	const releaseJob = Promise.withResolvers<void>();
	const jobEntered = Promise.withResolvers<void>();
	const resultQueued = Promise.withResolvers<void>();
	const drainEntered = Promise.withResolvers<void>();
	const timerEntered = Promise.withResolvers<void>();
	const releaseTimer = Promise.withResolvers<void>();
	let liveNoteDuringDrive = false;
	let drivenDone = false;
	let jobId = "";
	const child = await spawnKeptAliveChild({
		structured: false,
		handler: async context => {
			const input = JSON.stringify(context.messages.at(-1));
			if (input.includes("report again")) {
				jobId = manager.register(
					"bash",
					"owned work",
					async () => {
						jobEntered.resolve();
						await releaseJob.promise;
						return "SUPPRESSED_RESULT";
					},
					{ ownerId: AGENT_ID, agentId: AGENT_ID },
				);
				providerEntered.resolve();
				await releaseProvider.promise;
				return { content: ["DRIVEN_FINAL"] };
			}
			if (!drivenDone && input.includes("LIVE_NOTE")) liveNoteDuringDrive = true;
			return { content: [input.includes("LIVE_NOTE") ? "INDEPENDENT_FINAL" : "INITIAL_FINAL"] };
		},
	});
	let driven: Promise<SingleResult> | undefined;
	let receipt: Promise<void> | undefined;
	const unregister = child.session.yieldQueue.register<string>("live-note", {
		build: entries => ({
			role: "custom",
			customType: "live-note",
			content: entries.join("\n"),
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
		}),
	});
	let holdTimer = false;
	const enqueue = child.session.yieldQueue.enqueueWithReceipt.bind(child.session.yieldQueue);
	vi.spyOn(child.session.yieldQueue, "enqueueWithReceipt").mockImplementation((kind, entry) => {
		if (kind === "async-result") holdTimer = true;
		const queued = enqueue(kind, entry);
		if (kind === "async-result") resultQueued.resolve();
		return queued;
	});
	const settle = child.session.settleAsyncWork.bind(child.session);
	vi.spyOn(child.session, "settleAsyncWork").mockImplementation((...args) => {
		joinEntered.resolve();
		return settle(...args);
	});
	const drain = manager.drainDeliveries.bind(manager);
	vi.spyOn(manager, "drainDeliveries").mockImplementation(options => {
		const pending = drain(options);
		if (options?.filter?.ownerId === AGENT_ID) drainEntered.resolve();
		return pending;
	});
	const wait = scheduler.wait.bind(scheduler);
	vi.spyOn(scheduler, "wait").mockImplementation((delay, options) => {
		if (delay !== 1 || !holdTimer) return wait(delay, options);
		holdTimer = false;
		timerEntered.resolve();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const signal = options?.signal;
		const abort = () => reject(signal?.reason);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		void releaseTimer.promise.then(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		});
		return promise;
	});
	try {
		driven = runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			message: "report again",
			structured: false,
			artifactsDir: child.artifactsDir,
		});
		await providerEntered.promise;
		await jobEntered.promise;
		releaseProvider.resolve();
		await joinEntered.promise;
		releaseJob.resolve();
		await resultQueued.promise;
		await timerEntered.promise;
		await drainEntered.promise;
		receipt = child.session.yieldQueue.enqueueWithReceipt("live-note", "LIVE_NOTE");
		manager.consumeJobResults([jobId]);
		releaseTimer.resolve();
		const result = await driven;
		drivenDone = true;
		await receipt;
		await child.session.waitForIdle();
		expect(result.output).not.toContain("SUPPRESSED_RESULT");
		expect(liveNoteDuringDrive).toBe(false);
		expect(
			child.mock.calls.filter(call => JSON.stringify(call.context.messages.at(-1)).includes("LIVE_NOTE")),
		).toHaveLength(1);
	} finally {
		releaseProvider.resolve();
		releaseJob.resolve();
		releaseTimer.resolve();
		unregister();
		await Promise.allSettled([driven, receipt].filter(promise => promise !== undefined));
		child.close();
	}
}, 20_000);

it("does not dispatch a later note from a stale scheduled result flush", async () => {
	const providerEntered = Promise.withResolvers<void>();
	const releaseProvider = Promise.withResolvers<void>();
	const jobEntered = Promise.withResolvers<void>();
	const releaseJob = Promise.withResolvers<void>();
	const joinEntered = Promise.withResolvers<void>();
	const drainEntered = Promise.withResolvers<void>();
	const drainReturned = Promise.withResolvers<void>();
	const timerEntered = Promise.withResolvers<void>();
	const releaseTimer = Promise.withResolvers<void>();
	const boundaryEntered = Promise.withResolvers<void>();
	const releaseBoundary = Promise.withResolvers<void>();
	const resultSeen = Promise.withResolvers<void>();
	let boundaryStarted = false;
	let boundaryContext = "";
	let droveAssignment = false;
	const child = await spawnKeptAliveChild({
		structured: false,
		handler: async context => {
			const input = JSON.stringify(context.messages.at(-1));
			if (input.includes("report again")) {
				droveAssignment = true;
				manager.register(
					"bash",
					"owned work",
					async () => {
						jobEntered.resolve();
						await releaseJob.promise;
						return "REQUIRED_OWNER_RESULT";
					},
					{ ownerId: AGENT_ID, agentId: AGENT_ID },
				);
				providerEntered.resolve();
				await releaseProvider.promise;
				return { content: ["Waiting for owned work"] };
			}
			if (droveAssignment && !boundaryStarted) {
				boundaryStarted = true;
				boundaryEntered.resolve();
				await releaseBoundary.promise;
				return {
					content: [
						{
							type: "toolCall",
							id: "read-stale-flush",
							name: "read",
							arguments: { path: path.join(root, "home", "work", "notes.txt") },
						},
					],
				};
			}
			if (droveAssignment && !boundaryContext) {
				boundaryContext = JSON.stringify(context.messages);
				resultSeen.resolve();
				return { content: ["DRIVEN_FINAL"] };
			}
			return { content: [input.includes("LATER_NOTE") ? "INDEPENDENT_FINAL" : "INITIAL_FINAL"] };
		},
	});
	let driven: Promise<SingleResult> | undefined;
	let continuation: Promise<void> | undefined;
	let receipt: Promise<void> | undefined;
	let armTimer = false;
	let startedContinuation = false;
	const unregister = child.session.yieldQueue.register<string>("later-note", {
		build: entries => ({
			role: "custom",
			customType: "later-note",
			content: entries.join("\n"),
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
		}),
	});
	const wait = scheduler.wait.bind(scheduler);
	vi.spyOn(scheduler, "wait").mockImplementation((delay, options) => {
		if (delay !== 1 || !armTimer) return wait(delay, options);
		armTimer = false;
		timerEntered.resolve();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const signal = options?.signal;
		const abort = () => reject(signal?.reason);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		void releaseTimer.promise.then(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		});
		return promise;
	});
	const drain = manager.drainDeliveries.bind(manager);
	vi.spyOn(manager, "drainDeliveries").mockImplementation(async options => {
		const pending = drain(options);
		if (options?.filter?.ownerId !== AGENT_ID) return pending;
		drainEntered.resolve();
		const drained = await pending;
		if (drained) drainReturned.resolve();
		return drained;
	});
	const enqueue = child.session.yieldQueue.enqueueWithReceipt.bind(child.session.yieldQueue);
	vi.spyOn(child.session.yieldQueue, "enqueueWithReceipt").mockImplementation((kind, entry) => {
		if (kind === "async-result" && !startedContinuation) armTimer = true;
		const queued = enqueue(kind, entry);
		if (kind === "async-result" && !startedContinuation) {
			startedContinuation = true;
			void drainEntered.promise.then(() => {
				child.session.agent.steer({ role: "user", content: "OWNER_BOUNDARY", timestamp: Date.now() });
				continuation = child.session.agent.continue();
				void continuation.catch(() => {});
			});
		}
		return queued;
	});
	const settle = child.session.settleAsyncWork.bind(child.session);
	vi.spyOn(child.session, "settleAsyncWork").mockImplementation((...args) => {
		joinEntered.resolve();
		return settle(...args);
	});
	try {
		await Bun.write(path.join(root, "home", "work", "notes.txt"), "tool result");
		driven = runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			message: "report again",
			structured: false,
			artifactsDir: child.artifactsDir,
		});
		await providerEntered.promise;
		await jobEntered.promise;
		releaseProvider.resolve();
		await joinEntered.promise;
		releaseJob.resolve();
		await timerEntered.promise;
		await boundaryEntered.promise;
		releaseBoundary.resolve();
		await resultSeen.promise;
		await drainReturned.promise;
		expect(boundaryContext).toContain("REQUIRED_OWNER_RESULT");
		if (continuation) await continuation;
		receipt = child.session.yieldQueue.enqueueWithReceipt("later-note", "LATER_NOTE");
		releaseTimer.resolve();
		const result = await driven;
		await receipt;
		await child.session.waitForIdle();
		expect(result.output).toBe("DRIVEN_FINAL");
		expect(
			child.mock.calls.filter(call => JSON.stringify(call.context.messages.at(-1)).includes("LATER_NOTE")),
		).toHaveLength(1);
	} finally {
		releaseProvider.resolve();
		releaseJob.resolve();
		releaseBoundary.resolve();
		releaseTimer.resolve();
		unregister();
		await Promise.allSettled([driven, continuation, receipt].filter(promise => promise !== undefined));
		child.close();
	}
}, 20_000);

for (const invalidation of [
	"lease cancellation",
	"lease cancellation and session abort",
	"session generation change",
] as const) {
	it(`does not run a restored continuation after ${invalidation}`, async () => {
		const timerEntered = Promise.withResolvers<void>();
		const releaseTimer = Promise.withResolvers<void>();
		const drivenEntered = Promise.withResolvers<void>();
		const releaseDriven = Promise.withResolvers<void>();
		let armTimer = false;
		let staleProviderCalls = 0;
		let drivenContext = "";
		let afterSpawn = false;
		const child = await spawnKeptAliveChild({
			structured: false,
			handler: async context => {
				const input = JSON.stringify(context.messages.at(-1));
				if (!afterSpawn) return { content: ["INITIAL_FINAL"] };
				if (input.includes("report again")) {
					drivenContext = JSON.stringify(context.messages);
					drivenEntered.resolve();
					await releaseDriven.promise;
					return { content: ["DRIVEN_FINAL"] };
				}
				staleProviderCalls++;
				return { content: ["STALE_RESTORE_FINAL"] };
			},
		});
		afterSpawn = true;
		let driven: Promise<SingleResult> | undefined;
		let lease: DrivenTurnLease | undefined;
		const wait = scheduler.wait.bind(scheduler);
		vi.spyOn(scheduler, "wait").mockImplementation((delay, options) => {
			if (delay !== 1 || !armTimer) return wait(delay, options);
			armTimer = false;
			timerEntered.resolve();
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const signal = options?.signal;
			const abort = () => reject(signal?.reason);
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			void releaseTimer.promise.then(() => {
				signal?.removeEventListener("abort", abort);
				resolve();
			});
			return promise;
		});
		try {
			const notes = path.join(root, "home", "work", "restored-notes.txt");
			await Bun.write(notes, "old restored tool result");
			child.session.sessionManager.appendMessage({
				role: "user",
				content: "interrupted restore",
				timestamp: Date.now(),
			});
			child.session.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: "interrupted-read", name: "read", arguments: { path: notes } }],
				api: "mock",
				provider: "mock",
				model: "mock-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			});
			child.session.replaceMessagesFromSessionContext(child.session.buildDisplaySessionContext().messages);
			expect(hasRestorableTurn(child.session.sessionManager.getBranch())).toBe(true);
			await child.session.waitForDrivenTurnAvailability();
			lease = child.session.tryAcquireDrivenTurn();
			if (!lease) throw new Error("expected an idle child lease");
			armTimer = true;
			const restored = child.session.restoreInterruptedTurn({ drivenTurn: lease.token });
			expect(await restored).toBe(true);
			await timerEntered.promise;
			if (invalidation === "session generation change") {
				const previousSessionId = child.session.sessionId;
				expect(await child.session.newSession()).toBe(true);
				expect(child.session.sessionId).not.toBe(previousSessionId);
			}
			await lease.cancel();
			if (invalidation === "lease cancellation and session abort") await child.session.abort();
			lease.release();
			driven = runSubagentFollowUpTurn({
				id: AGENT_ID,
				agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
				message: "report again",
				structured: false,
				artifactsDir: child.artifactsDir,
			});
			await drivenEntered.promise;
			releaseTimer.resolve();
			releaseDriven.resolve();
			const result = await driven;
			await child.session.waitForIdle();
			expect(staleProviderCalls).toBe(0);
			expect(child.deliveries.some(text => text.includes("STALE_RESTORE_FINAL"))).toBe(false);
			expect(result.output).toBe("DRIVEN_FINAL");
			expect(await Bun.file(child.artifact).text()).toContain("DRIVEN_FINAL");
			if (invalidation === "session generation change") expect(drivenContext).not.toContain("interrupted restore");
			expect(
				child.mock.calls.filter(call => JSON.stringify(call.context.messages.at(-1)).includes("report again")),
			).toHaveLength(1);
			expect(
				child.mock.calls.filter(call => JSON.stringify(call.context.messages).includes("STALE_RESTORE_FINAL")),
			).toHaveLength(0);
			expect(manager.getAllJobs({ ownerId: PARENT_ID })).toHaveLength(0);
		} finally {
			releaseTimer.resolve();
			releaseDriven.resolve();
			lease?.release();
			await Promise.allSettled([driven].filter(promise => promise !== undefined));
			await child.session.waitForIdle();
			child.close();
		}
	}, 20_000);
}

it("a focused manual prompt's yield rewrites the artifact and notifies the parent", async () => {
	const child = await spawnKeptAliveChild();
	try {
		// The focused-session input path: a plain user prompt on the idle child.
		await child.session.prompt("go on");

		// The job settles only after finalization has rewritten the artifact.
		expect(await child.firstDelivery).toContain("manual result");
		expect(await Bun.file(child.artifact).text()).toContain("manual result");
	} finally {
		child.close();
	}
}, 15_000);

it("a prompt typed while the previous turn awaits owned background work reports each turn's own result", async () => {
	const child = await spawnKeptAliveChild();
	try {
		// Owned background work keeps the first manual turn's observation open
		// after the turn itself returns, leaving the child idle for another prompt.
		const gate = Promise.withResolvers<void>();
		manager.register(
			"bash",
			"background build",
			async () => {
				await gate.promise;
				return "build done";
			},
			{ ownerId: AGENT_ID, agentId: AGENT_ID },
		);
		await child.session.prompt("go on");
		await child.session.prompt("finish up");
		gate.resolve();

		await child.firstDelivery;
		await manager.waitForOwnerJobs(PARENT_ID);
		await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
		// One completion per turn, each carrying only that turn's yield.
		const manual = child.deliveries.filter(text => text.includes("manual result"));
		const final = child.deliveries.filter(text => text.includes("final result"));
		expect(child.deliveries).toHaveLength(2);
		expect(manual).toHaveLength(1);
		expect(final).toHaveLength(1);
		expect(manual[0]).not.toContain("final result");
		expect(await Bun.file(child.artifact).text()).toContain("final result");
	} finally {
		child.close();
	}
}, 15_000);

it("does not reserve a child while its autonomous wake artifact is finalizing", async () => {
	const artifactEntered = Promise.withResolvers<void>();
	const releaseArtifact = Promise.withResolvers<void>();
	let request = 0;
	let availabilitySettled = false;
	const child = await spawnKeptAliveChild({
		structured: false,
		enableIrc: true,
		handler: () => ({ content: [++request === 1 ? "INITIAL_FINAL" : "WAKE_FINAL"] }),
	});
	const writeArtifact = artifacts.writeArtifact;
	vi.spyOn(artifacts, "writeArtifact").mockImplementation(async (file, content) => {
		if (file === child.artifact && content.includes("WAKE_FINAL")) {
			artifactEntered.resolve();
			await releaseArtifact.promise;
		}
		return writeArtifact(file, content);
	});
	const waitForAvailability = child.session.waitForDrivenTurnAvailability.bind(child.session);
	const availabilitySpy = vi
		.spyOn(child.session, "waitForDrivenTurnAvailability")
		.mockImplementation(() => waitForAvailability());
	let availability: Promise<void> | undefined;
	try {
		const receipt = await IrcBus.global().send({ from: PARENT_ID, to: AGENT_ID, body: "Wake for a new result" });
		expect(receipt.outcome).toBe("woken");
		await artifactEntered.promise;
		await child.session.waitForIdle();
		expect(child.session.hasAdmittedSubmission).toBe(false);
		const lease = child.session.tryAcquireDrivenTurn();
		// A broken implementation grants the lease here; release it before asserting so teardown can complete.
		lease?.release();
		availability = child.session.waitForDrivenTurnAvailability().then(() => {
			availabilitySettled = true;
		});
		await setImmediate();
		expect(availabilitySpy).toHaveBeenCalledTimes(1);
		expect(lease).toBeUndefined();
		expect(availabilitySettled).toBe(false);
		releaseArtifact.resolve();
		await availability;
		expect(availabilitySettled).toBe(true);
		expect(await child.firstDelivery).toContain("WAKE_FINAL");
		expect(await Bun.file(child.artifact).text()).toContain("WAKE_FINAL");
	} finally {
		releaseArtifact.resolve();
		await Promise.allSettled([availability].filter(promise => promise !== undefined));
		await child.session.waitForIdle();
		child.close();
	}
}, 20_000);

it("publishes a consumed parent injection during a peer wake without publishing peer-only replies", async () => {
	const peerStarted = Promise.withResolvers<void>();
	const releasePeer = Promise.withResolvers<void>();
	let request = 0;
	const child = await spawnKeptAliveChild({
		structured: false,
		enableIrc: true,
		handler: async () => {
			request++;
			if (request === 1) return { content: ["INITIAL_FINAL"] };
			if (request === 2) return { content: ["POSITIVE_FINAL"] };
			if (request === 3) {
				peerStarted.resolve();
				await releasePeer.promise;
				return { content: ["PEER_INTERMEDIATE"] };
			}
			return { content: [request === 4 ? "NEGATIVE_FINAL" : "PEER_ONLY_FINAL"] };
		},
	});
	try {
		const bus = IrcBus.global();
		const positive = await bus.send({ from: PARENT_ID, to: AGENT_ID, body: "First follow-up" });
		expect(positive.outcome).toBe("woken");
		await child.session.waitForIdle();
		await child.session.waitForIrcReplies();
		await manager.waitForOwnerJobs(PARENT_ID);
		await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
		expect(await Bun.file(child.artifact).text()).toContain("POSITIVE_FINAL");
		expect(child.deliveries.filter(text => text.includes("POSITIVE_FINAL"))).toHaveLength(1);
		const peer = await bus.send({ from: "Peer", to: AGENT_ID, body: "Can you check?" });
		expect(peer.outcome).toBe("woken");
		await peerStarted.promise;
		const parent = await bus.send({ from: PARENT_ID, to: AGENT_ID, body: "Publish the follow-up" });
		expect(parent.outcome).toBe("injected");
		// Receiving the request is not consumption; the prior result is still authoritative.
		expect(await Bun.file(child.artifact).text()).toContain("POSITIVE_FINAL");
		expect(child.deliveries).toHaveLength(1);
		expect(manager.getAllJobs({ ownerId: PARENT_ID })).toHaveLength(1);
		releasePeer.resolve();
		await child.session.waitForIdle();
		await child.session.waitForIrcReplies();
		await manager.waitForOwnerJobs(PARENT_ID);
		await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
		expect(JSON.stringify(child.mock.calls.at(-1)?.context.messages)).toContain("Publish the follow-up");
		expect(await Bun.file(child.artifact).text()).toContain("NEGATIVE_FINAL");
		expect(child.deliveries.filter(text => text.includes("NEGATIVE_FINAL"))).toHaveLength(1);
		expect(
			manager.getAllJobs({ ownerId: PARENT_ID }).filter(job => job.resultText?.includes("NEGATIVE_FINAL")),
		).toHaveLength(1);
		const peerOnly = await bus.send({ from: "Peer", to: AGENT_ID, body: "One more check?" });
		expect(peerOnly.outcome).toBe("woken");
		await child.session.waitForIdle();
		await child.session.waitForIrcReplies();
		await manager.waitForOwnerJobs(PARENT_ID);
		expect(await Bun.file(child.artifact).text()).toContain("NEGATIVE_FINAL");
		expect(child.deliveries).toHaveLength(2);
		expect(manager.getAllJobs({ ownerId: PARENT_ID })).toHaveLength(2);
	} finally {
		releasePeer.resolve();
		child.close();
	}
}, 15_000);

for (const source of ["queued steering", "async completion"] as const) {
	it(`publishes a consumed parent injection during ${source}`, async () => {
		const continuationStarted = Promise.withResolvers<void>();
		const peerOnlySeen = Promise.withResolvers<void>();
		const releaseContinuation = Promise.withResolvers<void>();
		let request = 0;
		const child = await spawnKeptAliveChild({
			structured: false,
			enableIrc: true,
			handler: async () => {
				request++;
				if (request === 1) return { content: ["INITIAL_FINAL"] };
				if (request === 2) {
					continuationStarted.resolve();
					await releaseContinuation.promise;
					return { content: ["INTERMEDIATE_FINAL"] };
				}
				if (request === 4) peerOnlySeen.resolve();
				return { content: [request === 3 ? "PARENT_FRESH_FINAL" : "PEER_ONLY_FINAL"] };
			},
		});
		try {
			if (source === "queued steering") {
				await child.session.steer("Continue the task", undefined, { attribution: "agent" });
			} else {
				manager.register("bash", "child-owned work", async () => "work complete", {
					ownerId: AGENT_ID,
					agentId: AGENT_ID,
				});
			}
			await continuationStarted.promise;
			const parent = await IrcBus.global().send({ from: PARENT_ID, to: AGENT_ID, body: "Publish fresh result" });
			expect(parent.outcome).toBe("injected");
			expect(await Bun.file(child.artifact).text()).toContain("INITIAL_FINAL");
			releaseContinuation.resolve();
			await child.session.waitForIdle();
			await child.session.settleAsyncWork();
			await child.session.waitForIrcReplies();
			await manager.waitForOwnerJobs(PARENT_ID);
			await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
			expect(JSON.stringify(child.mock.calls.at(-1)?.context.messages)).toContain("Publish fresh result");
			expect(await Bun.file(child.artifact).text()).toContain("PARENT_FRESH_FINAL");
			expect(child.deliveries.filter(text => text.includes("PARENT_FRESH_FINAL"))).toHaveLength(1);
			expect(
				manager.getAllJobs({ ownerId: PARENT_ID }).filter(job => job.resultText?.includes("PARENT_FRESH_FINAL")),
			).toHaveLength(1);
			if (source === "queued steering") {
				await child.session.steer("Continue without parent input", undefined, { attribution: "agent" });
				await peerOnlySeen.promise;
				await child.session.waitForIdle();
				await child.session.waitForIrcReplies();
				expect(await Bun.file(child.artifact).text()).toContain("PARENT_FRESH_FINAL");
				expect(child.deliveries).toHaveLength(1);
			}
		} finally {
			releaseContinuation.resolve();
			child.close();
		}
	}, 15_000);
}
