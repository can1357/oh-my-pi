import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as path from "node:path";

import { Settings } from "../../src/config/settings";
import { bridgeValueFromToolResult, callSessionTool } from "../../src/eval/js/tool-bridge";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";
import { wrapToolWithMetaNotice } from "../../src/tools/output-meta";
import { artifactReadBridge } from "../helpers/artifact-read-bridge";

/** Records the fixture tool answers with, one per line, plus the count it reports beside them. */
const RECORD_COUNT = 684;

/**
 * A device-shaped tool: a long line-per-record listing in the text, and a
 * `count` in `details` that describes the whole listing. `envoy_sessions`
 * answers exactly this way.
 */
function listingTool(text: string): AgentTool {
	return wrapToolWithMetaNotice({
		name: "sessions",
		label: "sessions",
		description: "list sessions",
		parameters: type({}),
		concurrency: "parallel",
		execute: async () => ({
			content: [{ type: "text" as const, text }],
			details: { count: RECORD_COUNT },
		}),
	} as unknown as AgentTool);
}

function evalSession(tool: AgentTool, context: AgentToolContext): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: context.settings,
		getToolByName: (name: string) => (name === tool.name ? tool : undefined),
		getToolContext: () => context,
	} as unknown as ToolSession;
}

function shownRecords(text: string): number {
	return (text.match(/"session_id"/g) ?? []).length;
}

describe("eval tool bridge truncation record", () => {
	it("tells a script its text is a sample and addresses the whole value", async () => {
		using temp = TempDir.createSync("@eval-bridge-truncation-");
		const manager = SessionManager.create(temp.path(), temp.path());
		await manager.ensureOnDisk();
		const listing = Array.from(
			{ length: RECORD_COUNT },
			(_, i) => `{"session_id": "s-${i}", "pad": "${"x".repeat(900)}"}`,
		).join("\n");
		const context = {
			sessionManager: manager,
			settings: Settings.isolated({
				"tools.artifactSpillThreshold": 40,
				"tools.artifactHeadBytes": 10,
				"tools.artifactTailBytes": 10,
				"tools.artifactTailLines": 10,
			}),
		} as unknown as AgentToolContext;
		const tool = listingTool(listing);
		try {
			const value = await callSessionTool("sessions", {}, { session: evalSession(tool, context) });
			if (typeof value !== "object" || !("details" in value)) throw new Error("expected the object bridge value");

			// The harm this guards: `details` still describes the whole listing while
			// the text carries a fraction of it.
			expect(value.details).toEqual({ count: RECORD_COUNT, meta: expect.anything() });
			const shown = shownRecords(value.text);
			expect(shown).toBeGreaterThan(0);
			expect(shown).toBeLessThan(RECORD_COUNT);

			const truncated = value.truncated;
			if (!truncated) throw new Error("expected the bridge value to report a sampled text");
			expect(truncated.lines.total).toBe(RECORD_COUNT);
			expect(truncated.lines.shown).toBeLessThan(truncated.lines.total);
			expect(truncated.bytes.total).toBe(Buffer.byteLength(listing, "utf-8"));
			expect(truncated.bytes.shown).toBeLessThan(truncated.bytes.total);

			// The pointer must resolve to the whole value, not to nothing.
			const artifact = truncated.artifact;
			if (!artifact) throw new Error("expected an artifact URL for the whole value");
			const id = artifact.slice("artifact://".length);
			expect(artifact).toBe(`artifact://${id}`);
			expect(value.text).toContain(artifact);
			const artifactPath = await manager.getArtifactPath(id);
			if (!artifactPath) throw new Error("expected the artifact URL to resolve to a file");
			expect(shownRecords(await Bun.file(artifactPath).text())).toBe(RECORD_COUNT);
		} finally {
			await manager.close();
		}
	});

	it("leaves a whole result a bare string with nothing to check", async () => {
		using temp = TempDir.createSync("@eval-bridge-whole-");
		const manager = SessionManager.create(temp.path(), temp.path());
		await manager.ensureOnDisk();
		const context = {
			sessionManager: manager,
			settings: Settings.isolated({ "tools.artifactSpillThreshold": 40 }),
		} as unknown as AgentToolContext;
		const tool = wrapToolWithMetaNotice({
			name: "sessions",
			label: "sessions",
			description: "list sessions",
			parameters: type({}),
			concurrency: "parallel",
			execute: async () => ({ content: [{ type: "text" as const, text: "two\nlines" }] }),
		} as unknown as AgentTool);
		try {
			expect(await callSessionTool("sessions", {}, { session: evalSession(tool, context) })).toBe("two\nlines");
		} finally {
			await manager.close();
		}
	});

	it("counts a one-line middle elision as a sample, and agrees with the notice", async () => {
		// `truncateMiddle` counts its own elision marker among the output lines,
		// so this result reports 1001 output lines of 1001 and more output bytes
		// than it has. Reading those counters, the text passes for whole.
		using temp = TempDir.createSync("@eval-bridge-marker-");
		const manager = SessionManager.create(temp.path(), temp.path());
		await manager.ensureOnDisk();
		const lines = Array.from({ length: 1001 }, (_, i) => `line-${i}`);
		const context = {
			sessionManager: manager,
			settings: Settings.isolated({ "tools.artifactSpillThreshold": 1 }),
		} as unknown as AgentToolContext;
		const tool = listingTool(lines.join("\n"));
		try {
			const value = await callSessionTool("sessions", {}, { session: evalSession(tool, context) });
			if (typeof value !== "object" || !("details" in value)) throw new Error("expected the object bridge value");
			const truncated = value.truncated;
			if (!truncated) throw new Error("expected the bridge value to report a sampled text");
			expect(truncated.lines).toEqual({ shown: 1000, total: 1001 });
			expect(value.text).toContain("1 middle line");
			expect(value.text).toContain("of 1001");
		} finally {
			await manager.close();
		}
	});

	it("leaves a requested read page unmarked, since the page is what was asked for", async () => {
		using temp = TempDir.createSync("@eval-bridge-page-");
		const file = path.join(temp.path(), "page.txt");
		await Bun.write(file, `${Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
		const read = artifactReadBridge(temp.path(), path.join(temp.path(), "artifacts"));

		const value = await read({ path: `${file}:1-5` });
		if (typeof value !== "object" || value === null || !("text" in value)) {
			throw new Error("expected the object bridge value");
		}
		expect((value as { text: string }).text).toContain("Use :");
		expect(value).not.toHaveProperty("truncated");
	});

	it("says when the saved copy is a sample too, so following the URL is not a second surprise", () => {
		// What the output sink records past `tools.artifactMaxBytes`: the
		// artifact holds a head/tail sample, not the whole stream.
		const value = bridgeValueFromToolResult("bash", {}, {
			content: [{ type: "text", text: "head\n…\ntail" }],
			details: {
				meta: {
					truncation: {
						direction: "middle",
						totalLines: 30_000,
						totalBytes: 2_718_889,
						outputLines: 20,
						outputBytes: 400,
						elidedLines: 29_980,
						elidedBytes: 2_718_489,
						artifactId: "7",
						artifactElidedBytes: 1_670_314,
					},
				},
			},
		} as unknown as AgentToolResult);
		if (typeof value !== "object" || !("truncated" in value)) throw new Error("expected a truncation record");
		expect(value.truncated).toEqual({
			lines: { shown: 20, total: 30_000 },
			bytes: { shown: 400, total: 2_718_889 },
			artifact: "artifact://7",
			artifactElidedBytes: 1_670_314,
		});
	});
});
