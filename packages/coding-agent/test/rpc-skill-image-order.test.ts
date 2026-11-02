import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcPromptResultFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { ONE_PIXEL_PNG as PNG, waitForFile } from "./helpers/skill-image-vision";

function submissionOrder(messages: AgentMessage[]): string[] {
	return messages.flatMap(message => {
		if (message.role === "custom" && message.customType === "skill-prompt") return ["skill"];
		if (message.role !== "user") return [];
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map(part => (part.type === "text" ? part.text : "")).join("");
		return [text];
	});
}

let client: RpcClient;
let directory: string;

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-skill-image-"));
	client = new RpcClient({
		command: [process.execPath, path.join(import.meta.dir, "fixtures", "skill-image-rpc-agent.ts")],
		cwd: directory,
		env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
	});
	await client.start();
});

afterEach(async () => {
	await client?.stop();
	await removeWithRetries(directory);
});

test("a later prompt does not overtake an idle image skill while its image is described", async () => {
	const results = new Map<string, RpcPromptResultFrame>();
	const bothSettled = Promise.withResolvers<void>();
	const unsubscribe = client.onPromptResult(frame => {
		if (frame.id) results.set(frame.id, frame);
		if (results.size === 2) bothSettled.resolve();
	});
	try {
		const skill = client.prompt("/skill:look what is this?", [{ type: "image", data: PNG, mimeType: "image/png" }]);
		// The skill is acknowledged only after admission, which waits for the held vision request.
		// An acknowledgement first means the vision path never ran, so fail now instead of at the test timeout.
		let visionStarted = false;
		await Promise.race([
			waitForFile(path.join(directory, "vision-started")).then(() => {
				visionStarted = true;
			}),
			skill.then(() => {
				if (!visionStarted) throw new Error("skill was admitted without starting a vision description request");
			}),
		]);
		const second = client.prompt("second", undefined, "followUp");
		// get_state runs on the serial queue after the second prompt was accepted and handed to the input gate.
		await client.getState();
		await Bun.write(path.join(directory, "vision-release"), "");
		await Promise.all([skill, second]);
		await bothSettled.promise;
	} finally {
		unsubscribe();
	}
	expect([...results.values()].map(result => result.status)).toEqual(["completed", "completed"]);
	expect(submissionOrder(await client.getMessages())).toEqual(["skill", "second"]);
}, 30_000);
