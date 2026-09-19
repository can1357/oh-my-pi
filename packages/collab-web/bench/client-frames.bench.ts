/**
 * Benchmark: guest entries append — copy-per-frame vs push+publish-copy.
 *
 * Drives 5,000 synthetic `entry` frames through applyFrameForTest. Before:
 * every frame copied the whole array (O(n) pointers per frame → quadratic).
 * After: frames push amortized; the snapshot array is copied once per commit.
 *
 * Run: bun packages/collab-web/bench/client-frames.bench.ts
 */
import type { HostFrame, SessionEntry } from "@oh-my-pi/pi-wire";
import { GuestClient } from "../src/lib/client";
import { COLLAB_PROTO, encodeBase64Url } from "../src/lib/link";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const N = 5000;

function entryFrame(i: number): HostFrame {
	const entry: SessionEntry = {
		type: "message",
		id: `m${i}`,
		parentId: null,
		timestamp: "2026-06-12T00:00:01Z",
		message: { role: "user", content: `m${i}`, timestamp: 1 },
	};
	return { t: "entry", entry };
}

const client = new GuestClient(LINK, "bench");
client.applyFrameForTest({
	t: "welcome",
	proto: COLLAB_PROTO,
	header: { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" },
	state: { isStreaming: false, queuedMessageCount: 0, cwd: "/work", participants: [] },
	agents: [],
	entryCount: 0,
});

const start = Bun.nanoseconds();
for (let i = 0; i < N; i++) client.applyFrameForTest(entryFrame(i));
const ms = (Bun.nanoseconds() - start) / 1e6;
const count = client.getSnapshot().entries.length;
if (count !== N) throw new Error(`expected ${N} entries, got ${count}`);
console.log(`${N} entry frames: ${ms.toFixed(1)}ms total (${((ms / N) * 1000).toFixed(1)}us/frame, entries=${count})`);
