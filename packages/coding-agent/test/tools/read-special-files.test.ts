import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { hasFsCode, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "session"),
		allocateOutputArtifact: async (toolType: string) => ({
			id: "a1",
			path: path.join(cwd, "session", `a1.${toolType}.log`),
		}),
		settings: Settings.isolated(),
	};
}

/** Unblocks a reader leaked by a regression; non-blocking, so it cannot hang when there is none (ENXIO). */
function releaseFifoReader(fifo: string): void {
	try {
		fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
	} catch (error) {
		if (!hasFsCode(error, "ENXIO")) throw error;
	}
}

/** Real-clock race: a regressed read blocks in the kernel, where fake timers cannot reach. */
async function expectFifoRejection(tool: ReadTool, readPath: string, fifo: string): Promise<void> {
	const outcome = await Promise.race([
		tool.execute("read-special", { path: readPath }).then(
			() => "RESOLVED" as const,
			(error: unknown) => error,
		),
		Bun.sleep(1500).then(() => "HUNG" as const),
	]);
	if (outcome === "HUNG") releaseFifoReader(fifo);
	expect(outcome).toBeInstanceOf(ToolError);
	expect(outcome).toHaveProperty("message", expect.stringContaining("FIFO"));
}

// Regression: reading `/dev/stdin` blocked a thread no abort can cancel and swallowed the TUI's
// keystrokes. A FIFO with no writer blocks the same way.
describe.skipIf(process.platform === "win32")("read on non-regular files", () => {
	let testDir: string;
	let tool: ReadTool;
	let fifo: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-special-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		tool = new ReadTool(makeSession(testDir));
		fifo = path.join(testDir, "input.fifo");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("rejects a FIFO instead of blocking on it", async () => {
		await expectFifoRejection(tool, fifo, fifo);
	});

	// Globbing skips FIFOs but not symlinks to one, so the suffix-match stat needs the check too.
	it("rejects a FIFO reached through a suffix-matched symlink", async () => {
		fs.mkdirSync(path.join(testDir, "nested/dir"), { recursive: true });
		fs.symlinkSync(fifo, path.join(testDir, "nested/dir/link"));
		await expectFifoRejection(tool, "dir/link", fifo);
	});

	// The SQLite resolver sniffs `*.db` headers before the read tool's check runs.
	it("rejects a FIFO behind a SQLite file name", async () => {
		fs.symlinkSync(fifo, path.join(testDir, "data.db"));
		await expectFifoRejection(tool, "data.db", fifo);
	});
});
