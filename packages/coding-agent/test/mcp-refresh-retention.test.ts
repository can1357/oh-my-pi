import { expect, test } from "bun:test";
import * as path from "node:path";

interface ProbeResult {
	toolCount: number;
	mcpTools: number;
	adapters: number;
}

const probePath = path.join(import.meta.dir, "fixtures", "mcp-refresh-retention-probe.ts");

// MCPTool nodes include fixture metadata and can retain arbitrary conservative-GC
// residue. The regression is an unbounded chain of CustomToolAdapter generations
// (issue #11784), so exactly one adapter generation is the retention invariant.

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
	const result = await runProbe();
	expect(result.mcpTools).toBeGreaterThanOrEqual(result.toolCount);
	expect(result.adapters).toBe(result.toolCount);
}, 60_000);
