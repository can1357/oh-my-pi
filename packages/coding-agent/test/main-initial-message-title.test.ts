import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const probeEntry = path.join(import.meta.dir, "fixtures", "cli-initial-title-probe.ts");
const hasPtyHarness =
	process.platform === "linux" &&
	(await Bun.file("/usr/bin/script").exists()) &&
	(await Bun.file("/usr/bin/timeout").exists());

describe.skipIf(!hasPtyHarness)("CLI initial-message title generation", () => {
	test("generates a title for the positional initial message", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cli-title-"));
		const agentDir = path.join(root, "agent");
		const outputPath = path.join(root, "probe.json");
		try {
			await fs.mkdir(agentDir, { recursive: true });
			await Bun.write(
				path.join(agentDir, "config.yml"),
				"setupVersion: 1\nstartup:\n  setupWizard: false\n  showSplash: false\n  checkUpdate: false\nproviders:\n  tinyModel: online\n",
			);
			const command = [
				JSON.stringify(process.execPath),
				"--preload",
				JSON.stringify(probeEntry),
				JSON.stringify(cliEntry),
				"--no-session",
				"--model",
				"anthropic/claude-sonnet-4-5",
				JSON.stringify("implement X"),
			].join(" ");
			const env: Record<string, string | undefined> = {
				...process.env,
				HOME: root,
				NO_COLOR: "1",
				OMP_TITLE_PROBE_PATH: outputPath,
				PI_CODING_AGENT_DIR: agentDir,
				TERM: "xterm-256color",
			};
			delete env.PI_NO_TITLE;
			// `-e` forwards the inner bun exit. stdin must stay a live pipe: inherited
			// EOF is copied onto the PTY and can dismiss the CLI before the probe writes.
			const proc = Bun.spawn(["timeout", "10s", "script", "-q", "-e", "-c", command, "/dev/null"], {
				cwd: repoRoot,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env,
			});

			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).arrayBuffer(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect({ exitCode, stderr, stdout: Buffer.from(stdout).toString("utf8") }).toMatchObject({
				exitCode: 0,
				stderr: "",
			});
			expect(await Bun.file(outputPath).text()).toBe(
				JSON.stringify({ generatedFrom: "implement X", sessionName: "CLI Initial Title" }),
			);
		} finally {
			await removeWithRetries(root);
		}
	}, 15_000);
});
