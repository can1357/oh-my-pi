/**
 * Event port: each in-run source the capability wait must settle on —
 * background jobs, subagent tasks, owned services, inbox arrivals, and owed
 * replies — lands one completion record in the capability channel store
 * (`completions.jsonl`, the landed capability-replicas shape:
 * mastra/src/capability/channel/store.ts), where a channel-store consumer
 * (`pendingFor`) sees the completion. This is the byte-compat claim's omp
 * side: the zero-arg capability wait settles on these records exactly where
 * the built-in wait settled in-process (design §5/§8).
 */
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import {
	type CapabilityChannelRecord,
	channelIdentity,
	completionsChannelFilePath,
	ensureCapabilitySessionRecord,
	jobCompletionEvent,
	readChannelRecords,
	recordChannelCompletion,
	sessionRecordFilePath,
} from "@oh-my-pi/pi-coding-agent/channels/records";
import {
	CAPABILITY_SERVER_NAME,
	CAPABILITY_WAIT_TOOL_NAME,
	isCapabilityWaitTool,
	isInterruptibleCapabilityWaitCall,
	setCapabilityCommandResolverForTests,
} from "@oh-my-pi/pi-coding-agent/discovery/capability-server";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { recordServiceCompletion } from "@oh-my-pi/pi-coding-agent/launch/services";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SESSION_ID = "sess-event-port";
const CHECKOUT = "/checkout/event-port";
const identity = channelIdentity(SESSION_ID, CHECKOUT);

/** Every completion record the store holds must carry the landed shape. */
function expectWellFormed(record: CapabilityChannelRecord): void {
	expect(record.id).toMatch(/^c-[0-9a-f]{12}$/);
	expect(record.kind).toBe("completion");
	expect(record.channel).toBe("completions");
	expect(record.to).toBe(SESSION_ID);
	expect(record.from).toBe("omp");
	expect(record.subject.length).toBeGreaterThan(0);
	expect(record.body).toBeTypeOf("string");
	expect(Number.isInteger(record.created_at)).toBe(true);
	expect(record.created_at).toBeGreaterThan(0);
	expect(record.expires_at).toBeUndefined();
	expect(record.about?.type).toBeTypeOf("string");
	expect(record.about?.id.length ?? "").toBeGreaterThan(0);
}

