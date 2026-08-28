import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { canonicalSnapshotKey } from "@oh-my-pi/pi-coding-agent/edit/file-snapshot-store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function createSession(cwd: string): ToolSession {
	const image: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "images.autoResize": false, "inspect_image.enabled": false }),
		getImageAttachments: () => [
			{ label: "Image #1", uri: "attachment://1", image, sourcePath: path.join(cwd, "image.png") },
		],
	};
}

describe("read speculation assessment", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-speculation-"));
		fs.writeFileSync(path.join(testDir, "plain.txt"), "plain text");
		fs.mkdirSync(path.join(testDir, "directory"));
		fs.writeFileSync(path.join(testDir, "image.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
		fs.writeFileSync(path.join(testDir, "document.pdf"), "%PDF-1.7");
		fs.writeFileSync(path.join(testDir, "data.sqlite"), "SQLite format 3\u0000");
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("allows only direct local text files", async () => {
		const tool = new ReadTool(createSession(testDir));

		await expect(tool.speculation.finalized?.assess({ args: { path: "plain.txt" } })).resolves.toEqual({
			eligible: true,
			effect: {
				kind: "local_read",
				resources: [{ scheme: "file", path: fs.realpathSync(path.join(testDir, "plain.txt")), access: "read" }],
			},
		});
		await expect(tool.speculation.finalized?.assess({ args: { path: "directory" } })).resolves.toEqual({
			eligible: false,
			reason: "read target is not a speculation-safe local path",
		});
	});

	it("rejects files too large to bind the result to one buffered snapshot", async () => {
		const hugePath = path.join(testDir, "huge.txt");
		fs.writeFileSync(hugePath, "a".repeat(8_192));
		fs.truncateSync(hugePath, 3 * 1024 * 1024 * 1024);
		const tool = new ReadTool(createSession(testDir));

		await expect(tool.speculation.finalized?.assess({ args: { path: "huge.txt" } })).resolves.toEqual({
			eligible: false,
			reason: "read target is not a speculation-safe local path",
		});
	});

	it("keeps speculative read provenance isolated when the candidate is discarded", async () => {
		const session = createSession(testDir);
		const tool = new ReadTool(session);
		const args = { path: "plain.txt" };
		const toolCall = { type: "toolCall" as const, id: "discarded-read", name: "read", arguments: args };
		const assessment = await tool.speculation.finalized?.assess({ args });
		if (!assessment?.eligible) throw new Error("expected speculative read admission");
		const context = { toolCall, args, effect: assessment.effect };

		await tool.speculation.finalized?.execute(context, new AbortController().signal);
		expect(session.fileSnapshotStore).toBeUndefined();
		await tool.speculation.finalized?.discard?.({ ...context, reason: "candidate discarded" });
		expect(session.fileSnapshotStore).toBeUndefined();
	});

	it("does not retain provenance when discard wins the read race", async () => {
		const session = createSession(testDir);
		const tool = new ReadTool(session);
		const args = { path: "plain.txt" };
		const toolCall = { type: "toolCall" as const, id: "racing-read", name: "read", arguments: args };
		const assessment = await tool.speculation.finalized?.assess({ args });
		if (!assessment?.eligible) throw new Error("expected speculative read admission");
		const context = { toolCall, args, effect: assessment.effect };
		const outcomePromise = tool.speculation.finalized?.execute(context, new AbortController().signal);
		if (!outcomePromise) throw new Error("expected speculative read execution");

		await tool.speculation.finalized?.discard?.({ ...context, reason: "candidate discarded" });
		const outcome = await outcomePromise;
		await tool.speculation.finalized?.commit?.({ ...context, physicalOutcome: outcome }, outcome);

		expect(session.fileSnapshotStore).toBeUndefined();
	});

	it("merges speculative read provenance only when the candidate commits", async () => {
		const session = createSession(testDir);
		const tool = new ReadTool(session);
		const args = { path: "plain.txt" };
		const toolCall = { type: "toolCall" as const, id: "committed-read", name: "read", arguments: args };
		const assessment = await tool.speculation.finalized?.assess({ args });
		if (!assessment?.eligible) throw new Error("expected speculative read admission");
		const context = { toolCall, args, effect: assessment.effect };
		const outcome = await tool.speculation.finalized?.execute(context, new AbortController().signal);
		if (!outcome) throw new Error("expected speculative read outcome");

		expect(session.fileSnapshotStore).toBeUndefined();
		await tool.speculation.finalized?.commit?.({ ...context, physicalOutcome: outcome }, outcome);
		const snapshot = session.fileSnapshotStore?.head(canonicalSnapshotKey(path.join(testDir, "plain.txt")));
		expect(snapshot?.text).toBe("plain text");
		expect(snapshot?.seenLines).toEqual(new Set([1]));
	});

	it("rejects non-local, selected, binary, missing, and escaping targets", async () => {
		const tool = new ReadTool(createSession(testDir));
		const rejectedPaths = [
			"https://example.test/read",
			"mcp://service/resource",
			"plain.txt:1-2",
			"image.png",
			"document.pdf",
			"data.sqlite",
			"missing.txt",
			"../outside.txt",
		];

		for (const rejectedPath of rejectedPaths) {
			await expect(tool.speculation.finalized?.assess({ args: { path: rejectedPath } })).resolves.toEqual({
				eligible: false,
				reason: "read target is not a speculation-safe local path",
			});
		}
	});
});
