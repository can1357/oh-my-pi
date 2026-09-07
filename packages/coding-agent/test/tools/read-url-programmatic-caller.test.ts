/**
 * The `eval` bridge promises a cell the tool's own bytes, but several tools cap
 * their output *before* the bridge sees a result. Skipping the bridge-side
 * artifact spill cannot restore what a producer already dropped, so each
 * producer has to honour `programmaticCaller` itself.
 *
 * `read` on a URL applies a 50 KiB presentation cap to the response a cell is
 * about to parse, so a head cut there is corruption, not shortening.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as fetchModule from "@oh-my-pi/pi-coding-agent/tools/fetch";

import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const PROGRAMMATIC = { programmaticCaller: true } as AgentToolContext;

function session(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("URL read output for programmatic callers", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-read-url-programmatic-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("read returns a URL response untruncated for a programmatic caller", async () => {
		// One long JSON-ish body: a cell parses it, so a head cut is corruption.
		const body = `{"rows":[${Array.from({ length: 4000 }, (_, i) => `{"i":${i},"pad":"${"x".repeat(20)}"}`).join(",")}]}`;
		expect(Buffer.byteLength(body, "utf-8")).toBeGreaterThan(DEFAULT_MAX_BYTES);

		using _fetch = spyOn(fetchModule, "fetchReadUrl").mockResolvedValue({
			output: body,
			details: { finalUrl: "https://example.test/data.json", truncated: false },
		} as never);

		const tool = new ReadTool(session(cwd));
		const args = { path: "https://example.test/data.json" } as never;

		const bounded = textOf(await tool.execute("call-model", args, undefined, undefined, undefined));
		expect(bounded).not.toBe(body);

		const whole = textOf(await tool.execute("call-kernel", args, undefined, undefined, PROGRAMMATIC));
		expect(whole).toBe(body);
	}, 30_000);
});
