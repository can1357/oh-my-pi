// Unit tests for the advisor's byte-identical tool-result dedupe
// (src/advisor/tool-result-dedupe.ts). Covers the hit/miss contract the
// advisor's `afterToolCall` hook relies on: a repeat only collapses to the
// notice while the earlier result is still live and verbatim in the advisor's
// own context.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

import { AdvisorToolResultDedupe, DEDUPED_RESULT_NOTICE } from "../../src/advisor/tool-result-dedupe";

function call(id: string, args: Record<string, unknown> = { path: "a.ts" }) {
	return { id, name: "read", arguments: args };
}

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }] };
}

function liveResult(toolCallId: string, text: string, overrides: Partial<AgentMessage> = {}): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
		...overrides,
	} as AgentMessage;
}

/** A real `read` in a fresh temp dir, wrapped like the advisors' tools in `sdk.ts`. */
async function withReadTool(run: (cwd: string, tool: ReadTool) => Promise<void>): Promise<void> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-dedupe-"));
	try {
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({}),
		};
		await run(cwd, wrapToolWithMetaNotice(new ReadTool(session)));
	} finally {
		removeSyncWithRetries(cwd);
	}
}

/**
 * One advisor `read` through the dedupe as its `afterToolCall` runs it; appends
 * what the advisor is served to `messages` and returns it with the tool's raw text.
 */
async function advisorRead(
	tool: ReadTool,
	dedupe: AdvisorToolResultDedupe,
	messages: AgentMessage[],
	id: string,
	selector: string,
): Promise<{ raw: string; served: string }> {
	const result = await tool.execute(id, { path: selector });
	const raw = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
	const override = dedupe.check(call(id, { path: selector }), result, messages);
	const served = override ? DEDUPED_RESULT_NOTICE : raw;
	messages.push(liveResult(id, served, { details: result.details }));
	return { raw, served };
}

function repeatHint(count: number, readPath: string): string {
	return `[You have received this identical output ${count} times. Re-reading '${readPath}' will not change it — use a narrower selector (path:A-B), or proceed with the edit.]`;
}

const RAW_NOTES = "notes.md:raw";

/** Writes each version to `notes.md` in turn; returns what one advisor is served reading it raw each time. */
async function serveRawReads(versions: string[]): Promise<string[]> {
	const served: string[] = [];
	await withReadTool(async (cwd, tool) => {
		const dedupe = new AdvisorToolResultDedupe();
		const messages: AgentMessage[] = [];
		for (const [n, content] of versions.entries()) {
			fs.writeFileSync(path.join(cwd, "notes.md"), content);
			served.push((await advisorRead(tool, dedupe, messages, `t${n}`, RAW_NOTES)).served);
		}
	});
	return served;
}

