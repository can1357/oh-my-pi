/**
 * Regression: a spawned agent's `name` is its address.
 *
 * The spawn pipeline reserves the name as the agent id (`task` tool `name` →
 * identity label → {@link reserveStructuredSubagentId}, and a provided id
 * wins), and a cold-revived transcript registers `displayName` equal to its
 * id. Both facts are load-bearing for `agent://<name>` delivery: the registry
 * resolves by id only, so any drift between name and id would silently route
 * a message to nobody. Upstream has no rename path; these tests pin the
 * invariant so a future one cannot break addressing unnoticed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { reserveStructuredSubagentId } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { TempDir } from "@oh-my-pi/pi-utils";

/** A session stand-in whose only spawn-relevant surface is the artifacts directory. */
function toolSession(artifactsDir: string): never {
	return { getArtifactsDir: () => artifactsDir } as never;
}

function makeFakeSession(): { session: AgentSession; delivered: IrcMessage[] } {
	const delivered: IrcMessage[] = [];
	const session = {
		isStreaming: true,
		deliverIrcMessage: async (msg: IrcMessage) => {
			delivered.push(msg);
			return "injected" as const;
		},
		emitIrcRelayObservation: () => {},
	};
	return { session: session as unknown as AgentSession, delivered };
}

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-11-05T00:00:00.000Z",
		cwd: "/tmp",
	});
}

describe("agent name == agent id", () => {
	let registry: AgentRegistryApi;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
	});

	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
	});

	it("a spawn name is the id that agent://<name> delivers to", async () => {
		using tempDir = TempDir.createSync("@omp-name-id-");
		const session = toolSession(tempDir.path());

		const name = await reserveStructuredSubagentId(session, { label: "PeerName" });
		expect(name).toBe("PeerName");
		// A second spawn asking for a taken name gets a distinct address, never a
		// shared one: both are still addressed by the id the caller is handed.
		const second = await reserveStructuredSubagentId(session, { label: "PeerName" });
		expect(second).toBe("PeerName-2");
		// A caller-provided id (the batch path pre-reserves one) wins over the label.
		expect(await reserveStructuredSubagentId(session, { id: "Reserved", label: "Ignored" })).toBe("Reserved");

		const peer = makeFakeSession();
		registry.register({ id: name, displayName: "PeerName", kind: "sub", session: peer.session });
		registry.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: makeFakeSession().session });

		const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: name, body: "hello peer" });
		expect(receipt).toEqual({ to: "PeerName", outcome: "injected" });
		expect(peer.delivered.map(msg => msg.body)).toEqual(["hello peer"]);
	});

	it("a cold-revived transcript registers its name as its id, and that name stays addressable", async () => {
		using tempDir = TempDir.createSync("@omp-name-revive-");
		const dir = tempDir.path();
		await Bun.write(path.join(dir, "main.jsonl"), `${sessionHeader("main")}\n`);
		await Bun.write(
			path.join(dir, "main", "WakeWorker.jsonl"),
			`${[
				sessionHeader("wake-worker"),
				JSON.stringify({
					type: "session_init",
					id: "si",
					parentId: null,
					timestamp: "2026-11-05T00:00:01.000Z",
					systemPrompt: "review",
					task: "review the diff",
					tools: ["read"],
				}),
			].join("\n")}\n`,
		);

		await registerPersistedSubagents(registry, path.join(dir, "main.jsonl"));

		const revived = registry.get("WakeWorker");
		expect(revived?.status).toBe("parked");
		// The invariant: the display name of a cold-revived ref is its id, so the
		// name an operator sees is the `agent://<name>` address that resolves.
		expect(revived?.displayName).toBe(revived?.id);

		const session = makeFakeSession();
		AgentLifecycleManager.global().adopt("WakeWorker", {
			idleTtlMs: 0,
			revive: async () => session.session,
		});
		registry.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: makeFakeSession().session });

		const receipt = await IrcBus.global().send({
			from: MAIN_AGENT_ID,
			to: revived!.displayName!,
			body: "resume the review",
		});
		expect(receipt.outcome).toBe("revived");
		expect(session.delivered.map(msg => msg.body)).toEqual(["resume the review"]);
	});
});
