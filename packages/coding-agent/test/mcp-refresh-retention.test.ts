import { expect, test } from "bun:test";
import * as path from "node:path";

interface ProbeResult {
	toolCount: number;
	mcpTools: number;
	adapters: number;
}

const probePath = path.join(import.meta.dir, "fixtures", "mcp-refresh-retention-probe.ts");

// A `Bun.gc(true)` before the heap snapshot does not guarantee every obsolete
// tool-wrapper generation has been reclaimed at the moment the snapshot is
// taken, so the raw node count is a timing observation rather than an
// invariant (issue #11976). Two JSC mechanisms pin stale cells:
// - the conservative stack scan, which the probe itself defends against by
//   refreshing in a popped frame and collecting from fresh event-loop turns;
// - the concurrent optimizing JIT, whose in-flight compile plans are strong
//   roots for the values they froze. On a loaded CI box the compile thread
//   starves and every fresh process pins a whole generation (`mcpTools` 100
//   vs 50), so the probe compiles synchronously. (`useJIT=0` would be
//   stricter, but on macOS it also drops `SharedArrayBuffer`.)
// The retained contract is that obsolete generations are *collectible* — a
// real leak (the pre-#11784 bug) pins them in every process and can never
// settle to `toolCount`. GC residue is per-process, so re-running the probe in
// a fresh process clears it. Accept the first run that settles to exactly one
// live generation; only assert on the final run if none do.
const MAX_ATTEMPTS = 4;

async function runProbe(): Promise<ProbeResult> {
	const proc = Bun.spawn([process.execPath, probePath], {
		cwd: path.join(import.meta.dir, "../../.."),
		env: { ...process.env, BUN_JSC_useConcurrentJIT: "0" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as ProbeResult;
}

test("MCP refresh releases obsolete tool wrapper generations", async () => {
	let last: ProbeResult | undefined;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const result = await runProbe();
		last = result;
		if (result.mcpTools === result.toolCount && result.adapters === result.toolCount) return;
	}
	expect(last!.mcpTools, `unsettled after ${MAX_ATTEMPTS} attempts`).toBe(last!.toolCount);
	expect(last!.adapters, `unsettled after ${MAX_ATTEMPTS} attempts`).toBe(last!.toolCount);
}, 60_000);
