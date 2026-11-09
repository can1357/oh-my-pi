import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AcpAgent, ACP_BOOTSTRAP_RACE_GUARD_MS } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, type SubagentLifecyclePayload } from "@oh-my-pi/pi-coding-agent/task/types";
import type { AgentSideConnection, ClientCapabilities } from "@oh-my-pi/pi-utils/acp";
import { setAgentDir } from "@oh-my-pi/pi-utils";

type SubagentParams = {
	sessionId: string;
	parentToolCallId: string | null;
	seq: number;
	children: Array<{
		id: string;
		agent: string;
		description: string | null;
		status: string;
		async: boolean;
		updatedAt: number;
	}>;
};

const cleanupRoots: string[] = [];
const SUBAGENT_CAPS: ClientCapabilities = { _meta: { "omp/subagents": true } } as unknown as ClientCapabilities;

afterEach(async () => {
	resetSettingsForTest();
	for (const root of cleanupRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

class StubSession {
	sessionId = "session-a";
	sessionManager = {
		ensureOnDisk: async () => {},
		getSessionId: () => this.sessionId,
		getArtifactsDir: () => undefined,
		getCwd: () => process.cwd(),
		getHeader: () => undefined,
	};
	agent = { sessionId: this.sessionId, waitForIdle: async () => {} };
	model = undefined;
	thinkingLevel = undefined;
	customCommands: [] = [];
	extensionRunner = undefined;
	isStreaming = false;
	queuedMessageCount = 0;
	systemPrompt = "system";
	disposed = false;
	sessionName = "test";
	cwd = process.cwd();
	effectiveExtensionRoots: string[] = [];
	messageCount = 0;
	modified = new Date();
	size = 0;
	title = "test";
	id = "session-a";
	get settings(): Settings {
		return Settings.instance;
	}
	#listeners = new Set<(event: AgentSessionEvent) => void>();

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	registerSessionChangeCallback(): () => void {
		return () => {};
	}
	setClientBridge(): void {}
	setMcpServerInstructionsSource(): void {}
	async refreshMCPTools(): Promise<void> {}
	subscribeCommandMetadataChanged(): () => void {
		return () => {};
	}
	setSlashCommands(): void {}
	async refreshSkillsAndCommands(): Promise<void> {}
	getPlanModeState(): undefined {
		return undefined;
	}
	getAvailableModels(): [] {
		return [];
	}
	getAvailableThinkingLevels(): string[] {
		return ["off"];
	}
	getEnabledToolNames(): string[] {
		return [];
	}
	getAllToolInfos(): [] {
		return [];
	}
	getContextUsage(): undefined {
		return undefined;
	}
	async dispose(): Promise<void> {
		this.disposed = true;
	}
	get listenerCount(): number {
		return this.#listeners.size;
	}
	emit(event: AgentSessionEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

async function createSubagentHarness(clientCapabilities: ClientCapabilities | undefined = SUBAGENT_CAPS) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-acp-subagents-"));
	cleanupRoots.push(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "cwd");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	setAgentDir(agentDir);
	await Settings.init({ agentDir, inMemory: true });

	const extNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const abortController = new AbortController();
	const connection = {
		sessionUpdate: async () => {},
		extNotification: async (method: string, params: Record<string, unknown>) => {
			extNotifications.push({ method, params });
		},
		requestPermissionWithCancel: () => ({
			promise: Promise.resolve({ outcome: { outcome: "cancelled" } }),
			cancel: () => {},
		}),
		signal: abortController.signal,
		closed: Promise.withResolvers<void>().promise,
	} as unknown as AgentSideConnection;

	const subagentEventBus = new EventBus();
	const sessions: StubSession[] = [];
	const agent = new AcpAgent(connection, async () => {
		const session = new StubSession();
		sessions.push(session);
		return { session: session as unknown as AgentSession, setToolUIContext: () => {}, subagentEventBus };
	});
	if (clientCapabilities) {
		await agent.initialize({ protocolVersion: 1, clientCapabilities } as Parameters<typeof agent.initialize>[0]);
	}
	const created = await agent.newSession({ cwd, mcpServers: [] });
	const session = sessions[0]!;
	const openDelivery = () => Bun.sleep(ACP_BOOTSTRAP_RACE_GUARD_MS + 10);
	return { agent, extNotifications, subagentEventBus, session, sessionId: created.sessionId, openDelivery };
}

function lifecycle(overrides: Partial<SubagentLifecyclePayload> & Pick<SubagentLifecyclePayload, "id" | "status">) {
	return {
		agent: "explore",
		agentSource: "bundled",
		index: 0,
		...overrides,
	} as unknown as SubagentLifecyclePayload;
}

function subagentNotifications(harness: {
	extNotifications: Array<{ method: string; params: Record<string, unknown> }>;
}) {
	return harness.extNotifications
		.filter(n => n.method === "_omp/subagents")
		.map(n => n.params as unknown as SubagentParams);
}

describe("ACP _omp/subagents snapshots", () => {
	it("advertises omp/subagents only when the client declares it", async () => {
		const connection = {
			extNotification: async () => {},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const createSession = async () => {
			throw new Error("unused");
		};
		const declared = await new AcpAgent(connection, createSession).initialize({
			protocolVersion: 1,
			clientCapabilities: SUBAGENT_CAPS,
		} as Parameters<AcpAgent["initialize"]>[0]);
		expect(declared._meta).toMatchObject({ "omp/subagents": true });
		const bare = await new AcpAgent(connection, createSession).initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as Parameters<AcpAgent["initialize"]>[0]);
		expect(bare._meta).not.toHaveProperty("omp/subagents");
	});

	it("emits full snapshots with monotonic seq, including terminal states and async completion after tool return", async () => {
		const harness = await createSubagentHarness();
		await harness.openDelivery();

		harness.subagentEventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			lifecycle({ id: "0-A", status: "started", parentToolCallId: "tool-1", description: "first", detached: true }),
		);
		harness.subagentEventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			lifecycle({ id: "1-B", status: "started", parentToolCallId: "tool-1", index: 1 }),
		);
		// Sync tool returns here; the detached child keeps running and completes afterward.
		harness.subagentEventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			lifecycle({ id: "1-B", status: "completed", parentToolCallId: "tool-1", index: 1 }),
		);
		harness.subagentEventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			lifecycle({ id: "0-A", status: "failed", parentToolCallId: "tool-1", detached: true }),
		);
		await Promise.resolve();

		const snapshots = subagentNotifications(harness);
		expect(snapshots.map(s => s.seq)).toEqual([1, 2, 3, 4]);
		expect(snapshots.every(s => s.sessionId === harness.sessionId)).toBe(true);
		expect(snapshots.every(s => s.parentToolCallId === "tool-1")).toBe(true);

		const last = snapshots[3]!;
		expect(snapshots[2]!.children.map(c => [c.id, c.status, c.async, c.description])).toEqual([
			["0-A", "running", true, "first"],
			["1-B", "completed", false, null],
		]);
		expect(last.children.map(c => [c.id, c.status, c.async, c.description])).toEqual([
			["0-A", "failed", true, "first"],
		]);
		expect(last.children.every(c => typeof c.updatedAt === "number")).toBe(true);
		// Second snapshot carries the first child still running (full state, not a delta).
		expect(snapshots[1]!.children.map(c => c.status)).toEqual(["running", "running"]);
		if (process.env.OMP_SUBAGENT_FIXTURE) {
			await Bun.write(
				process.env.OMP_SUBAGENT_FIXTURE,
				snapshots.map(snapshot => JSON.stringify(snapshot)).join("\n") + "\n",
			);
		}
	});

	it("flushes one roster snapshot with the latest seq when lifetime delivery opens", async () => {
		const harness = await createSubagentHarness();
		harness.subagentEventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ id: "0-A", status: "started" }));
		harness.subagentEventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			lifecycle({ id: "1-B", status: "started", index: 1 }),
		);
		expect(subagentNotifications(harness)).toEqual([]);
		await harness.openDelivery();
		await Promise.resolve();
		const flushed = subagentNotifications(harness);
		expect(flushed).toHaveLength(1);
		expect(flushed[0]!.seq).toBe(1);
		expect(flushed[0]!.children.map(c => [c.id, c.status])).toEqual([
			["0-A", "running"],
			["1-B", "running"],
		]);
	});

	it("omits terminal children from the snapshot after the one that reported them", async () => {
		const harness = await createSubagentHarness();
		await harness.openDelivery();
		harness.subagentEventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ id: "0-A", status: "started" }));
		harness.subagentEventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ id: "0-A", status: "completed" }));
		harness.subagentEventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			lifecycle({ id: "1-B", status: "started", index: 1 }),
		);
		await Promise.resolve();
		const snapshots = subagentNotifications(harness);
		expect(snapshots[1]!.children.map(c => [c.id, c.status])).toEqual([["0-A", "completed"]]);
		expect(snapshots[2]!.children.map(c => [c.id, c.status])).toEqual([["1-B", "running"]]);
		expect(snapshots.map(s => s.seq)).toEqual([1, 2, 3]);
	});

	it("ignores lifecycle payloads with an unknown status", async () => {
		const harness = await createSubagentHarness();
		await harness.openDelivery();
		harness.subagentEventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			lifecycle({ id: "0-A", status: "bogus" as never }),
		);
		await Promise.resolve();
		expect(subagentNotifications(harness)).toEqual([]);
	});

	it("does not emit when the client did not declare the capability", async () => {
		const harness = await createSubagentHarness({});
		await harness.openDelivery();
		harness.subagentEventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ id: "0-A", status: "started" }));
		await Promise.resolve();
		expect(subagentNotifications(harness)).toEqual([]);
	});

	it("unsubscribes the lifecycle channel on dispose", async () => {
		const harness = await createSubagentHarness();
		await harness.openDelivery();
		await harness.agent.dispose();
		harness.subagentEventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ id: "0-A", status: "started" }));
		await Promise.resolve();
		expect(subagentNotifications(harness)).toEqual([]);
		expect(harness.subagentEventBus.hasListeners(TASK_SUBAGENT_LIFECYCLE_CHANNEL)).toBe(false);
	});
});
