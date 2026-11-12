import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { copySessionArtifacts } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SHELL_STATE_DIR } from "@oh-my-pi/pi-coding-agent/session/shell-state";

describe("copySessionArtifacts", () => {
	let dir: string | undefined;

	afterEach(async () => {
		if (dir) await fsp.rm(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("copies a session's artifacts to a fork, but not its saved shell states", async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-copy-artifacts-"));
		const from = path.join(dir, "old.jsonl");
		const to = path.join(dir, "new.jsonl");
		await Bun.write(from, "");
		await Bun.write(path.join(dir, "old", "1.bash.log"), "saved output");
		// The shell's variables, tokens it fetched included: they stay with the session that saved them.
		await Bun.write(path.join(dir, "old", SHELL_STATE_DIR, "old-session", "kind.bin"), "GH_TOKEN");

		await copySessionArtifacts(from, to);

		expect(fs.readFileSync(path.join(dir, "new", "1.bash.log"), "utf8")).toBe("saved output");
		expect(fs.existsSync(path.join(dir, "new", SHELL_STATE_DIR))).toBe(false);
	});
});
