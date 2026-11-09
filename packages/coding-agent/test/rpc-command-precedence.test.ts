import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("RPC goal slash command precedence", () => {
	test.each([
		["extension", "goal", "budget 0100"],
		["extension", "guided-goal", "ship the user command"],
		["custom", "goal", "budget 0100"],
		["custom", "guided-goal", "ship the user command"],
	])(
		"dispatches advertised %s /%s instead of the RPC builtin",
		async (source, name, args) => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-goal-collision-"));
			const client = new RpcClient({
				command: [process.execPath, path.join(import.meta.dir, "fixtures", "goal-command-collision-rpc-agent.ts")],
				cwd: directory,
				env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1", GOAL_COMMAND_SOURCE: source },
			});
			try {
				await client.start();
				const commands = await client.getAvailableCommands();
				expect(commands.filter(command => command.name === name)).toEqual([
					expect.objectContaining({ name, description: `User ${name}`, source }),
				]);
				await client.promptAndWait(`/${name} ${args}`);
				const messages = await client.getMessages();
				const userTexts = messages.flatMap(message => {
					if (message.role !== "user") return [];
					if (typeof message.content === "string") return [message.content];
					return [message.content.map(part => (part.type === "text" ? part.text : "")).join("")];
				});
				expect(userTexts).toEqual([`user-command:${name}:${args}`]);
			} finally {
				await client.stop();
				await removeWithRetries(directory);
			}
		},
		30_000,
	);
});
