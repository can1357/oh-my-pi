import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

describe("write empty content", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = path.join(os.tmpdir(), `write-empty-${Snowflake.next()}`);
		await fs.mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("refuses an empty write that would silently truncate the target", async () => {
		const target = path.join(testDir, "empty.txt");
		await expect(
			new WriteTool(createSession(testDir)).execute("empty", { path: target, content: "" }),
		).rejects.toThrow(/content is empty/);
		expect(await Bun.file(target).exists()).toBe(false);
	});

	it("creates a zero-byte file when allowEmpty is explicit", async () => {
		const target = path.join(testDir, "empty.txt");
		const result = await new WriteTool(createSession(testDir)).execute("empty", {
			path: target,
			content: "",
			allowEmpty: true,
		});
		expect(await Bun.file(target).text()).toBe("");
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("0 bytes") });
	});

	it("still writes non-empty content without the opt-in", async () => {
		const target = path.join(testDir, "kept.txt");
		await new WriteTool(createSession(testDir)).execute("nonempty", { path: target, content: "kept\n" });
		expect(await Bun.file(target).text()).toBe("kept\n");
	});
});
