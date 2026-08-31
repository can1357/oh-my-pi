import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

describe("RpcClient.start", () => {
	test("rejects when RPC process exits immediately", async () => {
		using client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
			cwd: path.join(import.meta.dir, ".."),
			provider: "__missing_provider__",
			model: "claude-sonnet-4-5",
			env: { PI_NO_TITLE: "1" },
		});

		await expect(client.start()).rejects.toThrow(/Unknown provider.*__missing_provider__/);
	});
	test("launcher builder receives the complete agent argv", async () => {
		let received: string[] | undefined;
		using client = new RpcClient({
			command: args => {
				received = args;
				return ["/usr/bin/false"];
			},
			provider: "openrouter",
			model: "example/model",
			args: ["--no-session"],
		});

		await expect(client.start()).rejects.toThrow(/exited with code 1/);
		expect(received).toEqual([
			"--mode",
			"rpc",
			"--provider",
			"openrouter",
			"--model",
			"example/model",
			"--no-session",
		]);
	});
});
