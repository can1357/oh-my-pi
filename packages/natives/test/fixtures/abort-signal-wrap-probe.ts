import { dlopen, FFIType } from "bun:ffi";
import { Shell } from "../../native/index.js";

process.stderr.write("INIT\n");
const mode = process.argv[2] === "shared" ? "shared" : "fresh";
const warmup = Number(process.env.PROBE_WARMUP ?? "2000");
const count = Number(process.env.PROBE_COUNT ?? (mode === "shared" ? "50000" : "10000"));
if (!Number.isSafeInteger(warmup) || warmup < 0) {
	throw new Error(`invalid PROBE_WARMUP: ${String(process.env.PROBE_WARMUP)}`);
}
if (!Number.isSafeInteger(count) || count <= 0) {
	throw new Error(`invalid PROBE_COUNT: ${String(process.env.PROBE_COUNT)}`);
}
const drainPasses = 3;
const drainTurnsPerPass = 40;

const libc = mode === "shared" ? dlopen("libc.so.6", { malloc_stats: { args: [], returns: FFIType.void } }) : undefined;

async function drain(): Promise<void> {
	for (let pass = 0; pass < drainPasses; pass++) {
		Bun.gc(true);
		for (let i = 0; i < drainTurnsPerPass; i++) {
			await Bun.sleep(0);
		}
	}
	await Bun.sleep(10);
}

function dumpMimalloc(): void {
	process.stderr.write("MIDUMP-BEGIN\n");
	Bun.unsafe.mimallocDump();
	process.stderr.write("MIDUMP-END\n");
}

function dumpMallocStats(): void {
	process.stderr.write("MALLOC-STATS-BEGIN\n");
	libc?.symbols.malloc_stats();
	process.stderr.write("MALLOC-STATS-END\n");
}

async function runFresh(shell: Shell, n: number): Promise<void> {
	for (let i = 0; i < n; i++) {
		const res = await shell.run({ command: "true", signal: new AbortController().signal });
		if (res.exitCode !== 0) {
			throw new Error(`shell.run exited with ${String(res.exitCode)}`);
		}
	}
}

async function runSharedAndDump(shell: Shell, n: number): Promise<void> {
	const ac = new AbortController();
	const signal = ac.signal;
	for (let i = 0; i < n; i++) {
		const res = await shell.run({ command: "true", signal });
		if (res.exitCode !== 0) {
			throw new Error(`shell.run exited with ${String(res.exitCode)}`);
		}
	}
	// Keep `ac` / `signal` live through the build-up dump; it becomes unreachable once this function returns.
	if (signal.aborted) throw new Error("unexpected abort");
	dumpMallocStats();
}

try {
	const shell = new Shell();
	await runFresh(shell, warmup);
	await drain();

	if (mode === "shared") {
		dumpMallocStats();
		await runSharedAndDump(shell, count);
		await drain();
		dumpMallocStats();
	} else {
		dumpMimalloc();
		await runFresh(shell, count);
		await drain();
		dumpMimalloc();
	}
} finally {
	libc?.close();
}
