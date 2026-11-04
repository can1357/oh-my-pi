/**
 * A subagent is reachable as soon as its session attaches to the registry, before the executor
 * finishes startup and dispatches the assignment (#17587), and between a follow-up turn taking
 * the idle session and sending its message. A message delivered in either window, on any path,
 * must neither fail the turn nor take the turn its task owns: it waits and reaches the model
 * after the task text, exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { handleRpcSteerSubagent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type AgentSession, PromptDroppedError } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "EarlyMessage";
const BODY = "which files do you own?";
const ASSIGNMENT = "Target: src/gate.ts. Change: add the ownership gate.";
const FOLLOW_UP = "Also gate src/mask.ts the same way.";
const SECOND_FOLLOW_UP = "Then gate src/flag.ts the same way.";
const TASKS = [ASSIGNMENT, FOLLOW_UP, SECOND_FOLLOW_UP];
const MOCK_API_SOURCE = "test/subagent-message-before-assignment";
const BACKGROUND_KIND = "test-background-delivery";
const AGENT: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

/** The text the model is sent for `message`. */
function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-message-before-assignment-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

interface Delivery {
	label: string;
	/**
	 * `"task"`: the message rides the task's own first request, after the task text. `"later"`:
	 * a later turn takes it — a peer's IRC message keeps a turn of its own after the run, and a
	 * background delivery reaches the run at a step boundary or right after it, as it does when
	 * it lands mid-run.
	 */
	reaches: "task" | "later";
	/** Only the spawn window: the RPC host reaches only a subagent whose run is in progress. */
	spawnOnly?: boolean;
	deliver(session: AgentSession): Promise<unknown>;
}

const deliveries: Delivery[] = [
	{
		// `write agent://<id>` from the parent reaches the session through the IRC bus.
		label: "the parent's IRC message",
		reaches: "task",
		deliver: session =>
			session.deliverIrcMessage({ id: "early", from: MAIN_AGENT_ID, to: AGENT_ID, body: BODY, ts: 1 }),
	},
	{
		label: "a peer's IRC message",
		reaches: "later",
		deliver: session =>
			session.deliverIrcMessage({ id: "early", from: "SiblingScout", to: AGENT_ID, body: BODY, ts: 1 }),
	},
	{
		label: "an RPC steer_subagent",
		reaches: "task",
		spawnOnly: true,
		deliver: async () => {
			const sessionFile = AgentRegistry.global().get(AGENT_ID)?.sessionFile ?? undefined;
			const roster = {
				getSubagents: () => [
					{
						id: AGENT_ID,
						index: 0,
						agent: "task",
						agentSource: "bundled" as const,
						status: "running" as const,
						sessionFile,
						lastUpdate: Date.now(),
					},
				],
			};
			const refused = await handleRpcSteerSubagent(roster, AGENT_ID, BODY);
			if (refused) throw new Error(refused);
		},
	},
	{
		// The focused-subagent chat sends the message this way.
		label: "a chat message to the focused subagent",
		reaches: "task",
		deliver: session => session.prompt(BODY, { streamingBehavior: "steer" }),
	},
	{
		// A skill command typed into the focused subagent.
		label: "a custom-message prompt",
		reaches: "task",
		deliver: session =>
			session.promptCustomMessage(
				{ customType: "test-skill", content: BODY, display: true, attribution: "user" },
				{ streamingBehavior: "steer" },
			),
	},
	{
		// An extension's `pi.sendMessage(..., { triggerTurn: true })`, as a messaging plugin delivers.
		label: "an extension message that triggers a turn",
		reaches: "task",
		deliver: session =>
			session.sendCustomMessage({ customType: "test-plugin", content: BODY, display: true }, { triggerTurn: true }),
	},
	{
		// An extension's `pi.sendUserMessage(...)`.
		label: "an extension user message",
		reaches: "task",
		deliver: session => session.sendUserMessage(BODY),
	},
	{
		// An extension's hidden `pi.sendMessage(..., { deliverAs: "nextTurn", triggerTurn: true })`.
		label: "a hidden next-turn message that triggers a turn",
		reaches: "task",
		deliver: session =>
			session.sendCustomMessage(
				{ customType: "test-plugin", content: BODY, display: false },
				{ deliverAs: "nextTurn", triggerTurn: true },
			),
	},
	{
		// Background deliveries (async results, MCP notifications, late diagnostics) share the yield queue.
		label: "a background delivery",
		reaches: "later",
		deliver: async session => {
			session.yieldQueue.register<string>(BACKGROUND_KIND, {
				build: entries => ({
					role: "custom",
					customType: BACKGROUND_KIND,
					content: entries.join("\n"),
					display: false,
					attribution: "agent",
					timestamp: Date.now(),
				}),
			});
			session.yieldQueue.enqueue(BACKGROUND_KIND, BODY);
			// The idle flush runs as a post-prompt task; let it settle before the window closes.
			await session.waitForIdle();
		},
	},
];

