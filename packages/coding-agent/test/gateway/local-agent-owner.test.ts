import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { type AgentSessionGatewayHost, createAgentSessionGateway } from "../../src/gateway/agent-session-gateway";
import { LocalAgentOwnerClient } from "../../src/gateway/local-agent-owner-client";
import { LocalAgentOwnerServer } from "../../src/gateway/local-agent-owner-server";
import type { LocalAgentRefSnapshot, SequencedLocalAgentOwnerEvent } from "../../src/gateway/local-agent-owner-types";
import type { AgentSessionEventListener } from "../../src/session/agent-session";

const servers = new Set<LocalAgentOwnerServer>();
const clients = new Set<LocalAgentOwnerClient>();

afterEach(async () => {
	await Promise.all([...clients].map(client => client.close()));
	clients.clear();
	await Promise.all([...servers].map(server => server.stop()));
	servers.clear();
});

function createHost(): { host: AgentSessionGatewayHost; prompts: string[]; aborts: number[] } {
	const listeners = new Set<AgentSessionEventListener>();
	const prompts: string[] = [];
	const aborts: number[] = [];
	return {
		prompts,
		aborts,
		host: {
			isStreaming: false,
			sessionFile: "session.jsonl",
			sessionId: "session-owner",
			thinkingLevel: undefined,
			model: undefined,
			sessionManager: { getCwd: () => process.cwd() },
			subscribe: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt: async text => {
				prompts.push(text);
				return true;
			},
			steer: async () => {},
			followUp: async () => {},
			abort: async () => {
				aborts.push(Date.now());
			},
			newSession: async () => true,
		},
	};
}

async function startOwner(
	temp: TempDir,
	replayLimit = 8,
): Promise<{
	server: LocalAgentOwnerServer;
	client: LocalAgentOwnerClient;
	prompts: string[];
	aborts: number[];
}> {
	const transcriptPath = temp.join("session.jsonl");
	await fs.writeFile(transcriptPath, '{"line":1}\n{"line":2}\n{"partial":');
	const fake = createHost();
	const gateway = createAgentSessionGateway(fake.host);
	const ref: LocalAgentRefSnapshot = {
		id: "agent-owner",
		sessionId: "session-owner",
		displayName: "Remote owner",
		kind: "desktop-tag",
		cwd: temp.path(),
		status: "running",
		needsAttention: false,
	};
	const server = new LocalAgentOwnerServer({
		sessionId: "session-owner",
		agentId: "agent-owner",
		ownerId: "owner-process",
		ownerEpoch: 3,
		transcriptPath,
		tokenFilePath: temp.join("owner.token"),
		ref,
		gateway,
		replayLimit,
		heartbeatMs: 60_000,
		onRevive: async () => ({ accepted: true }),
	});
	const descriptor = server.start();
	servers.add(server);
	const client = new LocalAgentOwnerClient({ descriptor });
	clients.add(client);
	return { server, client, prompts: fake.prompts, aborts: fake.aborts };
}

describe("LocalAgentOwner protocol", () => {
	test("authenticates from the token file and rejects a wrong bearer", async () => {
		using temp = TempDir.createSync("@omp-owner-auth-");
		const owner = await startOwner(temp);
		await expect(owner.client.connect()).resolves.toMatchObject({ ownerId: "owner-process", ownerEpoch: 3 });

		const badTokenPath = temp.join("bad.token");
		await fs.writeFile(badTokenPath, "0".repeat(64));
		const attacker = new LocalAgentOwnerClient({
			descriptor: { ...owner.server.descriptor, tokenFilePath: badTokenPath },
		});
		clients.add(attacker);
		await expect(attacker.connect()).rejects.toThrow(/rejected|failed/);
	});

	test("forwards idempotent chat, abort, status, list, and revive commands", async () => {
		using temp = TempDir.createSync("@omp-owner-command-");
		const owner = await startOwner(temp);
		await owner.client.connect();
		await owner.client.chat("hello", "same-request");
		await owner.client.chat("hello", "same-request");
		expect(owner.prompts).toEqual(["hello"]);
		await owner.client.abort("abort-once");
		expect(owner.aborts).toHaveLength(1);
		await expect(owner.client.status()).resolves.toMatchObject({ sessionId: "session-owner", ownerEpoch: 3 });
		await expect(owner.client.list()).resolves.toEqual([expect.objectContaining({ id: "agent-owner" })]);
		await expect(owner.client.revive()).resolves.toEqual({ accepted: true });
		await expect(owner.client.chat("different", "same-request")).rejects.toThrow(/reused/);
		expect(owner.prompts).toEqual(["hello"]);
	});

	test("replays sequenced events and falls back to a snapshot after ring overflow", async () => {
		using temp = TempDir.createSync("@omp-owner-replay-");
		const owner = await startOwner(temp, 2);
		owner.server.publish({ type: "status", status: "idle", at: 1 });
		owner.server.publish({ type: "status", status: "running", at: 2 });
		owner.server.publish({ type: "status", status: "idle", at: 3 });
		const received = Promise.withResolvers<SequencedLocalAgentOwnerEvent>();
		owner.client.subscribe(event => {
			if (event.event.type === "snapshot") received.resolve(event);
		});
		await owner.client.connect();
		const snapshot = await received.promise;
		expect(snapshot.seq).toBeGreaterThan(3);
		expect(owner.client.lastSequence).toBe(snapshot.seq);
	});

	test("returns only complete capped transcript lines and preserves a partial tail", async () => {
		using temp = TempDir.createSync("@omp-owner-transcript-");
		const owner = await startOwner(temp);
		const chunk = await owner.client.readTranscript(0, 256);
		expect(chunk.text).toBe('{"line":1}\n{"line":2}\n');
		expect(chunk.newSize).toBe(Buffer.byteLength(chunk.text));
		expect(chunk.eof).toBe(false);
		const partial = await owner.client.readTranscript(chunk.newSize, 256);
		expect(partial).toEqual({ text: "", newSize: chunk.newSize, eof: false });
	});
});
