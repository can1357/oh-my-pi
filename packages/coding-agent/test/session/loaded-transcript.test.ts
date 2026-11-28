import { afterEach, beforeEach, expect, it } from "bun:test";
import * as path from "node:path";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getBlobsDir, TempDir } from "@oh-my-pi/pi-utils";
import { useAgentDir } from "../helpers/settings-test-state";

const FILE = path.resolve("/sessions/transcript.jsonl");
const TIMESTAMP = "2025-01-01T00:00:00.000Z";
const HEADER = { type: "session", version: 3, id: "source", timestamp: TIMESTAMP };

/** What the running test acquired; afterEach releases it newest first, each release even after another throws. */
let cleanup: AsyncDisposableStack;
beforeEach(() => {
	cleanup = new AsyncDisposableStack();
});
afterEach(() => cleanup.disposeAsync());

it("hydrates image URLs in imported runtime values", async () => {
	const dir = cleanup.adopt(TempDir.createSync("@omp-runtime-blob-"), created => created.remove());
	useAgentDir(cleanup, dir.path());
	const storage = new MemorySessionStorage();
	const url = "data:image/png;base64,YWJj";
	const blob = await new BlobStore(getBlobsDir()).put(Buffer.from(url));
	const entry = {
		type: "custom",
		id: "0",
		parentId: null,
		timestamp: TIMESTAMP,
		customType: "imported",
		runtime: { version: "1", image_url: blob.ref },
	};
	storage.writeTextSync(FILE, [HEADER, entry].map(record => `${JSON.stringify(record)}\n`).join(""));

	const manager = cleanup.adopt(
		await SessionManager.open(FILE, undefined, storage, { suppressBreadcrumb: true }),
		opened => opened.close(),
	);
	// Imported runtime values carry fields `RuntimeIdentity` does not declare.
	const runtimes: unknown[] = manager.getEntries().map(loaded => loaded.runtime);
	expect(runtimes).toEqual([{ version: "1", image_url: url }]);
});

it("strips stale replay metadata from every assistant entry a fork inherits", async () => {
	const storage = new MemorySessionStorage();
	const message = {
		role: "assistant",
		api: "openai-responses",
		provider: "github-copilot",
		model: "gpt-5",
		content: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "stale" }],
		providerPayload: { type: "openaiResponsesHistory", items: [] },
		stopReason: "stop",
		timestamp: 1,
	};
	const first = { type: "message", id: "a1", parentId: null, timestamp: TIMESTAMP, message };
	const second = { ...first, id: "a2", parentId: first.id };
	storage.writeTextSync(FILE, [HEADER, first, second].map(entry => `${JSON.stringify(entry)}\n`).join(""));

	const fork = cleanup.adopt(
		await SessionManager.forkFrom(FILE, process.cwd(), path.dirname(FILE), storage, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
		}),
		forked => forked.close(),
	);

	const entries = fork.getEntries();
	expect(entries.map(entry => entry.id)).toEqual(["a1", "a2"]);
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") throw new Error("Expected assistant entry");
		expect(entry.message.providerPayload).toBeUndefined();
		const block = entry.message.content[0];
		if (block?.type !== "thinking") throw new Error("Expected thinking block");
		expect(block.thinkingSignature).toBeUndefined();
	}
});
