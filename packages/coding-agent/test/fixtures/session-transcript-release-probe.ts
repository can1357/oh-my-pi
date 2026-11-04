/**
 * Child process for test/session-manager/transcript-release.test.ts. Builds a file-backed session under
 * `argv[4]`, makes the manager stop holding one transcript entry the way `argv[2]` names, and prints
 * `{ "collected": boolean }` after forcing collections while the manager itself stays reachable. With
 * `argv[3] === "held"` the probe keeps its own strong reference to the entry: the control showing that
 * retention is observable. The parent runs this with concurrent JIT compilation off.
 */
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriteOptions,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";

/** File storage whose full rewrites or appends fail while the matching flag is set. */
class FailingStorage extends FileSessionStorage {
	failRewrites = false;
	failAppends = false;

	override writeLinesSync(fpath: string, lines: Iterable<string>, options?: SessionStorageWriteOptions): void {
		if (this.failRewrites) throw new Error("EROFS: synthetic full rewrite failure");
		super.writeLinesSync(fpath, lines, options);
	}

	override async writeLinesAtomic(
		fpath: string,
		lines: Iterable<string>,
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		if (this.failRewrites) throw new Error("EROFS: synthetic full rewrite failure");
		await super.writeLinesAtomic(fpath, lines, options);
	}

	override openWriter(
		fpath: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		const writer = super.openWriter(fpath, options);
		const appendSync = (line: string): void => {
			if (this.failAppends) throw Object.assign(new Error("ENOSPC: synthetic append failure"), { code: "ENOSPC" });
			writer.appendSync?.(line);
		};
		return {
			append: async line => appendSync(line),
			appendSync,
			flush: () => writer.flush(),
			flushSync: () => writer.flushSync?.(),
			isOpen: () => writer.isOpen(),
			close: () => writer.close(),
			getError: () => writer.getError(),
		};
	}
}

const [transcript, reference, root] = process.argv.slice(2);
if (!transcript || (reference !== "dropped" && reference !== "held") || !root) {
	throw new Error("usage: session-transcript-release-probe.ts <transcript> dropped|held <root>");
}

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected built-in anthropic model to exist");
const assistantMessage = (text: string) => ({
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
	timestamp: Date.now(),
});
const userTurn = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
const sessionDir = path.join(root, "sessions");

/** The control's own strong reference. */
const held: object[] = [];

/** Kept out of the callers' frames so no strong local binding outlives the capture. */
function weakEntry(manager: SessionManager, id: string): WeakRef<object> {
	const entry = manager.getEntry(id);
	if (!entry) throw new Error(`Expected entry ${id}`);
	if (reference === "held") held.push(entry);
	return new WeakRef(entry);
}

async function session(storage: FailingStorage): Promise<SessionManager> {
	const manager = SessionManager.create(root, sessionDir, storage);
	manager.appendMessage(assistantMessage("seed"));
	manager.appendMessage(userTurn("before"));
	await manager.flush();
	return manager;
}

type Released = { manager: SessionManager; storage: FailingStorage; ref: WeakRef<object> };

const transcripts: Record<string, () => Promise<Released>> = {
	async "release-retained-entries"() {
		const storage = new FailingStorage();
		const manager = await session(storage);
		const ref = weakEntry(manager, manager.appendMessage(userTurn("released turn")));
		await manager.flush();
		manager.releaseRetainedEntries();
		return { manager, storage, ref };
	},
	async "new-session-while-rewrites-fail"() {
		const storage = new FailingStorage();
		const manager = await session(storage);
		const ref = weakEntry(manager, manager.appendMessage(userTurn("previous session turn")));
		await manager.flush();
		storage.failRewrites = true;
		await manager.newSession().catch(() => undefined);
		return { manager, storage, ref };
	},
	async "branched-session-while-rewrites-fail"() {
		const storage = new FailingStorage();
		const manager = await session(storage);
		const branchPoint = manager.appendMessage(userTurn("a"));
		const ref = weakEntry(manager, manager.appendMessage(userTurn("off-branch b")));
		manager.branch(branchPoint);
		const leaf = manager.appendMessage(userTurn("c"));
		await manager.flush();
		storage.failRewrites = true;
		manager.createBranchedSession(leaf);
		return { manager, storage, ref };
	},
	async "set-session-file-after-refused-switch"() {
		const storage = new FailingStorage();
		const manager = await session(storage);
		const other = SessionManager.create(root, sessionDir, new FileSessionStorage());
		other.appendMessage(assistantMessage("other session"));
		await other.flush();
		const otherFile = other.getSessionFile();
		if (!otherFile) throw new Error("Expected a persisted session file");
		await other.close();
		storage.failAppends = true;
		const ref = weakEntry(manager, manager.appendMessage(userTurn("refused turn")));
		const refused = await manager.newSession().then(
			() => false,
			() => true,
		);
		if (!refused) throw new Error("Expected newSession() to refuse to abandon the turn");
		storage.failAppends = false;
		await manager.setSessionFile(otherFile);
		return { manager, storage, ref };
	},
};

const run = transcripts[transcript];
if (!run) throw new Error(`unknown transcript: ${transcript}`);
const { manager, storage, ref } = await run();
let collected = false;
for (let poll = 0; poll < 20 && !collected; poll++) {
	// Collect from a fresh event-loop turn so the setup frames are off the stack.
	await Bun.sleep(0);
	Bun.gc(true);
	collected = ref.deref() === undefined;
}
// The manager stays reachable through the polls above: only the transcript it dropped may go. Its close
// reports the rewrite failure a row latched, which says nothing about what it holds.
storage.failRewrites = false;
await manager.close().catch(() => undefined);
process.stdout.write(JSON.stringify({ collected }));
