import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { parseSessionEntries, type SessionHeader } from "@oh-my-pi/pi-coding-agent";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

async function readSessionFile(sessionFile: string): Promise<{ header: SessionHeader; messageIds: string[] }> {
	const entries = parseSessionEntries(await Bun.file(sessionFile).text());
	return {
		header: entries[0] as SessionHeader,
		messageIds: entries.flatMap(entry => (entry.type === "message" ? [entry.id] : [])),
	};
}

describe("RPC fork", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-fork-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "fork-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
	});

	afterEach(async () => {
		await client?.stop();
		await removeWithRetries(directory);
	});

	/** Starts the agent and runs two finished turns; returns the [user, assistant, user, assistant] message entry ids. */
	async function seedTwoTurns(): Promise<string[]> {
		await client.start();
		await client.promptAndWait("first");
		await client.promptAndWait("second");
		const { entries } = await client.getEntries();
		const messageIds = entries.flatMap(entry => (entry.type === "message" ? [entry.id] : []));
		expect(messageIds).toHaveLength(4);
		return messageIds;
	}

	test("forks at an assistant entry: keeps it, drops later turns, leaves the source intact", async () => {
		const [firstUser, firstReply, ...later] = await seedTwoTurns();
		const source = await client.getState();

		expect(await client.fork(firstReply)).toEqual({ cancelled: false });

		const forked = await client.getState();
		expect(forked.sessionFile).not.toBe(source.sessionFile);
		expect(forked.sessionId).not.toBe(source.sessionId);
		// The live process continues from the cut, not just the new file.
		expect(forked.messageCount).toBe(2);
		const fork = await readSessionFile(forked.sessionFile!);
		expect(fork.messageIds).toEqual([firstUser, firstReply]);
		expect(fork.header.parentSession).toBe(source.sessionFile);
		expect((await readSessionFile(source.sessionFile!)).messageIds).toEqual([firstUser, firstReply, ...later]);
	}, 30_000);

	test("forks at a user entry and keeps that prompt as the last entry", async () => {
		const [firstUser, firstReply, secondUser] = await seedTwoTurns();

		expect(await client.fork(secondUser)).toEqual({ cancelled: false });

		const forked = await client.getState();
		expect(forked.messageCount).toBe(3);
		expect((await readSessionFile(forked.sessionFile!)).messageIds).toEqual([firstUser, firstReply, secondUser]);
	}, 30_000);

	test("without entryId forks the whole session", async () => {
		const messageIds = await seedTwoTurns();
		const source = await client.getState();

		expect(await client.fork()).toEqual({ cancelled: false });

		const forked = await client.getState();
		expect(forked.sessionFile).not.toBe(source.sessionFile);
		expect(forked.messageCount).toBe(4);
		const fork = await readSessionFile(forked.sessionFile!);
		expect(fork.messageIds).toEqual(messageIds);
		// Whole-session forks record the parent by session id (SessionManager.fork()).
		expect(fork.header.parentSession).toBe(source.sessionId);
	}, 30_000);

	test("rejects ids that are not transcript messages without switching sessions", async () => {
		await seedTwoTurns();
		await client.setThinkingLevel(ThinkingLevel.High);
		const source = await client.getState();
		const { entries } = await client.getEntries();
		const nonMessage = entries.find(entry => entry.type === "thinking_level_change");
		expect(nonMessage).toBeDefined();

		await expect(client.fork("no-such-entry")).rejects.toThrow(/Invalid entry ID for forking/);
		await expect(client.fork(nonMessage!.id)).rejects.toThrow(/Invalid entry ID for forking/);
		expect((await client.getState()).sessionFile).toBe(source.sessionFile);
	}, 30_000);

	test("refuses while a turn is streaming", async () => {
		const [, firstReply] = await seedTwoTurns();
		const source = await client.getState();
		const idle = Promise.withResolvers<void>();
		const unsubscribe = client.onEvent(event => {
			if (event.type === "agent_end") idle.resolve();
		});
		try {
			await client.prompt("slow");
			expect((await client.getState()).isStreaming).toBe(true);

			await expect(client.fork(firstReply)).rejects.toMatchObject({ command: "fork", code: "session_busy" });

			await withTimeout(idle.promise, 10_000, "Streaming turn did not finish");
		} finally {
			unsubscribe();
		}
		expect((await client.getState()).sessionFile).toBe(source.sessionFile);
	}, 30_000);
});
