import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { BlobStore, isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { inlineBlobRefsSync } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "../session-manager/helpers";

const TURNS = 5;
/** The compaction lands after the fourth turn and keeps from the third on. */
const FIRST_KEPT_TURN = 2;

function image(turn: number): string {
	return Buffer.alloc(3000, turn + 1).toString("base64");
}

function userWithImage(turn: number, extraText = "") {
	return {
		role: "user" as const,
		content: [
			{ type: "text" as const, text: `screenshot ${turn}${extraText}` },
			{ type: "image" as const, data: image(turn), mimeType: "image/png" },
		],
		timestamp: turn + 1,
	};
}

function imageOf(entry: SessionEntry | undefined): string {
	if (entry?.type !== "message" || entry.message.role !== "user" || typeof entry.message.content === "string") {
		throw new Error("expected a user message with content blocks");
	}
	const block = entry.message.content.find(candidate => candidate.type === "image");
	if (block?.type !== "image") throw new Error("expected an image block");
	return block.data;
}

function textOf(entry: SessionEntry | undefined): string {
	if (entry?.type !== "message" || entry.message.role !== "user" || typeof entry.message.content === "string") {
		throw new Error("expected a user message with content blocks");
	}
	const block = entry.message.content.find(candidate => candidate.type === "text");
	if (block?.type !== "text") throw new Error("expected a text block");
	return block.text;
}

interface History {
	userIds: string[];
	compactionId: string;
	leafId: string;
}

/** Five screenshot turns; a compaction after the fourth keeps from the third on. */
function appendHistory(
	session: SessionManager,
	options: { preserveData?: Record<string, unknown>; firstTurnText?: string } = {},
): History {
	const userIds: string[] = [];
	let compactionId = "";
	for (let turn = 0; turn < TURNS; turn++) {
		userIds.push(session.appendMessage(userWithImage(turn, turn === 0 ? options.firstTurnText : "")));
		session.appendMessage(makeAssistantMessage());
		if (turn === TURNS - 2) {
			compactionId = session.appendCompaction("summary", undefined, userIds[FIRST_KEPT_TURN], 1000, {
				preserveData: options.preserveData,
			});
		}
	}
	return { userIds, compactionId, leafId: session.getLeafId() ?? "" };
}

function entryById(session: SessionManager, id: string): SessionEntry {
	const entry = session.getEntry(id);
	if (!entry) throw new Error(`missing entry ${id}`);
	return entry;
}

describe("images of compacted history", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	let root: string;
	let sessionDir: string;

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-compacted-images-")));
		sessionDir = path.join(root, "sessions");
		setAgentDir(path.join(root, "agent"));
	});

	afterEach(() => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(root);
	});

	async function fileBackedSession(): Promise<SessionManager> {
		const session = SessionManager.create(root, sessionDir);
		session.appendMessage({ role: "user", content: "start", timestamp: 0 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		return session;
	}

	it("keeps archived images as blob refs and the kept range inline after a compaction", async () => {
		const session = await fileBackedSession();
		const history = appendHistory(session);

		history.userIds.forEach((id, turn) => {
			const data = imageOf(entryById(session, id));
			if (turn < FIRST_KEPT_TURN) expect(isBlobRef(data)).toBe(true);
			else expect(data).toBe(image(turn));
		});

		// The full-history transcript still shows every screenshot, restored on the way out.
		const transcript = session.buildSessionContext({ transcript: true }).messages;
		expect(JSON.stringify(transcript)).not.toContain("blob:sha256:");
		expect(JSON.stringify(transcript)).toContain(image(0));
		await session.close();
	});

	it("resumes with the same refs and restores identical entries on the way out", async () => {
		const session = await fileBackedSession();
		const history = appendHistory(session);
		const before = JSON.parse(JSON.stringify(session.withInlineImages(session.getEntries())));
		await session.flush();
		const sessionFile = session.getSessionFile() ?? "";
		await session.close();

		const resumed = await SessionManager.open(sessionFile, sessionDir);
		history.userIds.forEach((id, turn) => {
			const data = imageOf(entryById(resumed, id));
			if (turn < FIRST_KEPT_TURN) expect(isBlobRef(data)).toBe(true);
			else expect(data).toBe(image(turn));
		});
		expect(JSON.parse(JSON.stringify(resumed.withInlineImages(resumed.getEntries())))).toEqual(before);
		await resumed.close();
	});

	it("keeps everything else a live entry holds, such as text persistence truncates", async () => {
		const session = await fileBackedSession();
		const longText = "x".repeat(600_000);
		const history = appendHistory(session, { firstTurnText: longText });

		const archived = entryById(session, history.userIds[0]);
		expect(isBlobRef(imageOf(archived))).toBe(true);
		expect(textOf(archived)).toBe(`screenshot 0${longText}`);
		await session.close();
	});

	it("restores images when the leaf moves into compacted history and swaps them back on return", async () => {
		const session = await fileBackedSession();
		const history = appendHistory(session);
		const archivedLeaf = session.getBranch(history.userIds[1]).at(-1);
		if (!archivedLeaf) throw new Error("expected an archived entry");

		session.branch(archivedLeaf.id);
		for (const entry of session.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user" && typeof entry.message.content !== "string") {
				expect(isBlobRef(imageOf(entry))).toBe(false);
			}
		}
		expect(imageOf(entryById(session, history.userIds[0]))).toBe(image(0));
		expect(JSON.stringify(session.buildSessionContext().messages)).not.toContain("blob:sha256:");

		session.branch(history.leafId);
		expect(isBlobRef(imageOf(entryById(session, history.userIds[0])))).toBe(true);
		expect(isBlobRef(imageOf(entryById(session, history.userIds[1])))).toBe(true);
		expect(imageOf(entryById(session, history.userIds[FIRST_KEPT_TURN]))).toBe(image(FIRST_KEPT_TURN));
		await session.close();
	});

	it("swaps the images of a compaction appended inside an atomic batch once the journal is current", async () => {
		const session = await fileBackedSession();
		const userIds: string[] = [];
		for (let turn = 0; turn < 4; turn++) {
			userIds.push(session.appendMessage(userWithImage(turn)));
			session.appendMessage(makeAssistantMessage());
		}

		await session.appendEntriesAtomically(() =>
			session.appendCompaction("summary", undefined, userIds[FIRST_KEPT_TURN], 1000),
		);
		expect(imageOf(entryById(session, userIds[0]))).toBe(image(0));

		session.appendMessage(userWithImage(4));
		expect(isBlobRef(imageOf(entryById(session, userIds[0])))).toBe(true);
		expect(isBlobRef(imageOf(entryById(session, userIds[1])))).toBe(true);
		expect(imageOf(entryById(session, userIds[FIRST_KEPT_TURN]))).toBe(image(FIRST_KEPT_TURN));
		await session.close();
	});

	it("restores the images a later compaction keeps again when it moves the kept range back", async () => {
		const session = await fileBackedSession();
		const history = appendHistory(session);
		expect(isBlobRef(imageOf(entryById(session, history.userIds[1])))).toBe(true);

		// An extension may pick a `firstKeptEntryId` before the previous compaction's.
		session.appendCompaction("summary 2", undefined, history.userIds[1], 1000, { fromExtension: true });

		expect(imageOf(entryById(session, history.userIds[1]))).toBe(image(1));
		expect(isBlobRef(imageOf(entryById(session, history.userIds[0])))).toBe(true);
		await session.close();
	});

	it("does not treat a provider-native compaction as a boundary", async () => {
		const session = await fileBackedSession();
		const history = appendHistory(session, {
			preserveData: {
				openaiRemoteCompaction: {
					provider: "openai",
					replacementHistory: [{ type: "message", role: "user", content: [{ type: "input_text", text: "kept" }] }],
				},
			},
		});

		for (const [turn, id] of history.userIds.entries()) {
			expect(imageOf(entryById(session, id))).toBe(image(turn));
		}
		await session.close();
	});

	it("hands trees and replication snapshots the bytes while the entry accessors keep refs", async () => {
		const session = await fileBackedSession();
		appendHistory(session);

		expect(JSON.stringify(session.getTree())).toContain("blob:sha256:");
		expect(JSON.stringify(session.getTree({ inlineImages: true }))).not.toContain("blob:sha256:");
		expect(JSON.stringify(session.snapshotForReplication().entries)).not.toContain("blob:sha256:");
		expect(JSON.stringify(session.getEntries())).toContain("blob:sha256:");
		await session.close();
	});

	it("keeps archived images as refs in a fork and restores them in a copy branched into compacted history", async () => {
		const session = await fileBackedSession();
		const history = appendHistory(session);
		await session.flush();
		const sessionFile = session.getSessionFile() ?? "";

		const forked = await SessionManager.forkFrom(sessionFile, root, sessionDir);
		expect(isBlobRef(imageOf(entryById(forked, history.userIds[0])))).toBe(true);
		expect(imageOf(entryById(forked, history.userIds[FIRST_KEPT_TURN]))).toBe(image(FIRST_KEPT_TURN));
		await forked.close();

		session.createBranchedSession(history.userIds[1]);
		expect(imageOf(entryById(session, history.userIds[0]))).toBe(image(0));
		expect(imageOf(entryById(session, history.userIds[1]))).toBe(image(1));
		await session.close();
	});

	it("keeps images inline in a session that is not persisted", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "start", timestamp: 0 });
		session.appendMessage(makeAssistantMessage());
		const history = appendHistory(session);

		for (const [turn, id] of history.userIds.entries()) {
			expect(imageOf(entryById(session, id))).toBe(image(turn));
		}
	});

	it("hands session_before_tree the images of archived entries, not blob refs", async () => {
		const session = await fileBackedSession();
		const history = appendHistory(session);
		const seen: string[] = [];
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_before_tree",
			emit: async (event: { type: string; preparation?: { entriesToSummarize: SessionEntry[] } }) => {
				for (const entry of event.preparation?.entriesToSummarize ?? []) {
					if (entry.type === "message" && entry.message.role === "user") seen.push(imageOf(entry));
				}
				return undefined;
			},
		} as unknown as ExtensionRunner;
		const agentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["test"],
					tools: [],
				},
			}),
			sessionManager: session,
			settings: Settings.isolated(),
			modelRegistry: {} as never,
			extensionRunner,
		});

		// The first assistant reply is an ancestor of the archived turns the move abandons.
		const target = session.getBranch(history.userIds[0]).at(-1);
		const reply = session.getEntries().find(entry => entry.parentId === target?.id);
		await agentSession.navigateTree(reply?.id ?? "", { summarize: false });

		expect(seen).toContain(image(1));
		expect(seen.some(data => isBlobRef(data))).toBe(false);
		await agentSession.dispose();
	});
});

