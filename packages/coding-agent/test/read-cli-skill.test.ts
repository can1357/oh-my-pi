import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");

describe("omp read skill resources", () => {
	let root: string;
	let projectDir: string;
	let agentDir: string;
	let probePath: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-skill-"));
		projectDir = path.join(root, "project");
		agentDir = path.join(root, "agent");
		const skillDir = path.join(projectDir, ".omp", "skills", "standalone-skill");
		await Promise.all([fs.mkdir(skillDir, { recursive: true }), fs.mkdir(agentDir)]);
		await Bun.write(
			path.join(skillDir, "SKILL.md"),
			"---\nname: standalone-skill\ndescription: Readable from the standalone CLI.\n---\n\n# Standalone Skill\n",
		);
		probePath = path.join(root, "probe.ts");
		await Bun.write(
			probePath,
			[
				`import { runCli } from ${JSON.stringify(url.pathToFileURL(CLI_ENTRY).href)};`,
				'await runCli(["read", "skill://standalone-skill"]);',
			].join("\n"),
		);
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	it("reads a discovered project skill through the standalone CLI", async () => {
		const proc = Bun.spawn([process.execPath, probePath], {
			cwd: projectDir,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: root,
				NO_COLOR: "1",
				PI_CODING_AGENT_DIR: agentDir,
			},
		});
		const stdout = new Response(proc.stdout).text();
		const stderr = new Response(proc.stderr).text();
		const [exitCode, output, error] = await Promise.all([proc.exited, stdout, stderr]);

		expect(exitCode).toBe(0);
		expect(output).toContain("# Standalone Skill");
		expect(error).toBe("");
	}, 60_000);
});
