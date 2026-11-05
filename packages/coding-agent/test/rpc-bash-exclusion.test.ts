import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("RPC bash context exclusion", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-bash-exclusion-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "bash-rpc-agent.ts")],
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

	test("returns and records every output but keeps excluded commands out of model context", async () => {
		await client.start();
		const state = await client.getState();
		expect(state.supportsBashExcludeFromContext).toBe(true);
		const ordinary = await client.bash("printf default-context-marker");
		const shared = await client.bash("printf explicit-context-marker", { excludeFromContext: false });
		const excluded = await client.bash("printf private-output-marker", { excludeFromContext: true });
		for (const [result, output] of [
			[ordinary, "default-context-marker"],
			[shared, "explicit-context-marker"],
			[excluded, "private-output-marker"],
		] as const) {
			expect(result.output).toBe(output);
			expect(result.exitCode).toBe(0);
		}

		const messages = await client.getMessages();
		const executions = messages.filter(message => message.role === "bashExecution");
		expect(executions.map(message => message.output)).toEqual([
			"default-context-marker",
			"explicit-context-marker",
			"private-output-marker",
		]);
		expect(executions[2]?.excludeFromContext).toBe(true);
		const modelContext = JSON.stringify(convertToLlm(messages));
		expect(modelContext).toContain("default-context-marker");
		expect(modelContext).toContain("explicit-context-marker");
		expect(modelContext).not.toContain("private-output-marker");
	}, 30_000);

	test("rejects non-boolean exclusion before executing or recording the command", async () => {
		await client.start();
		for (const invalid of ["true", null]) {
			await expect(
				client.bash("printf leaked > refused.txt", { excludeFromContext: invalid as unknown as boolean }),
			).rejects.toThrow("excludeFromContext must be a boolean");
		}
		expect(await Bun.file(path.join(directory, "refused.txt")).exists()).toBe(false);
		expect(await client.getMessages()).toEqual([]);
	}, 30_000);
});

test("RpcClient refuses excluded execution on runtimes without the capability", async () => {
	const client = new RpcClient({
		command: [process.execPath, path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts")],
	});
	try {
		await client.start();
		await expect(client.bash("printf private", { excludeFromContext: true })).rejects.toThrow(
			"RPC runtime does not support bash context exclusion",
		);
	} finally {
		await client.stop();
	}
}, 30_000);
