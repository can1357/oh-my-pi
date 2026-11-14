/**
 * Manual compaction reports `manual_compaction_start`/`manual_compaction_end` to an RPC host.
 * Drives a real SDK session in `runRpcMode` over the RPC client; only the model is scripted
 * (`fixtures/progress-events-rpc-agent.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const FIXTURE = path.join(import.meta.dir, "fixtures", "progress-events-rpc-agent.ts");

let client: RpcClient | undefined;
let directory: string | undefined;

afterEach(async () => {
	await client?.stop();
	client = undefined;
	if (directory) await removeWithRetries(directory);
	directory = undefined;
});

/** Start the fixture and record every session event frame it writes. */
async function start(): Promise<{ rpc: RpcClient; events: AgentSessionEvent[] }> {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-progress-"));
	client = new RpcClient({
		command: [process.execPath, FIXTURE],
		cwd: directory,
		env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
	});
	const events: AgentSessionEvent[] = [];
	client.onSessionEvent(event => events.push(event));
	await client.start();
	return { rpc: client, events };
}

describe("RPC progress events", () => {
	test("manual compact emits manual_compaction_start and manual_compaction_end", async () => {
		const { rpc, events } = await start();
		await rpc.promptAndWait("first turn");
		await rpc.promptAndWait("second turn");

		const committed = await rpc.compact();
		expect(committed.summary).toBe("compacted by the test hook");
		const pair = events.filter(event => event.type.startsWith("manual_compaction_"));
		expect(pair).toEqual([
			{ type: "manual_compaction_start" },
			{ type: "manual_compaction_end", aborted: false, result: committed },
		]);
		// Automatic compaction keeps its own pair; a manual one never reports through it.
		expect(events.some(event => event.type.startsWith("auto_compaction_"))).toBe(false);

		// Nothing left to compact: the command fails and the pair still closes, as skipped.
		events.length = 0;
		expect(String(await rpc.compact().catch((error: unknown) => error))).toContain("Already compacted");
		expect(events.filter(event => event.type.startsWith("manual_compaction_"))).toEqual([
			{ type: "manual_compaction_start" },
			{ type: "manual_compaction_end", aborted: false, skipped: true, errorMessage: "Already compacted" },
		]);
	}, 60_000);
});
