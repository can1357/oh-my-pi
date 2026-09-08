import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	settings.set("read.summarize.enabled", false);
	const artifactsDir = path.join(cwd, "artifacts");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => artifactsDir,
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
	} as unknown as ToolSession;
}

// Regression: reading a file *outside* the session cwd (e.g. `~/.claude/settings.json`)
// and then editing it anchored on the emitted hashline header. The header used to
// collapse to the bare filename for every read; out-of-tree the edit tool's
// snapshot-tag recovery refuses to rebind a bare name (allowTagPathRecovery), so the
// path resolved against cwd, missed, and failed with "File not found". The header now
// carries the full out-of-cwd path so the edit resolves directly.
describe("read → edit round-trip for out-of-cwd files", () => {
	let cwdDir: string;
	let outDir: string;
	let homeDir: string | undefined;

	beforeEach(async () => {
		cwdDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-edit-cwd-"));
		outDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-edit-out-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwdDir);
		await removeWithRetries(outDir);
		if (homeDir) await removeWithRetries(homeDir);
	});

	it("anchors the out-of-cwd path in the header so a follow-up edit lands", async () => {
		const outFile = path.join(outDir, "settings.json");
		await fs.writeFile(outFile, "alpha\nbeta\n");

		const session = createSession(cwdDir);
		const header = textOutput(await new ReadTool(session).execute("read-out", { path: outFile })).split("\n")[0];

		// The header must carry the directory, not just `settings.json`, or the
		// edit below would resolve the bare name against cwdDir and miss.
		expect(header).toMatch(/^\[.+settings\.json#[0-9A-F]{4}\]$/);
		expect(header).toContain(path.basename(outDir));

		const result = await new EditTool(session, "hashline").execute("edit-out", {
			input: `${header}\nPUT 1-1:\n+ALPHA\n`,
		});
		const resultText = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

		expect(resultText).not.toContain("File not found");
		expect(await Bun.file(outFile).text()).toBe("ALPHA\nbeta\n");
	});

	it("round-trips a home-relative path through read and edit", async () => {
		homeDir = await fs.mkdtemp(path.join(os.homedir(), ".omp-read-edit-"));
		const homeFile = path.join(homeDir, "settings.txt");
		const authoredPath = `~/${path.relative(os.homedir(), homeFile)}`;
		await Bun.write(homeFile, "alpha\nbeta\n");

		const session = createSession(cwdDir);
		const header = textOutput(await new ReadTool(session).execute("read-home", { path: authoredPath })).split(
			"\n",
		)[0];
		const result = await new EditTool(session, "hashline").execute("edit-home", {
			input: `${header}\nPUT 1-1:\n+ALPHA\n`,
		});

		expect(result.isError).not.toBe(true);
		expect(await Bun.file(homeFile).text()).toBe("ALPHA\nbeta\n");
	});

	it("keeps an in-cwd relative path so an existing basename cannot capture a follow-up edit", async () => {
		const rootFile = path.join(cwdDir, "settings.json");
		const nestedFile = path.join(cwdDir, "src", "settings.json");
		await fs.mkdir(path.dirname(nestedFile), { recursive: true });
		await Promise.all([fs.writeFile(rootFile, "root\n"), fs.writeFile(nestedFile, "alpha\nbeta\n")]);

		const session = createSession(cwdDir);
		const header = textOutput(await new ReadTool(session).execute("read-in", { path: nestedFile })).split("\n")[0];

		// The header must retain the workspace-relative directory, not collapse
		// to the bare `settings.json`, or the edit below resolves against the
		// existing cwd file and the snapshot-tag guard rejects the valid edit.
		expect(header).toBe(`[${path.join("src", "settings.json")}#${header.slice(-5, -1)}]`);

		await new EditTool(session, "hashline").execute("edit-in", {
			input: `${header}\nPUT 1.=1:\n+ALPHA\n`,
		});

		expect(await Bun.file(nestedFile).text()).toBe("ALPHA\nbeta\n");
		expect(await Bun.file(rootFile).text()).toBe("root\n");
	});

	it("uses the read-resolved workspace suffix across direct edit modes", async () => {
		const cases: Array<{
			mode: "replace" | "patch" | "apply_patch";
			run: (tool: EditTool, fileName: string) => Promise<void>;
		}> = [
			{
				mode: "replace",
				run: async (tool, fileName) => {
					await tool.execute("edit-workspace-suffix-replace", {
						path: fileName,
						old_string: "alpha",
						new_string: "ALPHA",
					});
				},
			},
			{
				mode: "patch",
				run: async (tool, fileName) => {
					await tool.execute("edit-workspace-suffix-patch", {
						path: fileName,
						edits: [{ op: "update", diff: "@@\n-alpha\n+ALPHA" }],
					});
				},
			},
			{
				mode: "apply_patch",
				run: async (tool, fileName) => {
					const input = [
						"*** Begin Patch",
						`*** Update File: ${fileName}`,
						"@@",
						"-alpha",
						"+ALPHA",
						"*** End Patch",
						"",
					].join("\n");
					await tool.execute("edit-workspace-suffix-apply-patch", { input });
				},
			},
		];

		for (const testCase of cases) {
			const fileName = `${testCase.mode}.txt`;
			const workspaceFile = path.join(cwdDir, "src", fileName);
			await Bun.write(workspaceFile, "alpha\nbeta\n");

			const session = createSession(cwdDir);
			session.settings.set("edit.mode", testCase.mode);
			const readResult = await new ReadTool(session).execute(`read-workspace-suffix-${testCase.mode}`, {
				path: fileName,
			});
			expect(textOutput(readResult)).toContain("alpha");

			await testCase.run(new EditTool(session), fileName);
			expect(await Bun.file(workspaceFile).text()).toBe("ALPHA\nbeta\n");
		}
	});

	it("keeps the resolved workspace target across delete/add hunks for the same authored path", async () => {
		const fileName = "recreate.txt";
		const workspaceFile = path.join(cwdDir, "src", fileName);
		await Bun.write(workspaceFile, "alpha\nbeta\n");

		const session = createSession(cwdDir);
		session.settings.set("edit.mode", "apply_patch");
		const readResult = await new ReadTool(session).execute("read-workspace-suffix-recreate", { path: fileName });
		expect(textOutput(readResult)).toContain("alpha");

		const input = [
			"*** Begin Patch",
			`*** Delete File: ${fileName}`,
			`*** Add File: ${fileName}`,
			"+rewritten",
			"*** End Patch",
			"",
		].join("\n");
		await new EditTool(session).execute("edit-workspace-suffix-recreate", { input });

		expect(await Bun.file(workspaceFile).text()).toBe("rewritten\n");
		expect(await Bun.file(path.join(cwdDir, fileName)).exists()).toBe(false);
	});
});
