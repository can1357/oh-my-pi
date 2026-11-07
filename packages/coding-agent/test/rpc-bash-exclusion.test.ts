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
	let command: string[];

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-bash-exclusion-"));
		command = [process.execPath, path.join(import.meta.dir, "fixtures", "bash-rpc-agent.ts")];
		client = new RpcClient({
			command,
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
	});

	afterEach(async () => {
		await client.stop();
		await removeWithRetries(directory);
	});

	test("returns and records excluded output but keeps it out of model context", async () => {
		await client.start();
		expect((await client.bash("printf shared-marker")).output).toBe("shared-marker");
		expect((await client.bash("printf private-marker", { excludeFromContext: true })).output).toBe("private-marker");

		const messages = await client.getMessages();
		const executions = messages.filter(message => message.role === "bashExecution");
		expect(executions.map(message => message.output)).toEqual(["shared-marker", "private-marker"]);
		const modelContext = JSON.stringify(convertToLlm(messages));
		expect(modelContext).toContain("shared-marker");
		expect(modelContext).not.toContain("private-marker");
	}, 30_000);

	test("rejects a non-boolean exclusion before running the command", async () => {
		await client.start();
		const failure = await client
			.bash("printf leaked > refused.txt", { excludeFromContext: "true" as unknown as boolean })
			.catch((error: unknown) => error);
		expect(String(failure)).toContain("excludeFromContext must be a boolean");
		expect(await Bun.file(path.join(directory, "refused.txt")).exists()).toBe(false);
		expect(await client.getMessages()).toEqual([]);
	}, 30_000);

	test("refuses exclusion after restarting against a runtime that does not advertise it", async () => {
		await client.start();
		await client.bash("printf first-runtime", { excludeFromContext: true });
		await client.stop();
		command[1] = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");
		await client.start();
		await expect(client.bash("printf private", { excludeFromContext: true })).rejects.toThrow(
			"RPC runtime does not support bash context exclusion",
		);
	}, 30_000);
});
