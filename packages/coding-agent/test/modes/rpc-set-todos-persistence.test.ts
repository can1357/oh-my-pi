import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let client: RpcClient;
let directory: string;

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-todos-"));
	client = new RpcClient({
		command: [process.execPath, path.join(import.meta.dir, "..", "fixtures", "fork-rpc-agent.ts"), directory],
		cwd: directory,
		env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
	});
});

afterEach(async () => {
	const ownClient = client;
	const ownDirectory = directory;
	await ownClient?.stop();
	await removeWithRetries(ownDirectory);
});

it("restores RPC todo edits and explicit clears after reloading the session", async () => {
	await client.start();
	await client.promptAndWait("seed");
	const { sessionFile } = await client.getState();
	if (!sessionFile) throw new Error("expected a persisted session file");
	const phases: TodoPhase[] = [{ name: "Plan", tasks: [{ content: "Review changes", status: "pending" }] }];

	await client.setTodos(phases);
	await client.switchSession(sessionFile);
	expect((await client.getState()).todoPhases).toEqual(phases);

	await client.setTodos([]);
	await client.switchSession(sessionFile);
	expect((await client.getState()).todoPhases).toEqual([]);
}, 30_000);
