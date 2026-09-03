import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";

test("normal CLI startup keeps computer worker modules lazy", async () => {
	using tempDir = TempDir.createSync("@omp-cli-computer-lazy-");
	const cliUrl = new URL("../src/cli.ts", import.meta.url).href;
	const probePath = tempDir.join("probe.ts");
	// Import by file URL inside the child so only that fresh process evaluates the CLI graph.
	await Bun.write(
		probePath,
		[
			`import { runCli } from ${JSON.stringify(cliUrl)};`,
			"process.stdout.write = () => true;",
			'await runCli(["--version"]);',
		].join("\n"),
	);

	// `--no-addons` is a process-local sentinel: evaluating the computer worker graph
	// attempts to load the desktop addon and fails, while normal CLI startup must not.
	const child = Bun.spawn([process.execPath, "--no-addons", probePath], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	expect(exitCode, stderr).toBe(0);
});
