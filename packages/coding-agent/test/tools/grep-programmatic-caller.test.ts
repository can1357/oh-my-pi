/**
 * The `eval` bridge promises a cell the tool's own bytes, but `grep` caps its
 * rendered match list before the bridge sees a result. Skipping the bridge-side
 * artifact spill cannot restore matches the producer already dropped.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { GrepTool } from "../../src/tools/grep";

const PROGRAMMATIC = { programmaticCaller: true } as AgentToolContext;

function session(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		// Hashline tagging is not under test and needs the native addon; a stub
		// keeps this file in the plain unit bucket.
		editStore: { recordSnapshotFile: () => undefined },
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("grep output for programmatic callers", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-grep-programmatic-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("grep keeps every rendered match for a programmatic caller", async () => {
		// Multi-file scope selects up to 20 files x 20 matches; ~450-char lines
		// (just under the per-line column cap) push the rendered list past the
		// 50 KiB head cap without tripping grep's own match limits.
		const needle = "PROGRAMMATIC_NEEDLE";
		for (let file = 0; file < 25; file++) {
			const lines = Array.from({ length: 25 }, (_, line) => `${needle} f${file}l${line} ${"pad".repeat(140)}`);
			await Bun.write(path.join(cwd, `haystack-${file}.txt`), `${lines.join("\n")}\n`);
		}

		const tool = new GrepTool(session(cwd));
		const args = { pattern: needle, path: cwd } as never;

		const bounded = textOf(await tool.execute("call-model", args, undefined, undefined, undefined));
		const whole = textOf(await tool.execute("call-kernel", args, undefined, undefined, PROGRAMMATIC));

		// Guard: without a rendered list past the cap both assertions are vacuous.
		expect(Buffer.byteLength(whole, "utf-8")).toBeGreaterThan(DEFAULT_MAX_BYTES);
		expect(Buffer.byteLength(bounded, "utf-8")).toBeLessThan(Buffer.byteLength(whole, "utf-8"));
		expect(whole.split(needle).length).toBeGreaterThan(bounded.split(needle).length);
	}, 60_000);
});
