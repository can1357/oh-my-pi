import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	killAgent,
	listAgents,
	reviveAgent,
	sendAgentMessage,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-agent-hub";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import {
	type AgentKind,
	AgentRegistry,
	type AgentStatus,
	getAgentTombstonePath,
	MAIN_AGENT_ID,
	type RegisterInput,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { TempDir } from "@oh-my-pi/pi-utils";

interface SessionStub {
	session: AgentSession;
	prompts: Array<{ text: string; options: unknown }>;
	aborts: Array<{ reason?: string } | undefined>;
}

function makeSessionStub(): SessionStub {
	const prompts: Array<{ text: string; options: unknown }> = [];
	const aborts: Array<{ reason?: string } | undefined> = [];
	const stub = {
		prompt: async (text: string, options?: unknown) => {
			prompts.push({ text, options });
		},
		abort: async (options?: { reason?: string }) => {
			aborts.push(options);
		},
		dispose: async () => {},
	};
	return { session: stub as unknown as AgentSession, prompts, aborts };
}

describe("RPC Agent Hub control", () => {
	let registry: AgentRegistry;
	let lifecycle: AgentLifecycleManager;
	let deps: { registry: AgentRegistry; lifecycle: AgentLifecycleManager };

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registry = AgentRegistry.global();
		lifecycle = AgentLifecycleManager.global();
		deps = { registry, lifecycle };
	});

	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function register(input: {
		id: string;
		kind?: AgentKind;
		parentId?: string;
		status?: AgentStatus;
		session?: AgentSession | null;
		sessionFile?: string | null;
		lastActivity?: number;
		displayName?: string;
	}) {
		const payload: RegisterInput = {
			id: input.id,
			displayName: input.displayName ?? input.id,
			kind: input.kind ?? "sub",
			parentId: input.parentId,
			status: input.status ?? "idle",
			session: input.session === undefined ? makeSessionStub().session : input.session,
			sessionFile: input.sessionFile,
			lastActivity: input.lastActivity,
		};
		return registry.register(payload);
	}

	test("listAgents hides Main and includes nested children plus advisors", () => {
		register({ id: MAIN_AGENT_ID, kind: "main", displayName: "Main" });
		register({ id: "worker", lastActivity: 20 });
		register({ id: "nested", parentId: "worker", lastActivity: 10 });
		register({ id: "review", kind: "advisor", lastActivity: 5 });
		register({ id: "parked-child", parentId: "worker", status: "parked", session: null, lastActivity: 1 });

		const agents = listAgents(deps);
		expect(agents.map(agent => agent.id)).toEqual(["worker", "nested", "review", "parked-child"]);
		expect(agents.find(agent => agent.id === "nested")?.parentId).toBe("worker");
		expect(agents.find(agent => agent.id === "review")).toMatchObject({
			kind: "advisor",
			live: true,
		});
		expect(agents.find(agent => agent.id === "parked-child")).toMatchObject({
			parentId: "worker",
			status: "parked",
			live: false,
		});
	});

	test("listAgents sorts by Hub status then recency", () => {
		register({ id: "aborted-old", status: "aborted", session: null, lastActivity: 400 });
		register({ id: "parked-new", status: "parked", session: null, lastActivity: 300 });
		register({ id: "idle-new", status: "idle", lastActivity: 200 });
		register({ id: "running-old", status: "running", lastActivity: 50 });
		register({ id: "running-new", status: "running", lastActivity: 100 });

		expect(listAgents(deps).map(agent => agent.id)).toEqual([
			"running-new",
			"running-old",
			"idle-new",
			"parked-new",
			"aborted-old",
		]);
	});

	test("sendAgentMessage steers a live agent without parking it", async () => {
		const stub = makeSessionStub();
		register({ id: "worker", session: stub.session, status: "idle" });

		const result = await sendAgentMessage("worker", "  keep going  ", deps);
		expect(result).toMatchObject({ ok: true, agent: { id: "worker", live: true } });
		expect(stub.prompts).toEqual([{ text: "keep going", options: { streamingBehavior: "steer" } }]);
		expect(stub.aborts).toEqual([]);
	});

	test("sendAgentMessage revives a parked agent then steers it", async () => {
		const revived = makeSessionStub();
		register({ id: "worker", status: "parked", session: null, sessionFile: "/tmp/worker.jsonl" });
		lifecycle.adopt("worker", { idleTtlMs: 0, revive: async () => revived.session });

		const result = await sendAgentMessage("worker", "resume", deps);
		expect(result).toMatchObject({ ok: true, agent: { id: "worker", status: "idle", live: true } });
		expect(revived.prompts).toEqual([{ text: "resume", options: { streamingBehavior: "steer" } }]);
	});

	test("control commands reject Main, advisors, unknown ids, and empty steer text", async () => {
		register({ id: MAIN_AGENT_ID, kind: "main" });
		register({ id: "advisor-1", kind: "advisor" });
		register({ id: "worker" });

		await expect(sendAgentMessage(MAIN_AGENT_ID, "hi", deps)).resolves.toMatchObject({
			ok: false,
			code: "main_forbidden",
		});
		await expect(killAgent(MAIN_AGENT_ID, deps)).resolves.toMatchObject({ ok: false, code: "main_forbidden" });
		await expect(sendAgentMessage("advisor-1", "hi", deps)).resolves.toMatchObject({
			ok: false,
			code: "advisor_readonly",
		});
		await expect(reviveAgent("advisor-1", deps)).resolves.toMatchObject({ ok: false, code: "advisor_readonly" });
		await expect(killAgent("missing", deps)).resolves.toMatchObject({ ok: false, code: "unknown_agent" });
		await expect(sendAgentMessage("worker", "   ", deps)).resolves.toMatchObject({
			ok: false,
			code: "empty_message",
		});
		await expect(sendAgentMessage("", "hi", deps)).resolves.toMatchObject({ ok: false, code: "invalid_agent_id" });
	});

	test("reviveAgent restores a parked agent through its reviver", async () => {
		const revived = makeSessionStub();
		register({ id: "worker", status: "parked", session: null, sessionFile: "/tmp/worker.jsonl" });
		lifecycle.adopt("worker", { idleTtlMs: 0, revive: async () => revived.session });

		const result = await reviveAgent("worker", deps);
		expect(result).toMatchObject({ ok: true, agent: { id: "worker", status: "idle", live: true } });
		expect(registry.get("worker")?.session).toBe(revived.session);
		expect(revived.prompts).toEqual([]);
	});

	test("killAgent aborts a running session and writes a tombstone", async () => {
		using dir = TempDir.createSync("@omp-rpc-agent-hub-kill-");
		const sessionFile = path.join(dir.path(), "worker.jsonl");
		await Bun.write(sessionFile, "{}\n");
		const stub = makeSessionStub();
		register({ id: "worker", status: "running", session: stub.session, sessionFile });

		const result = await killAgent("worker", deps);
		expect(result).toMatchObject({
			ok: true,
			agent: { id: "worker", status: "aborted", live: false, sessionFile },
		});
		expect(stub.aborts).toEqual([{ reason: USER_INTERRUPT_LABEL }]);
		expect(await Bun.file(getAgentTombstonePath(sessionFile)).exists()).toBe(true);
		expect(registry.get("worker")?.status).toBe("aborted");
		expect(registry.get("worker")?.session).toBeNull();
	});

	test("killAgent tombstones a parked agent without aborting a session", async () => {
		using dir = TempDir.createSync("@omp-rpc-agent-hub-parked-kill-");
		const sessionFile = path.join(dir.path(), "worker.jsonl");
		await Bun.write(sessionFile, "{}\n");
		register({ id: "worker", status: "parked", session: null, sessionFile });

		const result = await killAgent("worker", deps);
		expect(result).toMatchObject({ ok: true, agent: { id: "worker", status: "aborted", live: false } });
		expect(await Bun.file(getAgentTombstonePath(sessionFile)).exists()).toBe(true);
	});
});
