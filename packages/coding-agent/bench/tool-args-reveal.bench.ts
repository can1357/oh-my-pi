/**
 * Benchmark: streamed-args string decode — per-char concat vs chunked runs.
 *
 * Feeds a 1MB `content` payload in 8KB deltas through the reveal controller
 * path (setTarget + ~ticks). Before: #appendTarget did one concat + record
 * store per character (~1M ops). After: straight-text runs append in one
 * slice into a chunk list joined once per update.
 *
 * Run: bun packages/coding-agent/bench/tool-args-reveal.bench.ts
 */
import { decodeStreamedToolArgs } from "../src/modes/controllers/tool-args-reveal";

const PAYLOAD = "x".repeat(1024 * 1024);
const prefix = `{"content":${JSON.stringify(PAYLOAD).slice(0, 512 * 1024)}`;
const full = `{"content":${JSON.stringify(PAYLOAD)}}`;

const source = { rawInput: false, streamingStringKeys: ["content"] as const };

// Correctness: chunked decode must equal the plain decode byte-for-byte.
const a = decodeStreamedToolArgs(full, source);
const expected = JSON.parse(full) as Record<string, unknown>;
if (a.content !== expected.content) throw new Error("chunked decode diverged from JSON.parse");

const N = 20;
const start = Bun.nanoseconds();
for (let i = 0; i < N; i++) decodeStreamedToolArgs(prefix, source);
const ms = (Bun.nanoseconds() - start) / 1e6;
console.log(`decode 512KB-prefix content x${N}: ${ms.toFixed(1)}ms total (${(ms / N).toFixed(2)}ms/op)`);