describe("inlineBlobRefsSync", () => {
	let root: string;
	let blobs: BlobStore;

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-inline-blobs-")));
		blobs = new BlobStore(path.join(root, "blobs"));
	});

	afterEach(() => {
		removeSyncWithRetries(root);
	});

	it("restores image payloads, data URLs and generated images without touching its input", () => {
		const bytes = Buffer.from("png-bytes".repeat(200));
		const ref = blobs.putSync(bytes).ref;
		const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
		const urlRef = blobs.putSync(Buffer.from(dataUrl, "utf8")).ref;
		const original = {
			content: [
				{ type: "text", text: "kept as is" },
				{ type: "image", data: ref, mimeType: "image/png" },
			],
			payload: { type: "image_generation_call", result: ref },
			parts: [{ type: "input_image", image_url: urlRef }],
		};

		const restored = inlineBlobRefsSync(original, blobs);

		expect(restored.content[1]).toEqual({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
		expect(restored.payload.result).toBe(bytes.toString("base64"));
		expect(restored.parts[0]?.image_url).toBe(dataUrl);
		expect(restored.content[0]).toBe(original.content[0]);
		expect(original.content[1]).toEqual({ type: "image", data: ref, mimeType: "image/png" });
		expect(original.parts[0]?.image_url).toBe(urlRef);
	});

	it("returns the same object when nothing needs restoring and leaves snapcompact frames as refs", () => {
		const plain = { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] };
		expect(inlineBlobRefsSync(plain, blobs)).toBe(plain);

		const ref = blobs.putSync(Buffer.from("frame".repeat(400))).ref;
		const archive = { preserveData: { snapcompact: { frames: [{ data: ref, mimeType: "image/png" }] } } };
		expect(inlineBlobRefsSync(archive, blobs)).toBe(archive);
	});

	it("returns a value too deeply nested to walk unchanged instead of overflowing the stack", () => {
		const ref = blobs.putSync(Buffer.from("deep".repeat(400))).ref;
		let deep: unknown = { content: [{ type: "image", data: ref, mimeType: "image/png" }] };
		for (let depth = 0; depth < 50_000; depth++) deep = { next: deep };

		expect(inlineBlobRefsSync(deep, blobs)).toBe(deep);
	});

	it("keeps the ref of a blob that is gone instead of failing", () => {
		const missing = `blob:sha256:${"0".repeat(64)}`;
		const value = { content: [{ type: "image", data: missing, mimeType: "image/png" }] };
		expect(inlineBlobRefsSync(value, blobs).content[0]?.data).toBe(missing);
	});
});
