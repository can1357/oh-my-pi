import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";

describe("RPC get_session_lease", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-lease-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "fork-rpc-agent.ts"), directory],
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

	test("reports the session the RPC process writes as held and other ids as free", async () => {
		await client.start();
		await client.promptAndWait("first");
		const { sessionId } = await client.getState();

		expect(await client.getSessionLease([sessionId, `free-${sessionId}`, "../../etc/passwd", ""])).toEqual({
			held: [sessionId],
			unknown: [],
		});
	}, 30_000);

	test("rejects sessionIds that are not an array of strings", async () => {
		await client.start();

		expect(await rejectionOf(client.getSessionLease(["ok", 7] as unknown as string[]))).toMatchObject({
			message: expect.stringMatching(/sessionIds must be an array of strings/),
		});
	}, 30_000);
});
