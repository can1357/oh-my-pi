import { Shell } from "../../native/index.js";

process.stderr.write("INIT\n");
const warmup = Number(process.env.PROBE_WARMUP ?? "2000");
const count = Number(process.env.PROBE_COUNT ?? "10000");
if (!Number.isSafeInteger(warmup) || warmup < 0) {
	throw new Error(`invalid PROBE_WARMUP: ${String(process.env.PROBE_WARMUP)}`);
}
if (!Number.isSafeInteger(count) || count <= 0) {
	throw new Error(`invalid PROBE_COUNT: ${String(process.env.PROBE_COUNT)}`);
}
const drainPasses = 3;
const drainTurnsPerPass = 40;

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

async function runFresh(shell: Shell, n: number): Promise<void> {
	for (let i = 0; i < n; i++) {
		const res = await shell.run({ command: "true", signal: new AbortController().signal });
		if (res.exitCode !== 0) {
			throw new Error(`shell.run exited with ${String(res.exitCode)}`);
		}
	}
}

const shell = new Shell();
await runFresh(shell, warmup);
await drain();

dumpMimalloc();
await runFresh(shell, count);
await drain();
dumpMimalloc();
