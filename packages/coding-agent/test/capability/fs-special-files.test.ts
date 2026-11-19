import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache, readFile } from "@oh-my-pi/pi-coding-agent/capability/fs";

const isWindows = process.platform === "win32";

describe("capability/fs readFile on special files", () => {
	let dir = "";

	beforeAll(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-fs-special-"));
	});

	afterAll(async () => {
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	// Contract: discovery scans foreign config dirs (~/.claude, ~/.cursor,
	// project trees). A FIFO/socket dropped where a context file is expected
	// must yield null instead of blocking startup forever on a read that can
	// never see EOF.
	it.skipIf(isWindows)("returns null for a FIFO instead of blocking", async () => {
		const fifo = path.join(dir, "CLAUDE.md");
		const made = Bun.spawnSync(["mkfifo", fifo]);
		expect(made.exitCode).toBe(0);
		clearCache();
		// Real-clock race on purpose: a regressed readFile blocks inside a
		// kernel read() on the FIFO — there is no promise or event to await and
		// fake timers cannot advance a syscall. The sleep only bounds the
		// failure; the passing path returns immediately.
		const result = await Promise.race([readFile(fifo), Bun.sleep(1500).then(() => "HUNG" as const)]);
		if (result === "HUNG") {
			// Regression path: unblock the leaked FIFO reader so the test
			// process can exit, then fail on the assertion below.
			fs.closeSync(fs.openSync(fifo, "w"));
		}
		expect(result).toBeNull();
	});

	// Symlinked context files (CLAUDE.md -> AGENTS.md) are common; the type
	// gate must follow links rather than rejecting them.
	it.skipIf(isWindows)("still reads regular files through symlinks", async () => {
		const target = path.join(dir, "AGENTS.md");
		await Bun.write(target, "# context");
		const link = path.join(dir, "CLAUDE-link.md");
		await fs.promises.symlink(target, link);
		clearCache();
		expect(await readFile(link)).toBe("# context");
	});
});
