import { expect, test } from "bun:test";
import * as path from "node:path";

interface ProbeResult {
	toolCount: number;
	mcpTools: number;
	adapters: number;
}

const probePath = path.join(import.meta.dir, "fixtures", "mcp-refresh-retention-probe.ts");

// A single `Bun.gc(true)` before the heap snapshot does not guarantee every
// obsolete tool-wrapper generation has been reclaimed at the moment the
// snapshot is taken: JSC's conservative stack scan can pin a stale generation
// that a later collection releases, so the raw node count is a timing
// observation rather than an invariant (issue #11976). The retained contract
// is that obsolete generations are *collectible* — a real leak (the pre-#11784
// bug) pins them in every process and can never settle to `toolCount`. GC
// residue is per-process, so re-running the probe in a fresh process clears it.
// Accept the first run that settles to exactly one live generation; only assert
// on the final run if none do.
const MAX_ATTEMPTS = 4;

async function runProbe(): Promise<ProbeResult> {
	const proc = Bun.spawn([process.execPath, probePath], {
		cwd: path.join(import.meta.dir, "../../.."),
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
