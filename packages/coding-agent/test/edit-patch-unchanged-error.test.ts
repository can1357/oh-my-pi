import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { DEFAULT_FUZZY_THRESHOLD, executePatchSingle } from "@pk-nerdsaver-ai/pi-coding-agent/edit";
import type { FileDiagnosticsResult } from "@pk-nerdsaver-ai/pi-coding-agent/lsp";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "patch" }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

const noopBeginDeferred = (_p: string) => ({
	onDeferredDiagnostics: () => {},
	signal: new AbortController().signal,
	finalize: () => {},
});

/**
 * Simulates an LSP host integration that claims success without persisting the
 * write — the failure mode the post-write verification block in `patch.ts` is
 * defending against. Unlike `writethroughNoop`, this really doesn't touch the
 * filesystem.
 */
async function silentlySwallowingWritethrough(): Promise<FileDiagnosticsResult | undefined> {
	return undefined;
}

let tempDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-patch-unchanged-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

describe("executePatchSingle — post-write verification error path", () => {
	test("error message contains the caller-supplied relative path and not the absolute resolvedPath", async () => {
		const relPath = "deep/nested/foo.txt";
		await fs.mkdir(path.join(tempDir, "deep", "nested"), { recursive: true });
		await fs.writeFile(path.join(tempDir, relPath), "a\n");

		let caught: Error | undefined;
		try {
			await executePatchSingle({
				session: makeSession(tempDir),
				path: relPath,
				params: { op: "update", diff: "@@\n-a\n+b" },
				allowFuzzy: true,
				fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
				writethrough: silentlySwallowingWritethrough,
				beginDeferredDiagnosticsForPath: noopBeginDeferred,
			});
		} catch (err) {
			caught = err as Error;
		}

		expect(caught).toBeInstanceOf(Error);
		const message = caught?.message ?? "";

		// The relative path supplied by the caller must appear in the
		// user-facing error — it's what the outer composer in `executeSinglePathEntries`
		// uses in its `Error editing ${path}: …` wrapper.
		expect(message).toContain(relPath);

		// The absolute resolved path must NOT appear in the user-facing
		// message — leaking it embeds `$HOME`/`os.tmpdir()` in the TUI and
		// double-embeds the path when the outer composer prepends its own.
		// resolvedPath still lives in the structured `context` metadata.
		expect(message).not.toContain(tempDir);
	});

	test("ToolError still carries the absolute resolvedPath in its structured context for log correlation", async () => {
		const relPath = "foo.txt";
		await fs.writeFile(path.join(tempDir, relPath), "a\n");

		let caught: Error | undefined;
		try {
			await executePatchSingle({
				session: makeSession(tempDir),
				path: relPath,
				params: { op: "update", diff: "@@\n-a\n+b" },
				allowFuzzy: true,
				fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
				writethrough: silentlySwallowingWritethrough,
				beginDeferredDiagnosticsForPath: noopBeginDeferred,
			});
		} catch (err) {
			caught = err as Error;
		}

		expect(caught).toBeInstanceOf(Error);
		const context = (caught as Error & { context?: { path?: string } }).context;
		expect(context?.path).toBe(path.join(tempDir, relPath));
	});
});