describe("capability event port", () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-capability-channels-"));
		// Tests stay off the real machine store: pointing the state dir at a
		// temp directory also opts the recording gate on for this run.
		process.env.OMP_CAPABILITY_STATE_DIR = stateDir;
		// Fake the capability CLI so the port records without the binary.
		setCapabilityCommandResolverForTests(() => "/usr/local/bin/capability");
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(() => {
		delete process.env.OMP_CAPABILITY_STATE_DIR;
		setCapabilityCommandResolverForTests();
		fs.rmSync(stateDir, { recursive: true, force: true });
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a channel-store consumer sees a settled job and a settled subagent task", async () => {
		// The sdk wires the root manager's settle observer exactly this way.
		const manager = new AsyncJobManager({
			onJobComplete: () => {},
			onJobSettled: job => recordChannelCompletion(identity, jobCompletionEvent(job)),
		});
		manager.register("bash", "npm run build", async () => "built", { ownerId: "Main" });
		manager.register("task", "EchoPeer", async () => "received", {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		await manager.waitForAll();

		const records = readChannelRecords(SESSION_ID);
		expect(records).toHaveLength(2);
		for (const record of records) expectWellFormed(record);
		const job = records.find(record => record.about?.type === "job");
		const task = records.find(record => record.about?.type === "task");
		expect(job?.subject).toContain("npm run build");
		expect(job?.about?.state).toBe("completed");
		expect(task?.subject).toContain("EchoPeer");
		expect(task?.about?.state).toBe("completed");
	});

	test("a failed job records its failure outcome", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: () => {},
			onJobSettled: job => recordChannelCompletion(identity, jobCompletionEvent(job)),
		});
		manager.register(
			"bash",
			"failing",
			async () => {
				throw new Error("boom");
			},
			{ ownerId: "Main" },
		);
		await manager.waitForAll();

		const records = readChannelRecords(SESSION_ID);
		expect(records).toHaveLength(1);
		expectWellFormed(records[0]);
		expect(records[0].about?.type).toBe("job");
		expect(records[0].about?.state).toBe("failed");
	});

	test("an owned service's terminal state lands in the channel", () => {
		const session = { cwd: CHECKOUT, getSessionId: () => SESSION_ID } as never;
		const daemon = {
			name: "dev-server",
			state: "exited",
			exitCode: 0,
			startedAt: Date.now(),
			createdAt: Date.now(),
		} as DaemonSnapshot;
		recordServiceCompletion(session, daemon);
		// A non-terminal state is not a completion the wait can settle on.
		recordServiceCompletion(session, { ...daemon, name: "still-running", state: "running" } as DaemonSnapshot);

		const records = readChannelRecords(SESSION_ID);
		expect(records).toHaveLength(1);
		expectWellFormed(records[0]);
		expect(records[0].about?.type).toBe("service");
		expect(records[0].subject).toBe("dev-server");
		expect(records[0].about?.state).toBe("exited");
		expect(records[0].about?.exit_code).toBe(0);
	});

	test("an inbox arrival and an owed reply both land in the recipient's channel", async () => {
		const registry = AgentRegistry.global();
		const mainSession = {
			sessionId: SESSION_ID,
			runStartedAt: Date.now(),
			isStreaming: true,
			deliverIrcMessage: async () => "injected" as const,
		} as never;
		const peerSession = {
			sessionId: "sess-peer",
			runStartedAt: Date.now(),
			isStreaming: true,
			deliverIrcMessage: async () => "injected" as const,
		} as never;
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: mainSession, status: "running" });
		registry.register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			parentId: "Main",
			session: peerSession,
			status: "running",
		});
		const bus = IrcBus.global();

		await bus.send({ from: "Peer", to: "Main", body: "a fresh message" });
		await bus.send({ from: "Main", to: "Peer", body: "a question" });
		await bus.send({ from: "Peer", to: "Main", body: "the answer" });

		const records = readChannelRecords(SESSION_ID);
		for (const record of records) expectWellFormed(record);
		const types = records.map(record => record.about?.type);
		expect(types).toContain("inbox");
		expect(types).toContain("reply");
		const reply = records.find(record => record.about?.type === "reply");
		expect(reply?.subject).toContain("Peer");
		// The Peer's own channel holds the message Main sent it, not Main's.
		const peerRecords = readChannelRecords("sess-peer");
		expect(peerRecords).toHaveLength(1);
		// Main's question answers Peer's earlier direct message in the same
		// sense the built-in wait used: any direct send back resolves the debt.
		expect(peerRecords[0].about?.type).toBe("reply");
		// Every record addressed to the session lives in the one completions file.
		expect(fs.existsSync(completionsChannelFilePath())).toBe(true);
	});

	test("the omp session record mirrors the capability boot reader's shape", () => {
		ensureCapabilitySessionRecord(identity);
		const raw = fs.readFileSync(sessionRecordFilePath(SESSION_ID), "utf8");
		const record = JSON.parse(raw) as Record<string, unknown>;
		expect(record).toMatchObject({
			id: SESSION_ID,
			harness: "omp",
			cwd: CHECKOUT,
		});
		expect(Number.isInteger(record.started_at)).toBe(true);
		expect(Number.isInteger(record.pid)).toBe(true);
		// Absent when the record exists: the capability server's own boot
		// writer (startSession) owns the authoritative record.
		const before = fs.statSync(sessionRecordFilePath(SESSION_ID)).mtimeMs;
		ensureCapabilitySessionRecord(channelIdentity(SESSION_ID, "/another-checkout"));
		expect(fs.statSync(sessionRecordFilePath(SESSION_ID)).mtimeMs).toBe(before);
	});

	test("no capability CLI means no records", async () => {
		setCapabilityCommandResolverForTests(() => null);
		const manager = new AsyncJobManager({
			onJobComplete: () => {},
			onJobSettled: job => recordChannelCompletion(identity, jobCompletionEvent(job)),
		});
		manager.register("bash", "unrecorded", async () => "done", { ownerId: "Main" });
		await manager.waitForAll();
		expect(readChannelRecords(SESSION_ID)).toHaveLength(0);
	});
});

describe("capability wait steering surface", () => {
	test("the capability wait is the interruptible MCP tool; arm and cancel are not", () => {
		// The real server publishes agentmux_capability_<name> (snapshot fixture),
		// so the wait is not addressed as plain "wait" anywhere in omp.
		expect(isCapabilityWaitTool(CAPABILITY_SERVER_NAME, CAPABILITY_WAIT_TOOL_NAME)).toBe(true);
		expect(isCapabilityWaitTool(CAPABILITY_SERVER_NAME, "wait")).toBe(false);
		expect(isCapabilityWaitTool(CAPABILITY_SERVER_NAME, "run_command")).toBe(false);
		expect(isCapabilityWaitTool("other-server", CAPABILITY_WAIT_TOOL_NAME)).toBe(false);
		// `{}` is the whole zero-arg call — it must be cancellable by steering.
		expect(isInterruptibleCapabilityWaitCall({})).toBe(true);
		expect(isInterruptibleCapabilityWaitCall({ action: "wait" })).toBe(true);
		expect(isInterruptibleCapabilityWaitCall({ action: "status" })).toBe(true);
		expect(isInterruptibleCapabilityWaitCall({ action: "arm", until: { type: "timer", seconds: 5 } })).toBe(false);
		expect(isInterruptibleCapabilityWaitCall({ action: "cancel", wait_id: "w1" })).toBe(false);
	});
});