/** Per request of the phase under test: where the phase's task text and the message sit. */
interface Request {
	taskAt: number;
	bodyAt: number;
}

interface Harness {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	cwd: string;
	artifactsDir: string;
	/** Requests since the current phase began. */
	requests: Request[];
	/** Starts a phase: requests are measured against `task` from here on. */
	beginPhase(task: string): void;
	/** Resolves once a request of the current phase carries the message. */
	bodySeen(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	let task = ASSIGNMENT;
	let requests: Request[] = [];
	let bodySeen = Promise.withResolvers<void>();
	const mock = createMockModel({
		handler: context => {
			// Everything the model was sent besides its own turns, in order.
			const sent = context.messages
				.filter(message => message.role !== "assistant")
				.map(message => JSON.stringify(message.content))
				.join("\n");
			const request = { taskAt: sent.indexOf(task), bodyAt: sent.indexOf(BODY) };
			requests.push(request);
			if (request.bodyAt >= 0) bodySeen.resolve();
			if (request.taskAt < 0) return { content: ["Context arrived without a task."] };
			// A task's first request answers with its result; a later turn (a wake for a message
			// left over, or one after the run) answers in text.
			const lastTask = context.messages.findLastIndex(
				message =>
					message.role !== "assistant" && TASKS.some(text => JSON.stringify(message.content).includes(text)),
			);
			if (context.messages.slice(lastTask + 1).some(message => message.role === "assistant")) {
				return { content: ["src/gate.ts"] };
			}
			return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	return {
		authStorage,
		modelRegistry,
		settings,
		cwd,
		artifactsDir,
		get requests() {
			return requests;
		},
		beginPhase(next) {
			task = next;
			requests = [];
			bodySeen = Promise.withResolvers<void>();
		},
		bodySeen: () => bodySeen.promise,
	};
}

/**
 * Spawns the subagent; `startup` (when given) holds it after it is reachable and before its
 * assignment. `extensions` load into the subagent beside that hold.
 */
function spawn(
	harness: Harness,
	startup?: { entered: PromiseWithResolvers<void>; release: Promise<void> },
	extensions: ExtensionFactory[] = [],
) {
	// `session_start` runs after the session is reachable and before the assignment dispatches;
	// a slow extension start widens that window the way a slow MCP/plugin start does.
	const slowStart: ExtensionFactory = pi => {
		pi.on("session_start", async () => {
			if (!startup) return;
			startup.entered.resolve();
			await startup.release;
		});
	};
	return runSubprocess({
		cwd: harness.cwd,
		artifactsDir: harness.artifactsDir,
		agent: AGENT,
		task: ASSIGNMENT,
		index: 0,
		id: AGENT_ID,
		modelOverride: "mock/mock-model",
		parentAgentId: MAIN_AGENT_ID,
		authStorage: harness.authStorage,
		modelRegistry: harness.modelRegistry,
		preloadedPreparedExtensions: [slowStart, ...extensions].map((factory, index) => ({
			path: `<inline-${index}>`,
			resolvedPath: `<inline-${index}>`,
			factory,
			error: null,
		})),
		settings: harness.settings,
		enableLsp: false,
		enableMCP: false,
		enableIrc: false,
	});
}

/** The phase's task ran with the message after its text, and the message reached the model once. */
async function expectDelivered(harness: Harness, session: AgentSession, reaches: Delivery["reaches"]): Promise<void> {
	await harness.bodySeen();
	await session.waitForIdle();
	const { requests } = harness;
	expect(requests.every(request => request.taskAt >= 0)).toBe(true);
	const firstWithBody = requests.findIndex(request => request.bodyAt >= 0);
	if (reaches === "task") expect(firstWithBody).toBe(0);
	else expect(firstWithBody).toBeGreaterThan(0);
	expect(requests[firstWithBody]!.bodyAt).toBeGreaterThan(requests[firstWithBody]!.taskAt);
	expect(session.messages.filter(message => messageText(message).includes(BODY))).toHaveLength(1);
}

describe("a message delivered before the task's turn starts", () => {
	it.each(deliveries)(
		"runs the assignment, then $label, when it lands during startup",
		async ({ reaches, deliver }) => {
			const harness = await createHarness();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			try {
				const running = spawn(harness, { entered, release: release.promise });
				await entered.promise;
				const session = AgentRegistry.global().get(AGENT_ID)?.session;
				if (!session) throw new Error(`${AGENT_ID} is not reachable during startup`);
				await deliver(session);
				release.resolve();

				const result = await running;
				expect(result.error).toBeUndefined();
				expect(result.exitCode).toBe(0);
				await expectDelivered(harness, session, reaches);
			} finally {
				release.resolve();
				harness.authStorage.close();
			}
		},
		30_000,
	);

	it.each(deliveries.filter(delivery => !delivery.spawnOnly))(
		"runs a follow-up, then $label, when it lands while the follow-up takes the idle subagent",
		async ({ reaches, deliver }) => {
			const harness = await createHarness();
			try {
				const session = await spawnIdle(harness);
				const followUp = startHeldFollowUp(harness, session, FOLLOW_UP);
				await followUp.installEntered;
				await deliver(session);
				followUp.release();

				const result = await followUp.running;
				expect(result.error).toBeUndefined();
				expect(result.exitCode).toBe(0);
				await expectDelivered(harness, session, reaches);
			} finally {
				harness.authStorage.close();
			}
		},
		30_000,
	);

	it.each(deliveries.filter(delivery => !delivery.spawnOnly))(
		"delivers $label once a follow-up gives up before it prompts",
		async ({ deliver }) => {
			const harness = await createHarness();
			try {
				const session = await spawnIdle(harness);
				const followUp = startHeldFollowUp(harness, session, FOLLOW_UP, { failInstall: true });
				await followUp.installEntered;
				await deliver(session);
				followUp.release();
				await expect(followUp.running).rejects.toThrow("install failed");

				// Nothing waits for an assignment any more: the message reaches the idle subagent.
				await harness.bodySeen();
				await session.waitForIdle();
				expect(session.awaitingAssignment).toBe(false);
				expect(session.messages.filter(message => messageText(message).includes(BODY))).toHaveLength(1);
			} finally {
				harness.authStorage.close();
			}
		},
		30_000,
	);

	it("refuses resume and retry while a follow-up holds the subagent, so they cannot take its turn", async () => {
		const harness = await createHarness();
		try {
			const session = await spawnIdle(harness);
			const followUp = startHeldFollowUp(harness, session, FOLLOW_UP);
			await followUp.installEntered;
			await session.prompt(BODY, { streamingBehavior: "steer" });
			await expect(session.resume()).rejects.toThrow("Agent is already processing");
			expect(await session.retry()).toBe(false);
			followUp.release();

			const result = await followUp.running;
			expect(result.exitCode).toBe(0);
			await expectDelivered(harness, session, "task");
		} finally {
			harness.authStorage.close();
		}
	}, 30_000);

	it("lets a second follow-up wait for the first one's hold instead of taking it over", async () => {
		const harness = await createHarness();
		try {
			const session = await spawnIdle(harness);
			const first = startHeldFollowUp(harness, session, FOLLOW_UP);
			await first.installEntered;
			const second = runSubagentFollowUpTurn({
				id: AGENT_ID,
				agent: AGENT,
				message: SECOND_FOLLOW_UP,
				artifactsDir: harness.artifactsDir,
			});
			await session.prompt(BODY, { streamingBehavior: "steer" });
			first.release();

			expect((await first.running).exitCode).toBe(0);
			expect((await second).exitCode).toBe(0);
			await expectDelivered(harness, session, "task");
		} finally {
			harness.authStorage.close();
		}
	}, 30_000);

	it("delivers once a hidden next-turn message an extension sends while the assignment's turn is set up", async () => {
		const harness = await createHarness();
		try {
			let sent = false;
			const lateSender: ExtensionFactory = pi => {
				pi.on("before_agent_start", async () => {
					if (sent) return;
					sent = true;
					pi.sendMessage(
						{ customType: "test-plugin", content: BODY, display: false },
						{ deliverAs: "nextTurn", triggerTurn: true },
					);
				});
			};
			const result = await spawn(harness, undefined, [lateSender]);
			expect(result.exitCode).toBe(0);
			const session = AgentRegistry.global().get(AGENT_ID)?.session;
			if (!session) throw new Error(`${AGENT_ID} was not kept alive`);
			await expectDelivered(harness, session, "later");
		} finally {
			harness.authStorage.close();
		}
	}, 30_000);

	it("keeps a continuation scheduled during a follow-up's hold from taking its turn", async () => {
		const harness = await createHarness();
		try {
			const session = await spawnIdle(harness);
			const followUp = startHeldFollowUp(harness, session, FOLLOW_UP);
			await followUp.installEntered;
			await session.prompt(BODY, { streamingBehavior: "steer" });
			// The interactive caller's deferred resume after an `ask` re-answer.
			session.resumeAfterAskReanswer();
			await session.waitForIdle();
			followUp.release();

			expect((await followUp.running).exitCode).toBe(0);
			await expectDelivered(harness, session, "task");
		} finally {
			harness.authStorage.close();
		}
	}, 30_000);

	it("lets a follow-up waiting on another one's hold go on when the subagent is parked under it", async () => {
		const harness = await createHarness();
		try {
			const session = await spawnIdle(harness);
			const first = startHeldFollowUp(harness, session, FOLLOW_UP);
			await first.installEntered;
			const waiting = Promise.withResolvers<void>();
			const whenAssignmentStarts = session.whenAssignmentStarts.bind(session);
			vi.spyOn(session, "whenAssignmentStarts").mockImplementation(() => {
				waiting.resolve();
				return whenAssignmentStarts();
			});
			const second = runSubagentFollowUpTurn({
				id: AGENT_ID,
				agent: AGENT,
				message: SECOND_FOLLOW_UP,
				artifactsDir: harness.artifactsDir,
			});
			await waiting.promise;
			await AgentLifecycleManager.global().park(AGENT_ID);
			first.release();

			expect((await first.running).exitCode).toBe(0);
			expect((await second).exitCode).toBe(0);
		} finally {
			harness.authStorage.close();
		}
	}, 30_000);

	it("keeps a held hidden message when the follow-up's prompt is dropped and sent again", async () => {
		const harness = await createHarness();
		try {
			// Aborting during `before_agent_start` drops the prompt; the executor sends it again.
			const drop = { armed: false, session: undefined as AgentSession | undefined };
			const dropper: ExtensionFactory = pi => {
				pi.on("before_agent_start", async () => {
					if (!drop.armed) return;
					drop.armed = false;
					void drop.session?.abort();
				});
			};
			const session = await spawnIdle(harness, [dropper]);
			drop.session = session;
			const followUp = startHeldFollowUp(harness, session, FOLLOW_UP);
			await followUp.installEntered;
			await session.sendCustomMessage(
				{ customType: "test-plugin", content: BODY, display: false },
				{ deliverAs: "nextTurn" },
			);
			drop.armed = true;
			followUp.release();

			expect((await followUp.running).exitCode).toBe(0);
			await expectDelivered(harness, session, "task");
		} finally {
			harness.authStorage.close();
		}
	}, 30_000);

	it("starts no turn under a follow-up's hold for a message admitted before it", async () => {
		const harness = await createHarness();
		try {
			const session = await spawnIdle(harness);
			// Hold the message in its admission (image normalization) while the follow-up starts.
			const normalizing = Promise.withResolvers<void>();
			const normalized = Promise.withResolvers<void>();
			const normalize = imageLoading.normalizeModelContextImages;
			vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementationOnce(async (images, options) => {
				normalizing.resolve();
				await normalized.promise;
				return normalize(images, options);
			});
			const delivery = session.prompt(BODY, { streamingBehavior: "steer" });
			await normalizing.promise;
			const followUp = startHeldFollowUp(harness, session, FOLLOW_UP);
			let requestsAtHold = -1;
			const held = followUp.installEntered.then(() => {
				requestsAtHold = harness.requests.length;
			});
			normalized.resolve();
			await delivery;
			await held;
			await session.waitForIdle();
			// The message came first, so it may take a turn before the follow-up owns the session;
			// none starts once the follow-up holds it.
			expect(harness.requests.length).toBe(requestsAtHold);
			followUp.release();

			expect((await followUp.running).exitCode).toBe(0);
			expect(harness.requests.at(-1)?.taskAt).toBeGreaterThanOrEqual(0);
			expect(session.messages.filter(message => messageText(message).includes(BODY))).toHaveLength(1);
		} finally {
			harness.authStorage.close();
		}
	}, 30_000);

	it("cancels a continuation held for a follow-up when the subagent is aborted", async () => {
		const harness = await createHarness();
		try {
			const session = await spawnIdle(harness);
			const followUp = startHeldFollowUp(harness, session, FOLLOW_UP, { failInstall: true });
			await followUp.installEntered;
			// The interactive caller's deferred resume after an `ask` re-answer, then an abort.
			session.resumeAfterAskReanswer();
			await session.waitForIdle();
			await session.abort();
			followUp.release();
			await expect(followUp.running).rejects.toThrow("install failed");

			await session.waitForIdle();
			expect(harness.requests).toEqual([]);
		} finally {
			harness.authStorage.close();
		}
	}, 30_000);

	it("drops a held hidden message with the transcript a session change replaces during the follow-up's prompt", async () => {
		const harness = await createHarness();
		try {
			// Pause the follow-up's prompt in `before_agent_start`, after it took the hidden message.
			const pause = { armed: false, entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
			const pauser: ExtensionFactory = pi => {
				pi.on("before_agent_start", async () => {
					if (!pause.armed) return;
					pause.armed = false;
					pause.entered.resolve();
					await pause.release.promise;
				});
			};
			const session = await spawnIdle(harness, [pauser]);
			const followUp = startHeldFollowUp(harness, session, FOLLOW_UP);
			await followUp.installEntered;
			await session.sendCustomMessage(
				{ customType: "test-plugin", content: BODY, display: false },
				{ deliverAs: "nextTurn" },
			);
			pause.armed = true;
			followUp.release();
			await pause.entered.promise;
			await session.newSession();
			pause.release.resolve();
			await followUp.running.catch(() => undefined);
			await session.waitForIdle();

			// The message belonged to the replaced transcript: no request of the new one carries it.
			expect(harness.requests.filter(request => request.bodyAt >= 0)).toEqual([]);
			expect(session.messages.filter(message => messageText(message).includes(BODY))).toHaveLength(0);
		} finally {
			harness.authStorage.close();
		}
	}, 30_000);

	it("keeps a held hidden message when a session switch refused during the dropped prompt rolls back", async () => {
		const harness = await createHarness();
		const pause = pauseBeforeAgentStart();
		let endHold: (() => void) | undefined;
		let prompting: Promise<unknown> | undefined;
		let switching: RefusedSwitch | undefined;
		try {
			const session = await spawnIdle(harness, [pause.extension]);
			harness.beginPhase(FOLLOW_UP);
			endHold = session.holdForAssignment();
			await session.sendCustomMessage(
				{ customType: "test-plugin", content: BODY, display: false },
				{ deliverAs: "nextTurn" },
			);
			pause.arm();
			prompting = session.prompt("a task the switch drops", { assignment: true });
			await pause.entered;
			// A switch to another directory, refused by its owner only after the prompt finished.
			switching = await startRefusedSwitch(session, "other");
			pause.release();
			await prompting;
			expect(harness.requests).toEqual([]);
			expect(await switching.refuse()).toBe(false);
			endHold();
			endHold = undefined;

			// The original transcript is still live, so the next task carries the message, once.
			await session.prompt(FOLLOW_UP);
			await session.waitForIdle();
			expect(harness.requests[0]?.taskAt).toBeGreaterThanOrEqual(0);
			expect(harness.requests[0]?.bodyAt).toBeGreaterThan(harness.requests[0]?.taskAt ?? Infinity);
			expect(session.messages.filter(message => messageText(message).includes(BODY))).toHaveLength(1);
		} finally {
			pause.release();
			endHold?.();
			await Promise.allSettled([prompting, switching?.refuse()]);
			harness.authStorage.close();
		}
	}, 30_000);

	it("runs a follow-up whose prompt a pending session switch dropped once the switch is refused, with its held message", async () => {
		const harness = await createHarness();
		const pause = pauseBeforeAgentStart();
		let followUp: ReturnType<typeof startHeldFollowUp> | undefined;
		let switching: RefusedSwitch | undefined;
		try {
			const session = await spawnIdle(harness, [pause.extension]);
			followUp = startHeldFollowUp(harness, session, FOLLOW_UP);
			await followUp.installEntered;
			await session.sendCustomMessage(
				{ customType: "test-plugin", content: BODY, display: false },
				{ deliverAs: "nextTurn" },
			);
			pause.arm();
			followUp.release();
			await pause.entered;
			// The switch's abort drops the follow-up's prompt; the executor sends it again while
			// the switch still waits for its owner. That retry must wait for the switch to settle.
			switching = await startRefusedSwitch(session, "other");
			pause.release();
			await Bun.sleep(1_000);
			expect(harness.requests).toEqual([]);
			expect(await switching.refuse()).toBe(false);

			const result = await followUp.running;
			expect(result.error).toBeUndefined();
			expect(result.exitCode).toBe(0);
			await expectDelivered(harness, session, "task");
		} finally {
			pause.release();
			followUp?.release();
			await Promise.allSettled([followUp?.running, switching?.refuse()]);
			harness.authStorage.close();
		}
	}, 30_000);

	it("delivers a held hidden trigger its owner released during a session switch once the switch is refused", async () => {
		const harness = await createHarness();
		const pause = pauseBeforeAgentStart();
		let endHold: (() => void) | undefined;
		let prompting: Promise<unknown> | undefined;
		let switching: RefusedSwitch | undefined;
		try {
			const session = await spawnIdle(harness, [pause.extension]);
			harness.beginPhase(FOLLOW_UP);
			endHold = session.holdForAssignment();
			await session.sendCustomMessage(
				{ customType: "test-plugin", content: BODY, display: false },
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
			await session.waitForIdle();
			pause.arm();
			prompting = session.prompt("a task the switch drops", { assignment: true });
			await pause.entered;
			switching = await startRefusedSwitch(session, "other");
			pause.release();
			await prompting;
			// The owner gives up on its task while the switch is still pending.
			endHold();
			endHold = undefined;
			await session.waitForIdle();
			expect(harness.requests).toEqual([]);
			expect(await switching.refuse()).toBe(false);
			// The trigger runs its own turn once the switch settles; a lost trigger never sends the message.
			await Promise.race([harness.bodySeen(), Bun.sleep(5_000)]);
			await session.waitForIdle();
			expect(harness.requests.filter(request => request.bodyAt >= 0)).toHaveLength(1);
			expect(session.messages.filter(message => messageText(message).includes(BODY))).toHaveLength(1);

			// Delivered into the transcript, so it survives parking.
			await AgentLifecycleManager.global().park(AGENT_ID);
			const revived = await AgentLifecycleManager.global().ensureLive(AGENT_ID);
			expect(revived.messages.filter(message => messageText(message).includes(BODY))).toHaveLength(1);
		} finally {
			pause.release();
			endHold?.();
			await Promise.allSettled([prompting, switching?.refuse()]);
			harness.authStorage.close();
		}
	}, 30_000);

	it.each(["abort", "dispose"] as const)(
		"never starts an assignment cancelled by %s while it waits for a session switch",
		async cancel => {
			const harness = await createHarness();
			let endHold: (() => void) | undefined;
			let switching: RefusedSwitch | undefined;
			try {
				const session = await spawnIdle(harness);
				harness.beginPhase(FOLLOW_UP);
				endHold = session.holdForAssignment();
				await session.sendCustomMessage(
					{ customType: "test-plugin", content: BODY, display: false },
					{ deliverAs: "nextTurn" },
				);
				switching = await startRefusedSwitch(session, "other");
				const prompting = session.prompt(FOLLOW_UP, { assignment: true, throwOnDrop: true });
				const cancelling = cancel === "abort" ? session.abort() : session.dispose();
				await Promise.allSettled([switching.refuse()]);
				await Promise.allSettled([cancelling]);
				await expect(prompting).rejects.toBeInstanceOf(PromptDroppedError);
				await Bun.sleep(500);
				expect(harness.requests).toEqual([]);
			} finally {
				endHold?.();
				await Promise.allSettled([switching?.refuse()]);
				harness.authStorage.close();
			}
		},
		30_000,
	);

	it("keeps a subagent whose released hidden trigger waits out a session switch from being parked", async () => {
		const harness = await createHarness();
		let followUp: ReturnType<typeof startHeldFollowUp> | undefined;
		let switching: RefusedSwitch | undefined;
		try {
			const session = await spawnIdle(harness);
			followUp = startHeldFollowUp(harness, session, FOLLOW_UP, { failInstall: true });
			await followUp.installEntered;
			await session.sendCustomMessage(
				{ customType: "test-plugin", content: BODY, display: false },
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
			await session.waitForIdle();
			switching = await startRefusedSwitch(session, "other");
			// The follow-up gives up and releases its hold while the switch is pending.
			followUp.release();
			await expect(followUp.running).rejects.toThrow("install failed");
			await session.waitForIdle();
			expect(session.awaitingAssignment).toBe(false);
			// The trigger waits for the switch; the idle timer must not park the subagent and drop it.
			expect(session.ircWakesPending).toBe(true);

			expect(await switching.refuse()).toBe(false);
			await Promise.race([harness.bodySeen(), Bun.sleep(5_000)]);
			await session.waitForIdle();
			expect(session.ircWakesPending).toBe(false);
			expect(session.messages.filter(message => messageText(message).includes(BODY))).toHaveLength(1);
		} finally {
			followUp?.release();
			await Promise.allSettled([followUp?.running, switching?.refuse()]);
			harness.authStorage.close();
		}
	}, 30_000);

	it("delivers a released hidden trigger whose turn a refused session switch dropped while it was set up", async () => {
		const harness = await createHarness();
		const pause = pauseBeforeAgentStart();
		let endHold: (() => void) | undefined;
		let switching: RefusedSwitch | undefined;
		try {
			const session = await spawnIdle(harness, [pause.extension]);
			harness.beginPhase(FOLLOW_UP);
			endHold = session.holdForAssignment();
			await session.sendCustomMessage(
				{ customType: "test-plugin", content: BODY, display: false },
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
			await session.waitForIdle();
			// The owner gives up: the held trigger runs a turn of its own, paused in its setup.
			pause.arm();
			endHold();
			endHold = undefined;
			await pause.entered;
			// A switch's internal abort drops that turn: let the turn's setup go only once that abort
			// has run (its cancellation is synchronous), so the order does not depend on timing.
			const internalAbort = Promise.withResolvers<void>();
			const abort = session.abort.bind(session);
			const abortSpy = vi.spyOn(session, "abort").mockImplementation(options => {
				const aborting = abort(options);
				if (options?.goalReason === "internal") internalAbort.resolve();
				return aborting;
			});
			const asking = startRefusedSwitch(session, "other");
			await internalAbort.promise;
			abortSpy.mockRestore();
			pause.release();
			switching = await asking;
			await Bun.sleep(500);
			expect(harness.requests).toEqual([]);
			// The trigger waits for the switch, so the idle timer must not park the subagent.
			expect(session.ircWakesPending).toBe(true);

			expect(await switching.refuse()).toBe(false);
			await Promise.race([harness.bodySeen(), Bun.sleep(5_000)]);
			await session.waitForIdle();
			expect(harness.requests.filter(request => request.bodyAt >= 0)).toHaveLength(1);
			expect(session.messages.filter(message => messageText(message).includes(BODY))).toHaveLength(1);
		} finally {
			pause.release();
			endHold?.();
			await Promise.allSettled([switching?.refuse()]);
			harness.authStorage.close();
		}
	}, 30_000);

	it("runs an assignment that waited out a refused session switch which had not yet stopped the session", async () => {
		const harness = await createHarness();
		const beforeSwitch = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		// Holds the switch in `session_before_switch`, before its own internal abort.
		const switchGate: ExtensionFactory = pi => {
			pi.on("session_before_switch", async () => {
				beforeSwitch.entered.resolve();
				await beforeSwitch.release.promise;
				return undefined;
			});
		};
		let endHold: (() => void) | undefined;
		let switching: Promise<boolean> | undefined;
		try {
			const session = await spawnIdle(harness, [switchGate]);
			harness.beginPhase(FOLLOW_UP);
			endHold = session.holdForAssignment();
			await session.sendCustomMessage(
				{ customType: "test-plugin", content: BODY, display: false },
				{ deliverAs: "nextTurn" },
			);
			const targetCwd = path.join(root, "gated-cwd");
			await fs.mkdir(targetCwd, { recursive: true });
			const target = SessionManager.create(targetCwd, path.join(root, "gated-sessions"));
			target.appendMessage({ role: "user", content: "gated session", timestamp: Date.now() });
			await target.ensureOnDisk();
			switching = session.switchSession(target.getSessionFile()!, { onCwdChange: async () => false });
			await beforeSwitch.entered.promise;
			// The assignment arrives while the switch has not run its internal abort yet.
			const prompting = session.prompt(FOLLOW_UP, { assignment: true, throwOnDrop: true });
			beforeSwitch.release.resolve();
			expect(await switching).toBe(false);
			await prompting;
			endHold = undefined;
			await session.waitForIdle();
			// The switch was refused and nobody aborted the task: it runs, with the held message.
			expect(harness.requests[0]?.taskAt).toBeGreaterThanOrEqual(0);
			expect(harness.requests[0]?.bodyAt).toBeGreaterThan(harness.requests[0]?.taskAt ?? Infinity);
			expect(session.awaitingAssignment).toBe(false);
		} finally {
			beforeSwitch.release.resolve();
			endHold?.();
			await Promise.allSettled([switching]);
			harness.authStorage.close();
		}
	}, 30_000);

	it.each(["abort", "dispose"] as const)(
		"settles a hidden trigger put off by a prompt in its setup after %s, so nothing keeps the subagent from parking",
		async cancel => {
			const harness = await createHarness();
			const pause = pauseBeforeAgentStart();
			let prompting: Promise<unknown> | undefined;
			try {
				const session = await spawnIdle(harness, [pause.extension]);
				// A prompt in its setup puts off a hidden next-turn trigger.
				pause.arm();
				prompting = session.prompt("work in progress");
				await pause.entered;
				await session.sendCustomMessage(
					{ customType: "test-plugin", content: BODY, display: false },
					{ deliverAs: "nextTurn", triggerTurn: true },
				);
				await Bun.sleep(100);
				expect(session.ircWakesPending).toBe(true);

				if (cancel === "abort") await session.abort();
				else await session.dispose();
				pause.release();
				await Promise.allSettled([prompting]);
				if (cancel === "abort") {
					// The trigger is a delivery: once the abort settles it runs, once.
					await Promise.race([harness.bodySeen(), Bun.sleep(5_000)]);
					await session.waitForIdle();
					expect(session.messages.filter(message => messageText(message).includes(BODY))).toHaveLength(1);
				}
				expect(session.ircWakesPending).toBe(false);
			} finally {
				pause.release();
				await Promise.allSettled([prompting]);
				harness.authStorage.close();
			}
		},
		30_000,
	);

	it.each([1, 2])(
		"starts no held hidden trigger's turn while any of %i overlapping aborts is still cleaning up, and runs it once they end",
		async abortCount => {
			const harness = await createHarness();
			const pause = pauseBeforeAgentStart();
			// One gate per abort: each holds its abort in its cleanup, where it waits for the agent to settle.
			const cleanups = Array.from({ length: abortCount }, () => ({
				entered: Promise.withResolvers<void>(),
				release: Promise.withResolvers<void>(),
			}));
			let prompting: Promise<unknown> | undefined;
			const aborting: Promise<void>[] = [];
			try {
				const session = await spawnIdle(harness, [pause.extension]);
				harness.beginPhase("work in progress");
				// A prompt in its setup puts off a hidden next-turn trigger.
				pause.arm();
				prompting = session.prompt("work in progress");
				await pause.entered;
				await session.sendCustomMessage(
					{ customType: "test-plugin", content: BODY, display: false },
					{ deliverAs: "nextTurn", triggerTurn: true },
				);
				const waitForIdle = session.agent.waitForIdle.bind(session.agent);
				let held = 0;
				vi.spyOn(session.agent, "waitForIdle").mockImplementation(async () => {
					const cleanup = cleanups[held++];
					if (cleanup) {
						cleanup.entered.resolve();
						await cleanup.release.promise;
					}
					await waitForIdle();
				});
				const finished = cleanups.map(() => false);
				for (const [index, cleanup] of cleanups.entries()) {
					aborting.push(
						session.abort().then(() => {
							finished[index] = true;
						}),
					);
					await cleanup.entered.promise;
				}
				// The paused prompt now finishes while every abort is still cleaning up.
				pause.release();
				await prompting;
				// The aborts end one by one; while any is still cleaning up, no turn carries the message.
				for (const [index, cleanup] of cleanups.entries()) {
					await Bun.sleep(300);
					expect(finished.slice(index)).toEqual(cleanups.slice(index).map(() => false));
					expect(harness.requests.filter(request => request.bodyAt >= 0)).toEqual([]);
					cleanup.release.resolve();
					await aborting[index];
				}
				// The trigger is a delivery: once the last abort has ended it runs, once.
				await Promise.race([harness.bodySeen(), Bun.sleep(5_000)]);
				await session.waitForIdle();
				expect(harness.requests.filter(request => request.bodyAt >= 0)).toHaveLength(1);
				expect(session.messages.filter(message => messageText(message).includes(BODY))).toHaveLength(1);
			} finally {
				pause.release();
				for (const cleanup of cleanups) cleanup.release.resolve();
				await Promise.allSettled([prompting, ...aborting]);
				harness.authStorage.close();
			}
		},
		30_000,
	);
});

/** Spawns the subagent, lets its first run finish, and returns its kept-alive idle session. */
async function spawnIdle(harness: Harness, extensions: ExtensionFactory[] = []): Promise<AgentSession> {
	const first = await spawn(harness, undefined, extensions);
	expect(first.exitCode).toBe(0);
	const session = AgentRegistry.global().get(AGENT_ID)?.session;
	if (!session) throw new Error(`${AGENT_ID} was not kept alive`);
	await session.waitForIdle();
	return session;
}

/**
 * Starts a follow-up and holds it after it owns the idle session, where it installs its yield
 * contract before it prompts. With `failInstall`, the install fails once released.
 */
function startHeldFollowUp(
	harness: Harness,
	session: AgentSession,
	message: string,
	options?: { failInstall?: boolean },
) {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const install = session.setWorkPoolYieldItems.bind(session);
	vi.spyOn(session, "setWorkPoolYieldItems").mockImplementationOnce(async items => {
		entered.resolve();
		await released.promise;
		if (options?.failInstall) throw new Error("install failed");
		return install(items);
	});
	harness.beginPhase(message);
	const running = runSubagentFollowUpTurn({ id: AGENT_ID, agent: AGENT, message, artifactsDir: harness.artifactsDir });
	return { running, installEntered: entered.promise, release: () => released.resolve() };
}

/** Pauses the next armed turn in `before_agent_start`, after its prompt has taken its context. */
function pauseBeforeAgentStart() {
	let armed = false;
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const extension: ExtensionFactory = pi => {
		pi.on("before_agent_start", async () => {
			if (!armed) return;
			armed = false;
			entered.resolve();
			await released.promise;
		});
	};
	return {
		extension,
		entered: entered.promise,
		arm: () => {
			armed = true;
		},
		release: () => released.resolve(),
	};
}

interface RefusedSwitch {
	/** Lets the owner refuse the switch; resolves with the switch's outcome. */
	refuse(): Promise<boolean>;
}

/** Starts a switch to a session in another directory and holds it until its owner refuses the move. */
async function startRefusedSwitch(session: AgentSession, name: string): Promise<RefusedSwitch> {
	const targetCwd = path.join(root, `${name}-cwd`);
	await fs.mkdir(targetCwd, { recursive: true });
	const target = SessionManager.create(targetCwd, path.join(root, `${name}-sessions`));
	target.appendMessage({ role: "user", content: `${name} session`, timestamp: Date.now() });
	await target.ensureOnDisk();
	const asked = Promise.withResolvers<void>();
	const refused = Promise.withResolvers<void>();
	const switching = session.switchSession(target.getSessionFile()!, {
		onCwdChange: async () => {
			asked.resolve();
			await refused.promise;
			return false;
		},
	});
	await asked.promise;
	return {
		refuse: () => {
			refused.resolve();
			return switching;
		},
	};
}
