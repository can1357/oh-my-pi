import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstEditTool } from "@oh-my-pi/pi-coding-agent/tools/ast-edit";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let tmpDir: string;
let artifactsDir: string;
let unregisterArtifactsDir: () => void;

function createSession(): ToolSession {
	return {
		cwd: tmpDir,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => artifactsDir,
		settings: Settings.isolated({ "edit.enforceSeenLines": false }),
	};
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

beforeEach(async () => {
	resetSettingsForTest();
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-handler-urls-"));
	artifactsDir = path.join(tmpDir, "artifacts");
	await fs.mkdir(artifactsDir, { recursive: true });
	await Settings.init({ inMemory: true, cwd: tmpDir });
	resetRegisteredArtifactDirsForTests();
	unregisterArtifactsDir = registerArtifactsDir(artifactsDir);
});

afterEach(async () => {
	unregisterArtifactsDir();
	resetRegisteredArtifactDirsForTests();
	resetSettingsForTest();
	await removeWithRetries(tmpDir);
});

describe("file-editing tools refuse handler-owned URL writes", () => {
	it("edit never patches a subagent's output file behind agent://", async () => {
		const output = path.join(artifactsDir, "Reviewer.md");
		await Bun.write(output, "verdict: REJECT\n");

		const result = await new EditTool(createSession(), "replace").execute("tamper", {
			path: "agent://Reviewer",
			old_string: "REJECT",
			new_string: "APPROVE",
		});

		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("agent://Reviewer is written through `write`, not edited");
		expect(await Bun.file(output).text()).toBe("verdict: REJECT\n");
	});

	it("edit refuses proc:// instead of patching the service log", async () => {
		const result = await new EditTool(createSession(), "replace").execute("proc", {
			path: "proc://web",
			old_string: "a",
			new_string: "b",
		});

		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("proc://web is written through `write`, not edited");
	});

	it("ast_edit refuses URLs whose located file tools may not write", async () => {
		await Bun.write(path.join(artifactsDir, "Reviewer.md"), "legacyWrap(x, value)\n");
		const tool = new AstEditTool(createSession());

		for (const url of ["agent://Reviewer", "history://Worker"]) {
			await expect(
				tool.execute("ast", { ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }], paths: [url] }),
			).rejects.toThrow(`Cannot rewrite ${url}`);
		}
		expect(await Bun.file(path.join(artifactsDir, "Reviewer.md")).text()).toBe("legacyWrap(x, value)\n");
	});
});
