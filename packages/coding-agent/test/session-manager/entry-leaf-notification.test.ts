import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	type ReplicationSnapshot,
	SessionManager,
	SessionPersistenceIndeterminateError,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const modelUsage = {
	purpose: "auto-thinking",
	role: "smol",
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-haiku-4-5",
	stopReason: "stop",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
} as const;

const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

/** What a sequenced client receives for one append: a copy of the entry and the host's leaf when it was announced. */
interface Frame {
	entry: SessionEntry;
	leafId: string | null;
}

function recordFrames(manager: SessionManager): Frame[] {
	const frames: Frame[] = [];
	manager.subscribeEntryAppended((entry, leafId) => frames.push({ entry: structuredClone(entry), leafId }));
	return frames;
}

/** A replica fed the frames in the order they were announced, as a hosted client applies them. */
function replay(frames: readonly Frame[]): SessionManager {
	const replica = SessionManager.inMemory();
	for (const { entry, leafId } of frames) replica.ingestReplicatedEntry(structuredClone(entry), { leafId });
	return replica;
}

/** How a held publish ends: it fails once (the repair then succeeds), or fails with every write until recovered. */
type HeldPublishFailure = "once" | "until-recovered";

/** Memory storage whose next atomic publish can be held open: the window in which a batch's entries are withheld. */
class HoldingStorage extends MemorySessionStorage {
	#hold: { started: () => void; release: Promise<void>; failure: HeldPublishFailure | undefined } | undefined;
	#failing = false;

