/**
 * Regression coverage for #4074-B: multi-file apply_patch must stop at the
 * first per-file failure and surface `isError` on the aggregate result so the
 * agent loop and renderers take the error branch instead of treating a
 * mixed partial application as a successful edit.
 *
 * The single-file (`executeSinglePathEntries`) counterpart already stops at
 * the first failure and stamps `isError`; this file pins the same semantics
 * for the multi-file (`executeApplyPatchPerFile`) apply_patch aggregate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, type EditToolDetails } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function makeApplyPatchSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "apply_patch" }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

let tempDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-apply-patch-multi-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

describe("EditTool apply_patch multi-file aggregate (#4074-B)", () => {
	test("stops at first per-file failure, marks isError, and skips remaining files", async () => {
		await Bun.write(path.join(tempDir, "a.txt"), "a\n");
		const tool = new EditTool(makeApplyPatchSession(tempDir));

		const patch = [
			"*** Begin Patch",
			"*** Update File: a.txt",
			"@@",
			"-a",
			"+A",
			"*** Update File: missing.txt",
			"@@",
			"-x",
			"+y",
			"*** Add File: c.txt",
			"+new content",
			"*** End Patch",
			"",
		].join("\n");

		const result = await tool.execute("call-#4074-B", { input: patch });

		// First file must have landed (matches existing partial-success
		// semantics of applyCodexPatch).
		expect(await Bun.file(path.join(tempDir, "a.txt")).text()).toBe("A\n");

		// Third entry MUST NOT be applied after the second one failed.
		expect(fs.existsSync(path.join(tempDir, "c.txt"))).toBe(false);

		// Aggregate MUST report failure so the agent loop takes the error
		// branch.
		expect(result.isError).toBe(true);

		// The failed and skipped files must be surfaced so the caller can
		// re-issue only the missing work.
		const text = result.content?.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("missing.txt");
		expect(text).toContain("c.txt");
		expect(text).toContain("NOT applied");

		// Per-file details must include an error entry for the failing file.
		const details = result.details as EditToolDetails | undefined;
		const perFile = details?.perFileResults ?? [];
		const failed = perFile.find(r => r.path.endsWith("missing.txt"));
		expect(failed?.isError).toBe(true);
		// The skipped third file must not have a per-file entry (we stop
		// before attempting it).
		expect(perFile.some(r => r.path.endsWith("c.txt"))).toBe(false);
	});

	test("all-success multi-file apply_patch does not set isError", async () => {
		await Bun.write(path.join(tempDir, "a.txt"), "a\n");
		await Bun.write(path.join(tempDir, "b.txt"), "b\n");
		const tool = new EditTool(makeApplyPatchSession(tempDir));

		const patch = [
			"*** Begin Patch",
			"*** Update File: a.txt",
			"@@",
			"-a",
			"+A",
			"*** Update File: b.txt",
			"@@",
			"-b",
			"+B",
			"*** End Patch",
			"",
		].join("\n");

		const result = await tool.execute("call-#4074-B-ok", { input: patch });

		expect(result.isError).toBeUndefined();
		expect(await Bun.file(path.join(tempDir, "a.txt")).text()).toBe("A\n");
		expect(await Bun.file(path.join(tempDir, "b.txt")).text()).toBe("B\n");
		const text = result.content.find(entry => entry.type === "text")?.text ?? "";
		expect(text).toContain("[a.txt]\n1:A\n\n[b.txt]\n1:B");
		expect(text).not.toMatch(/^\[[^\]\n]+#[0-9A-F]{4}\]/);
	});
});
