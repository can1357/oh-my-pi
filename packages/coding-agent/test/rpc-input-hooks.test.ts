import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcPromptResultFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function userTexts(messages: AgentMessage[]): string[] {
	return messages.flatMap(message => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return [message.content.map(part => (part.type === "text" ? part.text : "")).join("")];
	});
}

describe("RPC native input handlers", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-input-hook-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "input-hook-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
		await client.start();
	});

	afterEach(async () => {
		await client?.stop();
		await removeWithRetries(directory);
	});

	test("a handled prompt completes locally and never reaches the agent", async () => {
		const events = await client.promptAndWait("consume: secret");
		expect(events.some(event => event.type === "agent_start")).toBe(false);
		expect(userTexts(await client.getMessages())).toEqual([]);
	}, 30_000);

	test("handler-transformed text reaches the agent verbatim", async () => {
		await client.promptAndWait("transform: raw");
		expect(userTexts(await client.getMessages())).toEqual(["  transformed by hook\n"]);
	}, 30_000);

	test("a later prompt does not overtake an earlier one whose handler is still running", async () => {
		const results = new Map<string, RpcPromptResultFrame>();
		const bothSettled = Promise.withResolvers<void>();
		const unsubscribe = client.onPromptResult(frame => {
			if (frame.id) results.set(frame.id, frame);
			if (results.size === 2) bothSettled.resolve();
		});
		try {
			await Promise.all([client.prompt("slow: first"), client.prompt("second", undefined, "followUp")]);
			await bothSettled.promise;
		} finally {
			unsubscribe();
		}
		expect(userTexts(await client.getMessages())).toEqual(["slow: first", "second"]);
	}, 30_000);

	test("a prompt pipelined after new_session runs in the new session instead of being dropped", async () => {
		await client.promptAndWait("before reset");
		const [, events] = await Promise.all([client.newSession(), client.promptAndWait("after reset")]);
		expect(events.some(event => event.type === "agent_start")).toBe(true);
		expect(userTexts(await client.getMessages())).toEqual(["after reset"]);
	}, 30_000);
});
