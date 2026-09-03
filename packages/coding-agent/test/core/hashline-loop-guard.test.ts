import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ExecuteHashlineSingleOptions,
	executeHashlineSingle,
	formatHashlineHeader,
	getFileSnapshotStore as getFileReadCache,
} from "@oh-my-pi/pi-coding-agent/edit";
import { NOOP_HARD_LIMIT } from "@oh-my-pi/pi-coding-agent/edit/hashline/noop-loop-guard";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

function makeSession(tempDir: string): ToolSession {
	return { cwd: tempDir, settings: Settings.isolated() } as ToolSession;
}

function execOptions(input: string, session: ToolSession): ExecuteHashlineSingleOptions {
	return {
		session,
		input,
		writethrough: async (targetPath, content) => {
			await Bun.write(targetPath, content);
			return undefined;
		},
		beginDeferredDiagnosticsForPath: () => ({
			onDeferredDiagnostics: () => {},
			signal: new AbortController().signal,
			finalize: () => {},
		}),
	};
}

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-loop-guard-"));
	try {
		await fn(tempDir);
	} finally {
		await removeWithRetries(tempDir);
	}
}

/**
 * Build a single-section "replace line 2 with `bbb`" payload that resolves to
 * a byte-identical no-op against the file `aaa\nbbb\nccc\n`.
 */
function buildNoopInput(filePath: string, displayPath: string, session: ToolSession): string {
	const source = "aaa\nbbb\nccc\n";
	const tag = getFileReadCache(session).record(filePath, source);
	return `${formatHashlineHeader(displayPath, tag)}\nPUT 2-2:\n+bbb\n`;
}

describe("hashline noop loop guard", () => {
	it("returns the soft hint for the first NOOP_HARD_LIMIT - 1 attempts", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			await Bun.write(filePath, "aaa\nbbb\nccc\n");
			const session = makeSession(tempDir);
			const input = buildNoopInput(filePath, "a.ts", session);

			for (let attempt = 1; attempt < NOOP_HARD_LIMIT; attempt++) {
				const result = await executeHashlineSingle(execOptions(input, session));
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				expect(text).toContain("parsed and applied cleanly, but produced no change");
				expect(text).toContain("byte-identical to the file");
				expect(text).not.toContain("STOP.");
			}
		});
	});

	it("escalates to a thrown ToolError on the Nth consecutive byte-identical no-op", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			await Bun.write(filePath, "aaa\nbbb\nccc\n");
			const session = makeSession(tempDir);
			const input = buildNoopInput(filePath, "a.ts", session);

			// Burn the soft-hint attempts.
			for (let attempt = 1; attempt < NOOP_HARD_LIMIT; attempt++) {
				await executeHashlineSingle(execOptions(input, session));
			}

			let caught: unknown;
			try {
				await executeHashlineSingle(execOptions(input, session));
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(ToolError);
			const message = (caught as Error).message;
			expect(message).toContain("STOP.");
			expect(message).toContain("a.ts");
			expect(message).toContain(String(NOOP_HARD_LIMIT));
			// The escalated message still preserves the file path on disk untouched.
			expect(await Bun.file(filePath).text()).toBe("aaa\nbbb\nccc\n");
		});
	});
	it("does not accumulate across distinct canonical paths", async () => {
		await withTempDir(async tempDir => {
			const aPath = path.join(tempDir, "a.ts");
			const bPath = path.join(tempDir, "b.ts");
			await Bun.write(aPath, "aaa\nbbb\nccc\n");
			await Bun.write(bPath, "aaa\nbbb\nccc\n");
			const session = makeSession(tempDir);
			const aInput = buildNoopInput(aPath, "a.ts", session);
			const bInput = buildNoopInput(bPath, "b.ts", session);

			// Drive a.ts to the brink, NOT past it.
			for (let attempt = 1; attempt < NOOP_HARD_LIMIT; attempt++) {
				await executeHashlineSingle(execOptions(aInput, session));
			}

			// b.ts is a fresh path: its counter starts at zero independent of a.ts.
			// Drive b.ts up to the brink without escalating.
			for (let attempt = 1; attempt < NOOP_HARD_LIMIT; attempt++) {
				const result = await executeHashlineSingle(execOptions(bInput, session));
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				expect(text).toContain("byte-identical to the file");
				expect(text).not.toContain("STOP.");
			}
		});
	});

	it("resets the counter after a successful (non-noop) commit on the same path", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			await Bun.write(filePath, "aaa\nbbb\nccc\n");
			const session = makeSession(tempDir);
			const noopInput = buildNoopInput(filePath, "a.ts", session);

			// Hit the threshold-minus-one no-op count.
			for (let attempt = 1; attempt < NOOP_HARD_LIMIT; attempt++) {
				await executeHashlineSingle(execOptions(noopInput, session));
			}

			// Author a real edit. Re-snapshot since the file state and tag have changed
			// from the model's perspective.
			const source = "aaa\nbbb\nccc\n";
			const tag = getFileReadCache(session).record(filePath, source);
			const realEdit = `${formatHashlineHeader("a.ts", tag)}\nPUT 2-2:\n+BBB\n`;
			const editResult = await executeHashlineSingle(execOptions(realEdit, session));
			expect(editResult.content[0]?.type === "text" ? editResult.content[0].text : "").not.toContain(
				"byte-identical to the file",
			);
			expect(await Bun.file(filePath).text()).toBe("aaa\nBBB\nccc\n");

			// Now re-snapshot the (changed) file state and produce a fresh no-op
			// against it. Counter is reset, so this single new no-op stays in the
			// soft-hint regime.
			const newSource = "aaa\nBBB\nccc\n";
			const newTag = getFileReadCache(session).record(filePath, newSource);
			const newNoop = `${formatHashlineHeader("a.ts", newTag)}\nPUT 2-2:\n+BBB\n`;
			const result = await executeHashlineSingle(execOptions(newNoop, session));
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
				"byte-identical to the file",
			);
		});
	});

	it("isolates state per ToolSession (no cross-session leakage)", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			await Bun.write(filePath, "aaa\nbbb\nccc\n");

			const sessionA = makeSession(tempDir);
			const inputA = buildNoopInput(filePath, "a.ts", sessionA);
			// Drive sessionA to the brink.
			for (let attempt = 1; attempt < NOOP_HARD_LIMIT; attempt++) {
				await executeHashlineSingle(execOptions(inputA, sessionA));
			}

			// A FRESH session starting on the same path/payload must NOT inherit
			// the prior session's counter; the first no-op stays soft.
			const sessionB = makeSession(tempDir);
			const inputB = buildNoopInput(filePath, "a.ts", sessionB);
			const result = await executeHashlineSingle(execOptions(inputB, sessionB));
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
				"byte-identical to the file",
			);
		});
	});
});
