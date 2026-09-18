/**
 * Benchmark: RotatingFileSink per-line syscalls (utils finding 7).
 *
 * Before: constructor discarded an open fd, then every write did
 * open+write+close (appendFileSync) plus a Buffer.byteLength rescan.
 * After: one held fd per active file (reopened on rotation), writeSync with
 * a completion loop, byte count from the encoded buffer.
 *
 * Run: bun packages/utils/bench/logger-sink.bench.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RotatingFileSink } from "../src/logger/rotating-file";

const dir = await Bun.file(".")
	.stat()
	.then(() => fs.mkdtempSync(path.join(os.tmpdir(), "omp-logger-bench-")));
const N = 20_000;
const line = `{"timestamp":"2026-09-17T00:00:00.000+00:00","level":"info","pid":1,"message":"tool result received","tool":"read","ms":12}`;

const sink = new RotatingFileSink({
	directory: dir,
	filenamePrefix: "bench",
	filenameSuffix: "test",
	maxBytes: 100 * 1024 * 1024,
	maxFiles: 2,
	auditFile: path.join(dir, "audit.json"),
});
const start = Bun.nanoseconds();
for (let i = 0; i < N; i++) sink.write(`${line} ${i}`);
const ms = (Bun.nanoseconds() - start) / 1e6;
sink.close();
console.log(`RotatingFileSink.write x${N}: ${ms.toFixed(1)}ms total (${((ms / N) * 1000).toFixed(1)}us/op)`);
await Bun.file(dir)
	.stat()
	.then(() => fs.rmSync(dir, { recursive: true, force: true }));
