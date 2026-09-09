import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";

// Real embeddings (fastembed + onnxruntime-node, ~270MB) install on demand via
// `bun install` on first use. These tests assert identity filtering and FTS
// recall, not vector search, so disable embeddings; otherwise the on-demand
// install hangs each test past the 5s timeout (and starves siblings under
// parallel CI).
beforeEach(() => {
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
});

const roots: string[] = [];

function tempDb(): string {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-identity-parity-"));
	roots.push(root);
	return join(root, "mnemopi.db");
}

afterEach(() => {
	for (;;) {
		const root = roots.pop();
		if (root === undefined) break;
		rmSync(root, { recursive: true, force: true });
	}
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
});

describe("identity memory parity", () => {
	it("creates identity columns and indexes on working and episodic memory", () => {
		const beam = new BeamMemory({ sessionId: "schema", dbPath: tempDb() });
		try {
			const wmCols = new Set(
				(beam.db.query("PRAGMA table_info(working_memory)").all() as { name: string }[]).map(row => row.name),
			);
			const emCols = new Set(
				(beam.db.query("PRAGMA table_info(episodic_memory)").all() as { name: string }[]).map(row => row.name),
			);
			expect(wmCols.has("author_id")).toBe(true);
			expect(wmCols.has("author_type")).toBe(true);
			expect(wmCols.has("channel_id")).toBe(true);
			expect(emCols.has("author_id")).toBe(true);
			expect(emCols.has("author_type")).toBe(true);
			expect(emCols.has("channel_id")).toBe(true);

			const idxs = new Set(
				(
					beam.db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
						name: string;
					}[]
				).map(row => row.name),
			);
			expect(idxs.has("idx_wm_author")).toBe(true);
			expect(idxs.has("idx_wm_channel")).toBe(true);
			expect(idxs.has("idx_em_author")).toBe(true);
			expect(idxs.has("idx_em_channel")).toBe(true);
		} finally {
			beam.close();
		}
	});

	it("stores author and channel identity on remember and defaults channel to session", () => {
		const dbPath = tempDb();
		const identified = new Mnemopi({
			dbPath,
			sessionId: "session-a",
			authorId: "abdias",
			authorType: "human",
			channelId: "fluxspeak-team",
		});
		const anonymous = new Mnemopi({ dbPath, sessionId: "session-b" });
		try {
			const identifiedId = identified.remember("Dark mode preference", { importance: 0.9 });
			const anonymousId = anonymous.remember("Anonymous session memory");

			const identifiedRow = identified.conn
				.query("SELECT author_id, author_type, channel_id FROM working_memory WHERE id = ?")
				.get(identifiedId) as Record<string, unknown>;
			expect(identifiedRow).toEqual({
				author_id: "abdias",
				author_type: "human",
				channel_id: "fluxspeak-team",
			});

			const anonymousRow = identified.conn
				.query("SELECT author_id, author_type, channel_id FROM working_memory WHERE id = ?")
				.get(anonymousId) as Record<string, unknown>;
			expect(anonymousRow.author_id).toBeNull();
			expect(anonymousRow.author_type).toBeNull();
			expect(anonymousRow.channel_id).toBe("session-b");
		} finally {
			identified.close();
			anonymous.close();
		}
	});

	it("isolates recall by author, author type, and channel while preserving same-channel cross-session recall", async () => {
		const dbPath = tempDb();
		const abdias = new Mnemopi({
			dbPath,
			sessionId: "session-a",
			authorId: "abdias",
			authorType: "human",
			channelId: "team-a",
		});
		const sarah = new Mnemopi({
			dbPath,
			sessionId: "session-b",
			authorId: "sarah",
			authorType: "human",
			channelId: "team-a",
		});
		const ci = new Mnemopi({
			dbPath,
			sessionId: "session-c",
			authorId: "ci-bot",
			authorType: "agent",
			channelId: "team-b",
		});
		try {
			abdias.remember("Dark mode is preferred", { scope: "channel" });
			sarah.remember("Launch is Friday", { scope: "channel" });
			ci.remember("Deploy succeeded", { scope: "channel" });

			expect((await abdias.recall("dark", 5, { authorId: "abdias" }))[0]?.author_id).toBe("abdias");
			expect(await abdias.recall("dark", 5, { authorId: "sarah" })).toHaveLength(0);
			expect((await ci.recall("deploy", 5, { authorType: "agent" }))[0]?.author_type).toBe("agent");

			const launch = await abdias.recall("launch", 5, { channelId: "team-a" });
			expect(launch.some(row => row.author_id === "sarah" && row.channel_id === "team-a")).toBe(true);
			const teamASecrets = await abdias.recall("deploy", 5, { channelId: "team-a" });
			expect(teamASecrets.some(row => row.channel_id === "team-b")).toBe(false);
		} finally {
			abdias.close();
			sarah.close();
			ci.close();
		}
	});

	it("reports working stats through identity filters", () => {
		const dbPath = tempDb();
		const a = new Mnemopi({ dbPath, sessionId: "a1", authorId: "abdias", channelId: "team" });
		const b = new Mnemopi({ dbPath, sessionId: "b1", authorId: "sarah", channelId: "team" });
		try {
			a.remember("Memory one");
			a.remember("Memory two");
			b.remember("Memory three");

			expect(a.beam.getWorkingStats("abdias").total).toBe(2);
			expect(a.beam.getWorkingStats("nobody").total).toBe(0);
			expect(a.beam.getWorkingStats(null, null, "team").total).toBe(3);
		} finally {
			a.close();
			b.close();
		}
	});
});
