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
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	async function runReadProbe(skillUrl: string): Promise<{ exitCode: number; output: string; error: string }> {
		const probePath = path.join(root, "probe.ts");
		await Bun.write(
			probePath,
			[
				`import { runCli } from ${JSON.stringify(url.pathToFileURL(CLI_ENTRY).href)};`,
				`await runCli(["read", ${JSON.stringify(skillUrl)}]);`,
			].join("\n"),
		);
		const proc = Bun.spawn([process.execPath, probePath], {
			cwd: projectDir,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: root,
				USERPROFILE: root,
				NO_COLOR: "1",
				PI_CODING_AGENT_DIR: agentDir,
			},
		});
		const stdout = new Response(proc.stdout).text();
		const stderr = new Response(proc.stderr).text();
		const [exitCode, output, error] = await Promise.all([proc.exited, stdout, stderr]);
		return { exitCode, output, error };
	}

	it("reads a discovered project skill through the standalone CLI", async () => {
		const { exitCode, output, error } = await runReadProbe("skill://standalone-skill");

		expect(exitCode).toBe(0);
		expect(output).toContain("# Standalone Skill");
		expect(error).toBe("");
	}, 60_000);

	it("honors the codex opt-in when reading a user skill through the standalone CLI", async () => {
		const skillDir = path.join(root, ".codex", "skills", "codex-user-skill");
		await fs.mkdir(skillDir, { recursive: true });
		await Bun.write(
			path.join(skillDir, "SKILL.md"),
			"---\nname: codex-user-skill\ndescription: Opted-in user skill.\n---\n\n# Codex User Skill\n",
		);
		await Bun.write(path.join(agentDir, "config.yml"), "enabledProviders:\n  - codex\n");

		const { exitCode, output, error } = await runReadProbe("skill://codex-user-skill");

		expect(exitCode).toBe(0);
		expect(output).toContain("# Codex User Skill");
		expect(error).toBe("");
	}, 60_000);

	it("reads an extension skill configured outside .omp through the standalone CLI", async () => {
		const skillDir = path.join(projectDir, "ext-pkg", "skills", "ext-skill");
		await fs.mkdir(skillDir, { recursive: true });
		await Bun.write(
			path.join(skillDir, "SKILL.md"),
			"---\nname: ext-skill\ndescription: Extension skill.\n---\n\n# Extension Skill\n",
		);
		await fs.mkdir(path.join(projectDir, ".claude"), { recursive: true });
		await Bun.write(path.join(projectDir, ".claude", "settings.json"), JSON.stringify({ extensions: ["./ext-pkg"] }));

		const { exitCode, output, error } = await runReadProbe("skill://ext-skill");

		expect(exitCode).toBe(0);
		expect(output).toContain("# Extension Skill");
		expect(error).toBe("");
	}, 60_000);
});
