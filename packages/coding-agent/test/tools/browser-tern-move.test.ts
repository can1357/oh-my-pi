import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { moveTernBlockToNewTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/move";

describe("moveTernBlockToNewTab", () => {
	let directory: string | undefined;

	afterEach(async () => {
		if (directory) await fs.rm(directory, { recursive: true, force: true });
		directory = undefined;
	});

	/** A stand-in `tern` that records its argv and exits with `code`. */
	async function stub(code: number): Promise<{ executable: string; recordedArgv: () => Promise<string[]> }> {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tern-move-"));
		const record = path.join(directory, "argv");
		const executable = path.join(directory, "tern");
		await Bun.write(
			executable,
			`#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n${code === 0 ? "" : 'echo "no tab number new-tab" >&2\n'}exit ${code}\n`,
		);
		await fs.chmod(executable, 0o755);
		return { executable, recordedArgv: async () => (await fs.readFile(record, "utf8")).trim().split("\n") };
	}

	it("moves the block with the CLI's own `new-tab` keyword", async () => {
		const { executable, recordedArgv } = await stub(0);
		await moveTernBlockToNewTab(12_884_901_889, { executable });
		expect(await recordedArgv()).toEqual(["move", "12884901889", "new-tab"]);
	});

	it("reports a refused move with the CLI's stderr", async () => {
		const { executable } = await stub(2);
		await expect(moveTernBlockToNewTab(7, { executable })).rejects.toThrow(
			/exited with code 2: no tab number new-tab/,
		);
	});
});
