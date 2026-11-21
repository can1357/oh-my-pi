import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as blobStore from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, getBlobsDir, setAgentDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

const FRAME_COUNT = 10;
const FRAME_RAW_BYTES = 300_000;

function frameData(index: number): string {
	return Buffer.alloc(FRAME_RAW_BYTES, index + 1).toString("base64");
}

function makeAssistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
}

function makeArchive(legacy = false, count = FRAME_COUNT): snapcompact.Archive {
	return {
		frames: Array.from({ length: count }, (_unused, index) => ({
			data: frameData(index),
			mimeType: "image/png",
			cols: 196,
			rows: 71,
			chars: 13_916,
			...(legacy ? {} : { font: "8x13" as const, variant: "bw" as const }),
		})),
		totalChars: 13_916,
		truncatedChars: legacy ? 1_500_000 : 0,
		textHead: "head",
		textTail: "tail",
	};
}

function archiveFrames(session: SessionManager, entryId: string): snapcompact.Frame[] {
	const entry = session.getEntry(entryId);
	if (entry?.type !== "compaction") throw new Error(`Expected compaction ${entryId}`);
	const archive = snapcompact.getPreservedArchive(entry.preserveData);
	if (!archive) throw new Error(`Expected an archive on ${entryId}`);
	return archive.frames;
}

function imageDataIn(messages: readonly unknown[]): string[] {
	const found: string[] = [];
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (!value || typeof value !== "object") return;
		if ("type" in value && value.type === "image" && "data" in value && typeof value.data === "string") {
			found.push(value.data);
			return;
		}
		for (const item of Object.values(value)) walk(item);
	};
	walk(messages);
	return found;
}

describe("lazy snapcompact frame resolution", () => {
	const tempDirs: string[] = [];
	const originalAgentDir = getAgentDir();
	const originalEnv = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		OMP_PROFILE: process.env.OMP_PROFILE,
		PI_PROFILE: process.env.PI_PROFILE,
	};

	async function makeTempDir(): Promise<string> {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-lazy-frames-"));
		tempDirs.push(dir);
		return dir;
	}

	async function writeJournal(
		archive: snapcompact.Archive,
	): Promise<{ sessionFile: string; sessionDir: string; compactionId: string }> {
		const cwd = await makeTempDir();
		const sessionDir = path.join(cwd, "sessions");
		const session = SessionManager.create(cwd, sessionDir);
		const anchor = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("hi"));
		const compactionId = session.appendCompaction("summary", undefined, anchor, 1000, {
			preserveData: { [snapcompact.PRESERVE_KEY]: archive },
		});
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		await session.close();
		return { sessionFile, sessionDir, compactionId };
	}

	beforeEach(async () => {
		setAgentDir(await makeTempDir());
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setAgentDir(originalAgentDir);
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await Promise.all(tempDirs.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })));
	});

	it("leaves frame blobs unread on resume and reads only the newest frames within budget", async () => {
		const { sessionFile, sessionDir, compactionId } = await writeJournal(makeArchive());
		const asyncRead = vi.spyOn(blobStore.BlobStore.prototype, "get");
		const syncRead = vi.spyOn(blobStore.BlobStore.prototype, "getSync");

		const resumed = await SessionManager.open(sessionFile, sessionDir, undefined, { suppressBreadcrumb: true });
		expect(asyncRead).not.toHaveBeenCalled();
		expect(archiveFrames(resumed, compactionId).every(frame => frame.data.startsWith("blob:sha256:"))).toBe(true);

		const images = new Set(imageDataIn(resumed.buildSessionContext().messages));
		expect(images.size).toBe(7);
		expect(images.has(frameData(3))).toBe(true);
		expect(images.has(frameData(9))).toBe(true);
		expect(syncRead).toHaveBeenCalledTimes(7);
		await resumed.close();
	});

	it("prices blob-backed legacy frames by payload bytes for the crash guard", async () => {
		const { sessionFile, sessionDir, compactionId } = await writeJournal(makeArchive(true));
		const syncRead = vi.spyOn(blobStore.BlobStore.prototype, "getSync");

		const resumed = await SessionManager.open(sessionFile, sessionDir, undefined, { suppressBreadcrumb: true });
		expect(archiveFrames(resumed, compactionId)[0]?.data).toStartWith("blob:sha256:");
		expect(imageDataIn(resumed.buildSessionContext().messages)).toEqual([]);
		expect(syncRead).not.toHaveBeenCalled();
		await resumed.close();
	});

	it("drops a missing frame blob instead of sending its reference", async () => {
		const { sessionFile, sessionDir, compactionId } = await writeJournal(makeArchive(false, 1));
		const body = await Bun.file(sessionFile).text();
		const match = body.match(/blob:sha256:([0-9a-f]{64})/);
		if (!match?.[1]) throw new Error("Expected a frame blob reference");
		await fsp.rm(path.join(getBlobsDir(), match[1]), { force: true });

		const resumed = await SessionManager.open(sessionFile, sessionDir, undefined, { suppressBreadcrumb: true });
		expect(archiveFrames(resumed, compactionId)[0]?.data).toStartWith("blob:sha256:");
		expect(imageDataIn(resumed.buildSessionContext().messages)).toEqual([]);
		await resumed.close();
	});
});
