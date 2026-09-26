import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as piUtils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";

async function writeSessionWithoutUsage(dir: string): Promise<string> {
	const file = path.join(dir, "no-usage.jsonl");
	const timestamp = new Date().toISOString();
	const lines = [
		{ type: "session", version: 3, id: "no-usage", timestamp, cwd: dir },
		{
			type: "message",
			id: "a1",
			parentId: null,
			timestamp,
			message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1 },
		},
	];
	await Bun.write(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

describe("assistant messages persisted without usage", () => {
	afterEach(() => mock.restore());

	it("load as zero usage for users instead of crashing the transcript", async () => {
		spyOn(piUtils, "isBunTestRuntime").mockReturnValue(false);
		using tempDir = TempDir.createSync("@pi-missing-usage-");
		const session = await SessionManager.open(await writeSessionWithoutUsage(tempDir.path()), tempDir.path());

		const [message] = session.buildSessionContext().messages;
		expect(message?.role === "assistant" && message.usage.cacheRead).toBe(0);
		expect(session.getUsageStatistics().cost).toBe(0);
	});

	it("fail loudly under test so the producer gets fixed", async () => {
		using tempDir = TempDir.createSync("@pi-missing-usage-");
		const file = await writeSessionWithoutUsage(tempDir.path());

		await expect(SessionManager.open(file, tempDir.path())).rejects.toThrow("has no usage");
	});
});