describe("AdvisorToolResultDedupe", () => {
	it("collapses a repeat whose earlier result is still live and identical", () => {
		const dedupe = new AdvisorToolResultDedupe();
		expect(dedupe.check(call("t1"), textResult("contents"), [])).toBeUndefined();

		const messages = [liveResult("t1", "contents")];
		const hit = dedupe.check(call("t2"), textResult("contents"), messages);
		expect(hit).toEqual({ content: [{ type: "text", text: DEDUPED_RESULT_NOTICE }], useless: true });
	});

	it("serves the full result when the file changed under the same call", () => {
		const dedupe = new AdvisorToolResultDedupe();
		dedupe.check(call("t1"), textResult("contents"), []);
		const messages = [liveResult("t1", "contents")];
		expect(dedupe.check(call("t2"), textResult("contents v2"), messages)).toBeUndefined();
	});

	it("serves the full result again once the earlier one is evicted, then dedupes against the new copy", () => {
		const dedupe = new AdvisorToolResultDedupe();
		dedupe.check(call("t1"), textResult("contents"), []);

		const evicted = [liveResult("t1", "contents", { prunedAt: 1_700_000_000_000 })];
		expect(dedupe.check(call("t2"), textResult("contents"), evicted)).toBeUndefined();

		// The registry now points at t2, whose result is live.
		const messages = [...evicted, liveResult("t2", "contents")];
		expect(dedupe.check(call("t3"), textResult("contents"), messages)).toEqual({
			content: [{ type: "text", text: DEDUPED_RESULT_NOTICE }],
			useless: true,
		});
	});

	it("serves the full result when the earlier one is no longer in context", () => {
		const dedupe = new AdvisorToolResultDedupe();
		dedupe.check(call("t1"), textResult("contents"), []);
		expect(dedupe.check(call("t2"), textResult("contents"), [liveResult("other", "contents")])).toBeUndefined();
	});

	it("matches across argument key order and intent wording", () => {
		const dedupe = new AdvisorToolResultDedupe();
		dedupe.check(call("t1", { path: "a.ts", i: "Reading the file", __intent: "old" }), textResult("contents"), []);
		const messages = [liveResult("t1", "contents")];
		expect(
			dedupe.check(call("t2", { i: "Checking it once more", path: "a.ts" }), textResult("contents"), messages),
		).toEqual({ content: [{ type: "text", text: DEDUPED_RESULT_NOTICE }], useless: true });
	});

	it("serves the full result when an argument value differs", () => {
		const dedupe = new AdvisorToolResultDedupe();
		dedupe.check(call("t1", { path: "a.ts" }), textResult("contents"), []);
		const messages = [liveResult("t1", "contents")];
		expect(dedupe.check(call("t2", { path: "a.ts " }), textResult("contents"), messages)).toBeUndefined();
	});

	it("serves the full result when the original sits in an earlier review, then dedupes against the new copy", () => {
		const dedupe = new AdvisorToolResultDedupe();
		const review = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 }) as AgentMessage;
		const messages: AgentMessage[] = [review("review 1")];
		expect(dedupe.check(call("t1"), textResult("contents"), messages)).toBeUndefined();
		messages.push(liveResult("t1", "contents"), review("review 2"));
		// Eviction protects only the latest review, so a stub here would point at
		// a copy the next eviction pass blanks.
		expect(dedupe.check(call("t2"), textResult("contents"), messages)).toBeUndefined();
		messages.push(liveResult("t2", "contents"));
		expect(dedupe.check(call("t3"), textResult("contents"), messages)).toEqual({
			content: [{ type: "text", text: DEDUPED_RESULT_NOTICE }],
			useless: true,
		});
	});

	it("never collapses a result carrying an image", () => {
		const dedupe = new AdvisorToolResultDedupe();
		const image: AgentToolResult<unknown> = { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] };
		const imageMessage = (toolCallId: string): AgentMessage =>
			liveResult(toolCallId, "", {
				content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			} as Partial<AgentMessage>);

		// Incoming result carries an image: never comparable, even against a live copy.
		dedupe.check(call("t1"), image, []);
		expect(dedupe.check(call("t2"), image, [imageMessage("t1")])).toBeUndefined();

		// Live copy carries an image while the incoming result is pure text.
		expect(dedupe.check(call("t3"), textResult(""), [imageMessage("t2")])).toBeUndefined();
	});

	it("serves the full result when the earlier call errored", () => {
		const dedupe = new AdvisorToolResultDedupe();
		dedupe.check(call("t1"), textResult("ENOENT"), []);
		const messages = [liveResult("t1", "ENOENT", { isError: true })];
		expect(dedupe.check(call("t2"), textResult("ENOENT"), messages)).toBeUndefined();
	});

	it("keeps collapsing the 3rd and later identical reads though read appends its repeat hint", async () => {
		await withReadTool(async (cwd, tool) => {
			fs.writeFileSync(path.join(cwd, "a.ts"), "export const a = 1;\n");
			fs.writeFileSync(
				path.join(cwd, "long.ts"),
				Array.from({ length: 450 }, (_, i) => `const v${i} = ${i};`).join("\n"),
			);
			for (const file of ["a.ts", "long.ts"]) {
				const dedupe = new AdvisorToolResultDedupe();
				const messages: AgentMessage[] = [];
				const reads: { raw: string; served: string }[] = [];
				for (let n = 1; n <= 4; n++) {
					reads.push(await advisorRead(tool, dedupe, messages, `${file}-${n}`, file));
				}
				// The read tool's own hint really is on the 3rd and 4th raw results...
				expect(reads[2]!.raw).not.toBe(reads[0]!.raw);
				expect(reads[3]!.raw).not.toBe(reads[2]!.raw);
				// ...and on the long file the `[Showing lines …]` notice follows it.
				if (file === "long.ts") expect(reads[2]!.raw).not.toEndWith("proceed with the edit.]");
				expect(reads.slice(1).map(r => r.served)).toEqual(Array(3).fill(DEDUPED_RESULT_NOTICE));
			}
		});
	});

	it("serves a change in full where read puts its hint when the hint names another path", async () => {
		const versions = [`# Log\n\n${repeatHint(7, "other.ts")}`, `# Log\n\n${repeatHint(8, "other.ts")}`, "# Log"];
		expect(await serveRawReads(versions)).toEqual(versions);
	});

	it("serves a change in full to a hint for this very read that sits mid-content", async () => {
		const versions = [`# Log\n\n${repeatHint(7, RAW_NOTES)}\n\nend`, `# Log\n\n${repeatHint(8, RAW_NOTES)}\n\nend`];
		expect(await serveRawReads(versions)).toEqual(versions);
	});
});
