import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { SpeculativeOperationContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import { CodingAgentSpeculativeExecutionHost } from "@oh-my-pi/pi-coding-agent/speculation/host";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getConflictHistory } from "@oh-my-pi/pi-coding-agent/tools/conflict-detect";
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
		settings: Settings.isolated({ "images.autoResize": false }),
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

	it("admits local paths without touching the filesystem", async () => {
		const tool = new ReadTool(createSession(testDir));

		await expect(tool.speculation.finalized?.assess({ args: { path: "plain.txt" } })).resolves.toEqual({
			eligible: true,
			effect: {
				kind: "local_read",
				resources: [{ scheme: "file", path: path.join(testDir, "plain.txt"), access: "read" }],
			},
		});
		// Content gates (directory, oversize, binary, image) now run inside
		// host authorization, so assessment provisionally admits them; the
		// host denies them before any speculative execution.
		await expect(tool.speculation.finalized?.assess({ args: { path: "directory" } })).resolves.toMatchObject({
			eligible: true,
		});
	});

	it("defers ACP-backed files to the authoritative editor-buffer read", async () => {
		const session = {
			...createSession(testDir),
			getClientBridge: () => ({
				capabilities: { readTextFile: true },
				readTextFile: async () => "unsaved editor content",
			}),
		} as ToolSession;
		const tool = new ReadTool(session);

		await expect(tool.speculation.finalized?.assess({ args: { path: "plain.txt" } })).resolves.toEqual({
			eligible: false,
			reason: "read target is not a speculation-safe local path",
		});
	});

	it("defers oversize exclusion to host authorization", async () => {
		const hugePath = path.join(testDir, "huge.txt");
		fs.writeFileSync(hugePath, "a".repeat(8_192));
		fs.truncateSync(hugePath, 3 * 1024 * 1024 * 1024);
		const session = {
			...createSession(testDir),
			settings: Settings.isolated({
				"images.autoResize": false,
				"tools.approvalMode": "yolo",
				"tools.speculativeExecution.enabled": true,
			}),
		} as ToolSession;
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");

		// Metadata-only assessment cannot see the size, so it provisionally
		// admits the path; the host denies it after the policy gates allow it.
		const assessment = await policy.assess({ args: { path: "huge.txt" } });
		if (!assessment.eligible) throw new Error("expected provisional speculative read admission");
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
		const context: SpeculativeOperationContext = {
			candidateId: "huge-read",
			source: "direct",
			dependencies: [],
			tool,
			toolCall: { type: "toolCall", id: "huge-read", name: "read", arguments: { path: "huge.txt" } },
			args: { path: "huge.txt" },
			effect: assessment.effect,
		};
		await expect(host.authorize(context)).resolves.toEqual({
			allowed: false,
			reason: "local read target is unsafe",
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
		expect(session.editStore).toBeUndefined();
		await tool.speculation.finalized?.discard?.({ ...context, reason: "candidate discarded" });
		expect(session.editStore).toBeUndefined();
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

		expect(session.editStore).toBeUndefined();
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

		expect(session.editStore).toBeUndefined();
		await tool.speculation.finalized?.commit?.({ ...context, physicalOutcome: outcome }, outcome);
		const absolutePath = fs.realpathSync(path.join(testDir, "plain.txt"));
		const store = getEditStore(session);
		const snapshotHash = store.headHash(absolutePath);
		expect(store.headText(absolutePath)).toBe("plain text");
		expect(snapshotHash ? store.seenLines(absolutePath, snapshotHash) : null).toEqual([1]);
	});
	it("renders speculative symlink reads under the requested lexical path", async () => {
		const targetPath = path.join(testDir, "real.txt");
		fs.writeFileSync(targetPath, "linked content");
		try {
			fs.symlinkSync(targetPath, path.join(testDir, "link.txt"), "file");
		} catch {
			// Windows without symlink privilege: nothing to verify.
			return;
		}
		const session = createSession(testDir);
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const args = { path: "link.txt" };
		const assessment = await policy.assess({ args });
		if (!assessment?.eligible) throw new Error("expected speculative read admission");
		const context = {
			toolCall: { type: "toolCall" as const, id: "link-read", name: "read", arguments: args },
			args,
			effect: assessment.effect,
		};
		const outcome = await policy.execute(context, new AbortController().signal);
		if (!outcome) throw new Error("expected speculative read outcome");
		const committed = await policy.commit?.({ ...context, physicalOutcome: outcome }, outcome);
		const text =
			committed?.content?.find((entry): entry is { type: "text"; text: string } => entry.type === "text")?.text ??
			"";
		expect(text).toContain("link.txt");
		expect(text).not.toContain("real.txt");
	});

	it("defers conflict-aware reads without mutating live conflict history", async () => {
		const conflictPath = path.join(testDir, "conflict.txt");
		fs.writeFileSync(conflictPath, "<<<<<<< ours\nnew ours\n=======\nnew theirs\n>>>>>>> theirs\n");
		const session = createSession(testDir);
		const history = getConflictHistory(session);
		const existing = history.register({
			absolutePath: conflictPath,
			displayPath: "conflict.txt",
			startLine: 1,
			separatorLine: 3,
			endLine: 5,
			oursLines: ["old ours"],
			theirsLines: ["old theirs"],
		});
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const args = { path: "conflict.txt" };
		const assessment = await policy.assess({ args });
		if (!assessment.eligible) throw new Error("expected speculative read admission");
		const context = {
			toolCall: { type: "toolCall" as const, id: "conflict-read", name: "read", arguments: args },
			args,
			effect: assessment.effect,
		};

		await expect(policy.execute(context, new AbortController().signal)).rejects.toThrow(
			"Conflict-aware reads require authoritative execution",
		);
		expect(history.get(existing.id)?.oursLines).toEqual(["old ours"]);

		const result = await tool.execute("ordinary-conflict-read", args);
		expect(result.content?.find(entry => entry.type === "text")?.text).toContain("──── #1");
		expect(history.get(existing.id)?.oursLines).toEqual(["new ours"]);
	});

	it("tracks repeat reads only when speculative results commit", async () => {
		const session = createSession(testDir);
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const args = { path: "plain.txt" };
		const assessment = await policy.assess({ args });
		if (!assessment.eligible) throw new Error("expected speculative read admission");
		let text = "";

		for (let index = 1; index <= 3; index++) {
			const context = {
				toolCall: { type: "toolCall" as const, id: `repeat-read-${index}`, name: "read", arguments: args },
				args,
				effect: assessment.effect,
			};
			const outcome = await policy.execute(context, new AbortController().signal);
			const result = await policy.commit?.({ ...context, physicalOutcome: outcome }, outcome);
			text = result?.content?.find(entry => entry.type === "text")?.text ?? "";
		}

		expect(text).toContain("You have received this identical output 3 times");
	});

	it("tracks repeat reads when text mode has no staged snapshot", async () => {
		const session = {
			...createSession(testDir),
			settings: Settings.isolated({ "images.autoResize": false, "edit.mode": "patch" }),
		} as ToolSession;
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const args = { path: "plain.txt" };
		const assessment = await policy.assess({ args });
		if (!assessment.eligible) throw new Error("expected speculative read admission");
		let text = "";

		for (let index = 1; index <= 3; index++) {
			const context = {
				toolCall: { type: "toolCall" as const, id: `plain-repeat-read-${index}`, name: "read", arguments: args },
				args,
				effect: assessment.effect,
			};
			const outcome = await policy.execute(context, new AbortController().signal);
			const result = await policy.commit?.({ ...context, physicalOutcome: outcome }, outcome);
			text = result?.content?.find(entry => entry.type === "text")?.text ?? "";
		}

		expect(text).toContain("You have received this identical output 3 times");
	});

	it("rejects non-local, selected, convertible, and escaping targets without I/O", async () => {
		const tool = new ReadTool(createSession(testDir));
		const rejectedPaths = [
			"https://example.test/read",
			"mcp://service/resource",
			"plain.txt:1-2",
			"document.pdf",
			"../outside.txt",
		];

		for (const rejectedPath of rejectedPaths) {
			await expect(tool.speculation.finalized?.assess({ args: { path: rejectedPath } })).resolves.toEqual({
				eligible: false,
				reason: "read target is not a speculation-safe local path",
			});
		}
	});

	it("denies unsafe targets at host authorization, unsafe content at capture", async () => {
		fs.writeFileSync(path.join(testDir, "blob.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
		const session = {
			...createSession(testDir),
			settings: Settings.isolated({
				"images.autoResize": false,
				"tools.approvalMode": "yolo",
				"tools.speculativeExecution.enabled": true,
			}),
		} as ToolSession;
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
		const authorizeContext = (
			candidateId: string,
			target: string,
			effect: SpeculativeOperationContext["effect"],
		): SpeculativeOperationContext => ({
			candidateId,
			source: "direct",
			dependencies: [],
			tool,
			toolCall: { type: "toolCall", id: candidateId, name: "read", arguments: { path: target } },
			args: { path: target },
			effect,
		});
		// Metadata verdicts stay at authorization: directories and missing paths
		// never reach content inspection.
		for (const { path: target, reason } of [
			{ path: "directory", reason: "local read target is unsafe" },
			{ path: "missing.txt", reason: "local read path is unavailable" },
		]) {
			const assessment = await policy.assess({ args: { path: target } });
			if (!assessment.eligible) throw new Error(`expected provisional admission for ${target}`);
			await expect(host.authorize(authorizeContext(`meta-${target}`, target, assessment.effect))).resolves.toEqual({
				allowed: false,
				reason,
			});
		}
		// Content verdicts moved behind the hook gate: authorization admits
		// provisionally (no file bytes read), and the pre-execution capture —
		// which runs after `beforeToolCall` for deferred candidates — vetoes.
		for (const target of ["image.png", "data.sqlite", "blob.dat"]) {
			const assessment = await policy.assess({ args: { path: target } });
			if (!assessment.eligible) throw new Error(`expected provisional admission for ${target}`);
			const context = authorizeContext(`content-${target}`, target, assessment.effect);
			await expect(host.authorize(context)).resolves.toEqual({ allowed: true, deferBeforeToolCall: true });
			await expect(host.captureEvidence(context)).resolves.toBe(false);
		}
		// A plain text file still captures evidence for the commit path.
		const plain = await policy.assess({ args: { path: "plain.txt" } });
		if (!plain.eligible) throw new Error("expected provisional admission for plain.txt");
		const plainContext = authorizeContext("content-plain", "plain.txt", plain.effect);
		await expect(host.authorize(plainContext)).resolves.toEqual({ allowed: true, deferBeforeToolCall: true });
		await expect(host.captureEvidence(plainContext)).resolves.toBe(true);
	});
});
