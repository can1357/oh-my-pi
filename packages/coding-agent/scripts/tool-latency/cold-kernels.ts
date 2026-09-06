import * as fs from "node:fs/promises";
import * as path from "node:path";
import { summarize } from "./sampling";

export async function measureColdKernels(runs: number, fixture: string, python?: string) {
	const rows = [];
	for (const route of python ? ["js", "python"] : ["js"]) {
		const raw: Array<{ firstCellMs: number; secondCellMs: number; processMs: number }> = [];
		const errors: string[] = [];
		for (let i = 0; i < runs; i++) {
			const scratch = await fs.mkdtemp(path.join(fixture, "cold-"));
			try {
				const started = performance.now();
				const child = Bun.spawn(
					[
						process.execPath,
						path.join(import.meta.dir, "cold-kernel-probe.ts"),
						route,
						...(route === "python" ? [python!] : []),
					],
					{
						cwd: scratch,
						env: { ...process.env, PI_CODING_AGENT_DIR: path.join(scratch, "agent") },
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
						timeout: 60_000,
					},
				);
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				const processMs = performance.now() - started;
				if (exitCode !== 0) throw new Error(`child exit ${exitCode}: ${stderr.trim()}`);
				const value = JSON.parse(stdout) as { firstCellMs?: unknown; secondCellMs?: unknown };
				if (
					typeof value.firstCellMs !== "number" ||
					!Number.isFinite(value.firstCellMs) ||
					value.firstCellMs < 0 ||
					typeof value.secondCellMs !== "number" ||
					!Number.isFinite(value.secondCellMs) ||
					value.secondCellMs < 0
				)
					throw new Error("Invalid cold-kernel timing report");
				raw.push({ firstCellMs: value.firstCellMs, secondCellMs: value.secondCellMs, processMs });
			} catch (error) {
				errors.push(`sample ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				await fs.rm(scratch, { recursive: true, force: true });
			}
		}
		rows.push({
			route,
			runs,
			raw,
			firstCell: summarize(raw.map(row => row.firstCellMs)),
			secondCell: summarize(raw.map(row => row.secondCellMs)),
			process: summarize(raw.map(row => row.processMs)),
			errors,
		});
	}
	return rows;
}
