import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe.skipIf(process.platform !== "linux")("idle working-row animation", () => {
	it("paints without keyboard input during a background job and settles when stopped", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "idle-loader-"));
		const chunks: Uint8Array[] = [];
		await using terminal = new Bun.Terminal({
			cols: 80,
			rows: 24,
			data(_terminal, data) {
				chunks.push(data.slice());
			},
		});
		// script gives the fixture a controlling foreground tty, including under
		// ProcessTerminal's job-control guard. Bun.Terminal alone does not.
		const command = [process.execPath, `${import.meta.dir}/fixtures/idle-loader.ts`]
			.map(arg => `'${arg.replaceAll("'", "'\\''")}'`)
			.join(" ");
		const proc = Bun.spawn(["script", "-qec", command, "/dev/null"], {
			terminal,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_TEST_RUNTIME: undefined,
				BUN_ENV: undefined,
				NODE_ENV: undefined,
				TERM: "xterm-256color",
				TERM_PROGRAM: undefined,
				PI_TUI_NATIVE: "0",
				OMP_TUI_NATIVE: "0",
				PI_TUI_SYNC_OUTPUT: "0",
				PI_FORCE_SYNC_OUTPUT: undefined,
			},
		});
		try {
			expect(await proc.exited).toBe(0);
			terminal.close();
			const output = Buffer.concat(chunks).toString();
			const [active, rest] = output.split("IDLE-BEGIN");
			// Base paints once: the static Esc glyph never advances and sync is off.
			expect(active.match(/Working…/g)?.length ?? 0).toBeGreaterThan(10);
			expect(rest?.split("IDLE-END")[0]).toBe("");
		} finally {
			if (proc.exitCode === null) proc.kill();
			await proc.exited;
			terminal.close();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	}, 10_000);
});
