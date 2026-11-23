import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Regression for #10930: a one-shot CLI run whose stdout consumer closes before
// the write drains (`omp --help | head`, `| less` then `q`, `| grep -m1`,
// `| true`) used to take the fatal path — Bun surfaced the broken-pipe EPIPE as
// an unhandled rejection/uncaught exception and `omp` exited 1 with an
// `[Uncaught Exception] Error: EPIPE: broken pipe, write` dump. The CLI
// process-entry now registers `registerStdioDisconnectHandling()`, so a vanished
// stdout peer is an ordinary Unix disconnect: cleanup runs and the process exits
// 0 with no fatal output. Interactive launches register their own terminal
// lifetime; help/version/subcommand launches never start one.

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");

// The pipe-close semantics under test are Unix-specific and PIPESTATUS is a bash
// builtin; Windows has neither the SIGPIPE model nor the same pipeline exit shape.
it.skipIf(process.platform === "win32")(
	"exits 0 without a fatal dump when the stdout consumer closes early",
	async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cli-epipe-"));
		const errPath = path.join(tmpDir, "omp.err");
		try {
			// `| true` closes the read end of the pipe immediately, so `omp`'s help
			// write hits a broken pipe regardless of output size. PIPESTATUS[0] is
			// the middle command's (omp's) exit code, not the pipeline's.
			const script = `"${process.execPath}" "${cliEntry}" --help 2>"${errPath}" | true; echo "\${PIPESTATUS[0]}"`;
			const proc = Bun.spawn(["bash", "-c", script], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			});
			const [, pipestatusText] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
			const ompExit = Number(pipestatusText.trim());
			const ompStderr = await fs.readFile(errPath, "utf8").catch(() => "");

			expect(ompStderr).not.toContain("EPIPE");
			expect(ompStderr).not.toContain("Uncaught Exception");
			expect(ompStderr).not.toContain("Unhandled Rejection");
			expect(ompExit).toBe(0);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	},
);