	holdNextPublish(failure?: HeldPublishFailure): {
		started: Promise<void>;
		release: () => void;
		/** Ends `until-recovered`: later writes go through. */
		recover: () => void;
	} {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		this.#hold = { started: started.resolve, release: release.promise, failure };
		return {
			started: started.promise,
			release: release.resolve,
			recover: () => {
				this.#failing = false;
			},
		};
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		const hold = this.#hold;
		this.#hold = undefined;
		if (hold) {
			hold.started();
			await hold.release;
			this.#failing = hold.failure === "until-recovered";
			if (hold.failure) throw new Error("publish failed");
		}
		if (this.#failing) throw new Error("publish failed");
		await super.writeTextAtomic(path, content, options);
	}
}

/** A persisted host with one entry on disk, so the next `appendEntriesAtomically` really publishes. */
async function openHost(): Promise<{ host: SessionManager; storage: HoldingStorage; frames: Frame[]; root: string }> {
	const storage = new HoldingStorage();
	const host = SessionManager.create("/cwd", "/sessions", storage);
	const frames = recordFrames(host);
	const root = host.appendMessage(user("root"));
	await host.ensureOnDisk();
	return { host, storage, frames, root };
}

describe("subscribeEntryAppended leaf", () => {
	it("tells listeners the active leaf the append left, which is not the entry for an off-branch append", () => {
		const manager = SessionManager.inMemory();
		const seen: Array<{ id: string; leafId: string | null; managerLeaf: string | null }> = [];
		manager.subscribeEntryAppended((entry, leafId) =>
			seen.push({ id: entry.id, leafId, managerLeaf: manager.getLeafId() }),
		);

		const root = manager.appendMessage(user("root"));
		const tip = manager.appendMessage(user("tip"));
		const retained = manager.appendMessageToBranch(user("retained"), root);
		const lateUsage = manager.appendModelUsage(modelUsage, { sessionId: manager.getSessionId(), parentId: root });
		const tipUsage = manager.appendModelUsage(modelUsage, { sessionId: manager.getSessionId(), parentId: tip });

		expect(lateUsage).toBeDefined();
		expect(tipUsage).toBeDefined();
		// On the branch the entry is the leaf; off it the leaf stays at the tip. Listeners saw the settled value,
		// not the transient one the entry had inside the append.
		expect(seen.map(({ id, leafId }) => [id, leafId])).toEqual([
			[root, root],
			[tip, tip],
			[retained, tip],
			[lateUsage!, tip],
			[tipUsage!, tipUsage!],
		]);
		for (const { leafId, managerLeaf } of seen) expect(leafId).toBe(managerLeaf);
	});

	it("applies the host's final leaf when a replica ingests a sequenced entry", () => {
		const host = SessionManager.inMemory();
		const frames = recordFrames(host);

		const root = host.appendMessage(user("root"));
		const tip = host.appendMessage(user("tip"));
		host.appendMessageToBranch(user("retained"), root);
		const replica = replay(frames);

		expect(replica.getEntries()).toHaveLength(3);
		expect(replica.getLeafId()).toBe(tip);
		expect(replica.getBranch().map(entry => entry.id)).toEqual(host.getBranch().map(entry => entry.id));
	});

	it("keeps a replica's leaf until the entry the host named arrives", () => {
		const replica = SessionManager.inMemory();
		const message = (id: string, parentId: string | null): SessionEntry => ({
			type: "message",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			message: user(id),
		});

		replica.ingestReplicatedEntry(message("aaaaaaaa", null), { leafId: "aaaaaaaa" });
		// The host announces a batch entry by entry but names the leaf it has by then: the batch's last entry.
		replica.ingestReplicatedEntry(message("bbbbbbbb", "aaaaaaaa"), { leafId: "cccccccc" });
		replica.ingestReplicatedEntry(message("cccccccc", "bbbbbbbb"), { leafId: "cccccccc" });

		expect(replica.getLeafId()).toBe("cccccccc");
		expect(replica.getBranch().map(entry => entry.id)).toEqual(["aaaaaaaa", "bbbbbbbb", "cccccccc"]);

		// While it has not arrived, the replica stays on the branch it showed.
		const waiting = SessionManager.inMemory();
		waiting.ingestReplicatedEntry(message("aaaaaaaa", null), { leafId: "aaaaaaaa" });
		waiting.ingestReplicatedEntry(message("bbbbbbbb", "aaaaaaaa"), { leafId: "cccccccc" });
		expect(waiting.getLeafId()).toBe("aaaaaaaa");
		expect(waiting.getEntries()).toHaveLength(2);
	});

	it("adopts a host title change into the replica's title state without journaling a second entry", async () => {
		const host = SessionManager.inMemory();
		const replica = SessionManager.inMemory();
		const renamed: string[] = [];
		replica.onSessionNameChanged(() => renamed.push(replica.getSessionName() ?? ""));
		host.subscribeEntryAppended((entry, leafId) => replica.ingestReplicatedEntry(structuredClone(entry), { leafId }));

		host.appendMessage(user("hello"));
		await host.setSessionName("Hosted rename", "user");

		expect(replica.getSessionName()).toBe("Hosted rename");
		expect(renamed).toEqual(["Hosted rename"]);
		expect(replica.getEntries().map(entry => entry.type)).toEqual(["message", "title_change"]);
		expect(replica.getEntries()).toEqual(host.getEntries());
		// Collab guests (no authoritative marker) keep their previous behavior: the entry is journaled only.
		const guest = SessionManager.inMemory();
		for (const entry of host.getEntries()) guest.ingestReplicatedEntry(structuredClone(entry));
		expect(guest.getSessionName()).toBeUndefined();
	});
});

describe("entries announced after an atomic batch settles", () => {
	it("announces a successful batch in record order, each entry with the leaf the batch settled on", async () => {
		const { host, storage, frames, root } = await openHost();
		const publish = storage.holdNextPublish();
		let first = "";
		let second = "";
		const commit = host.appendEntriesAtomically(() => {
			first = host.appendMessage(user("one"));
			second = host.appendMessage(user("two"));
		});
		await publish.started;
		// Withheld until the batch is durable.
		expect(frames.map(frame => frame.entry.id)).toEqual([root]);

		publish.release();
		await commit;

		expect(host.getLeafId()).toBe(second);
		expect(frames.map(({ entry, leafId }) => [entry.id, leafId])).toEqual([
			[root, root],
			[first, second],
			[second, second],
		]);
		const replica = replay(frames);
		expect(replica.getLeafId()).toBe(second);
		expect(replica.getBranch().map(entry => entry.id)).toEqual([root, first, second]);
	});

	it("announces a rename, a retained result and a usage record made meanwhile after the batch, on the leaf the host reached", async () => {
		const { host, storage, frames, root } = await openHost();
		const publish = storage.holdNextPublish();
		let first = "";
		let second = "";
		const commit = host.appendEntriesAtomically(() => {
			first = host.appendMessage(user("one"));
			second = host.appendMessage(user("two"));
		});
		await publish.started;

		const retained = host.appendMessageToBranch(user("retained"), root);
		const usage = host.appendModelUsage(modelUsage, { sessionId: host.getSessionId(), parentId: root });
		const renamed = host.setSessionName("Named mid-batch", "user");
		const title = host.getEntries().at(-1)!.id;
		// Nothing overtakes the batch it was recorded after.
		expect(frames.map(frame => frame.entry.id)).toEqual([root]);

		publish.release();
		await commit;
		await renamed;

		expect(host.getLeafId()).toBe(title);
		expect(frames.map(frame => frame.entry.id)).toEqual([root, first, second, retained, usage!, title]);
		// The host is on the title by the time anything is announced, so that is the leaf every frame after the root names.
		for (const frame of frames.slice(1)) expect(frame.leafId).toBe(title);

		const replica = replay(frames);
		expect(replica.getLeafId()).toBe(title);
		expect(replica.getBranch().map(entry => entry.id)).toEqual([root, first, second, title]);
		expect(replica.getEntries().map(entry => entry.id)).toEqual(frames.map(frame => frame.entry.id));
		expect(replica.getSessionName()).toBe("Named mid-batch");
	});

	it("announces what a listener records meanwhile after the entries still waiting, so the replica never meets a leaf before its entry", async () => {
		const { host, storage, frames, root } = await openHost();
		let first = "";
		let second = "";
		let late = "";
		// Records a retained result as soon as the batch's first entry is announced.
		host.subscribeEntryAppended(entry => {
			if (entry.id === first && !late) late = host.appendMessageToBranch(user("late"), root);
		});
		const publish = storage.holdNextPublish();
		const commit = host.appendEntriesAtomically(() => {
			first = host.appendMessage(user("one"));
			second = host.appendMessage(user("two"));
		});
		await publish.started;
		publish.release();
		await commit;

		expect(frames.map(frame => frame.entry.id)).toEqual([root, first, second, late]);
		for (const frame of frames.slice(1)) expect(frame.leafId).toBe(second);
		const replica = replay(frames);
		expect(replica.getLeafId()).toBe(second);
		expect(replica.getBranch().map(entry => entry.id)).toEqual([root, first, second]);
		expect(replica.getEntries()).toHaveLength(4);
	});

	it("shows every listener an entry before the entries recorded while it was being announced", () => {
		const manager = SessionManager.inMemory();
		let nested: string | undefined;
		// The first listener records an entry while the second has not yet been told about the one that caused it.
		manager.subscribeEntryAppended(() => {
			nested ??= manager.appendMessage(user("from a listener"));
		});
		const order: string[] = [];
		manager.subscribeEntryAppended(entry => order.push(entry.id));

		const first = manager.appendMessage(user("first"));

		expect(order).toEqual([first, nested!]);
	});
});

describe("snapshotForReplication announcedOnly", () => {
	const announced = (manager: SessionManager) =>
		manager.snapshotForReplication(value => value, { announcedOnly: true });

	it("is the live state when nothing is waiting to be announced", async () => {
		const { host, root } = await openHost();
		await host.setSessionName("Settled", "user");

		const snapshot = announced(host);

		expect(snapshot.entries.map(entry => entry.id)).toEqual(host.getEntries().map(entry => entry.id));
		expect(snapshot.leafId).toBe(host.getLeafId());
		expect(snapshot.header.title).toBe("Settled");
		expect(snapshot.sessionName).toBe("Settled");
		expect(snapshot.entries[0].id).toBe(root);
	});

	it("leaves out a batch that is still publishing and what was recorded meanwhile, then the replica gets each entry once", async () => {
		const { host, storage, frames, root } = await openHost();
		await host.setSessionName("Before", "user");
		const beforeTitle = host.getLeafId()!;
		const publish = storage.holdNextPublish();
		let first = "";
		let second = "";
		const commit = host.appendEntriesAtomically(() => {
			first = host.appendMessage(user("one"));
			second = host.appendMessage(user("two"));
		});
		await publish.started;
		const retained = host.appendMessageToBranch(user("retained"), root);
		const renamed = host.setSessionName("During", "user");
		const duringTitle = host.getLeafId()!;

		// A client attaching now starts from what has been announced: none of the batch, not its leaf, not its title.
		const snapshot = announced(host);
		const announcedBefore = frames.length;
		expect(snapshot.entries.map(entry => entry.id)).toEqual([root, beforeTitle]);
		expect(snapshot.leafId).toBe(beforeTitle);
		expect(snapshot.header.title).toBe("Before");
		expect(snapshot.sessionName).toBe("Before");
		// The live view, and the collab snapshot, are unchanged: the host's own state includes the batch.
		expect(host.getLeafId()).toBe(duringTitle);
		expect(host.snapshotForReplication().entries.map(entry => entry.id)).toEqual([
			root,
			beforeTitle,
			first,
			second,
			retained,
			duringTitle,
		]);
		expect(host.snapshotForReplication().leafId).toBe(duringTitle);

		publish.release();
		await commit;
		await renamed;

		const replica = SessionManager.inMemory();
		for (const entry of snapshot.entries) {
			replica.ingestReplicatedEntry(structuredClone(entry), { leafId: snapshot.leafId });
		}
		for (const { entry, leafId } of frames.slice(announcedBefore)) {
			replica.ingestReplicatedEntry(structuredClone(entry), { leafId });
		}
		expect(replica.getEntries().map(entry => entry.id)).toEqual(host.getEntries().map(entry => entry.id));
		expect(replica.getLeafId()).toBe(host.getLeafId());
		expect(replica.getBranch().map(entry => entry.id)).toEqual(host.getBranch().map(entry => entry.id));
		expect(replica.getSessionName()).toBe("During");
		// After the commit the snapshot is the whole session again.
		expect(announced(host).entries.map(entry => entry.id)).toEqual(host.getEntries().map(entry => entry.id));
		expect(announced(host).leafId).toBe(duringTitle);
	});

	it("never contains a batch that rolls back, and announces what survived it once", async () => {
		const { host, storage, frames, root } = await openHost();
		const publish = storage.holdNextPublish("once");
		const commit = host.appendEntriesAtomically(() => {
			host.appendMessage(user("staged"));
		});
		const outcome = commit.then(
			() => "committed",
			(error: Error) => error.message,
		);
		await publish.started;
		const retained = host.appendMessageToBranch(user("retained"), root);

		const duringPublish = announced(host);
		expect(duringPublish.entries.map(entry => entry.id)).toEqual([root]);
		expect(duringPublish.leafId).toBe(root);

		publish.release();
		expect(await outcome).toBe("publish failed");

		// The staged entry is gone for good; the concurrent one survived and was announced once, after the rollback.
		expect(frames.map(frame => frame.entry.id)).toEqual([root, retained]);
		const afterwards = announced(host);
		expect(afterwards.entries.map(entry => entry.id)).toEqual([root, retained]);
		expect(afterwards.leafId).toBe(host.getLeafId());
		expect(afterwards.leafId).toBe(root);
	});

	it("shows the announced title while a newer one is withheld, even once the batch is gone because its publish and repair both failed", async () => {
		const { host, storage, frames, root } = await openHost();
		await host.setSessionName("Before", "user");
		const beforeTitle = host.getLeafId()!;
		const publish = storage.holdNextPublish("until-recovered");
		const commit = host.appendEntriesAtomically(() => {
			host.appendMessage(user("staged"));
		});
		await publish.started;
		// Recorded while the batch publishes, so it is retained by the rollback and held until it is durable.
		// Its own persistence outcome is not what is under test, only that it is handled.
		host.setSessionName("During", "user").catch(() => undefined);
		const duringTitle = host.getLeafId()!;

		publish.release();
		await expect(commit).rejects.toBeInstanceOf(SessionPersistenceIndeterminateError);

		// The batch is cleared; the staged row is gone and the new title is withheld: the host's live state is ahead.
		expect(host.getSessionName()).toBe("During");
		expect(host.getLeafId()).toBe(duringTitle);
		expect(frames.map(frame => frame.entry.id)).toEqual([root, beforeTitle]);
		const withheld = announced(host);
		expect(withheld.entries.map(entry => entry.id)).toEqual([root, beforeTitle]);
		expect(withheld.leafId).toBe(beforeTitle);
		expect(withheld.header.title).toBe("Before");
		expect(withheld.header.titleSource).toBe("user");
		expect(withheld.sessionName).toBe("Before");
		// The default snapshot is the live state, unchanged.
		expect(host.snapshotForReplication().header.title).toBe("During");
		expect(host.snapshotForReplication().sessionName).toBe("During");

		// Once the store accepts the journal the held title is announced, and the snapshot is the live one again.
		publish.recover();
		await host.recoverPersistenceFromCurrentState();
		expect(frames.map(frame => frame.entry.id)).toEqual([root, beforeTitle, duringTitle]);
		const recovered = announced(host);
		expect(recovered.entries.map(entry => entry.id)).toEqual([root, beforeTitle, duringTitle]);
		expect(recovered.leafId).toBe(duringTitle);
		expect(recovered.header.title).toBe("During");
		expect(recovered.sessionName).toBe("During");
	});

	it("shows the announced title to a snapshot taken while a rename still waits in the announcement queue", async () => {
		const host = SessionManager.inMemory();
		await host.setSessionName("Before", "user");
		const beforeTitle = host.getLeafId()!;
		let duringDrain: ReplicationSnapshot | undefined;
		host.subscribeEntryAppended(entry => {
			if (entry.type !== "message" || duringDrain) return;
			// Recorded while `entry` is being announced: the rename queues behind it, unannounced.
			void host.setSessionName("During", "user");
			duringDrain = announced(host);
		});

		const message = host.appendMessage(user("hello"));

		expect(duringDrain?.entries.map(entry => entry.id)).toEqual([beforeTitle, message]);
		expect(duringDrain?.leafId).toBe(message);
		expect(duringDrain?.header.title).toBe("Before");
		expect(duringDrain?.sessionName).toBe("Before");
		// The drain finished: the rename was announced, and the snapshot is the live one.
		expect(host.getSessionName()).toBe("During");
		const settled = announced(host);
		expect(settled.entries).toHaveLength(3);
		expect(settled.header.title).toBe("During");
		expect(settled.sessionName).toBe("During");
	});
});
