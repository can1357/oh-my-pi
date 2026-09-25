import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromiumCdpAvailable } from "./chromium-probe";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("Chromium CDP availability", () => {
	it("rejects a version-only wrapper without a CDP endpoint", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-version-shim-"));
		directories.push(directory);
		const executable = path.join(directory, "chromium");
		await Bun.write(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Chromium snap"; fi\nexit 0\n');
		await fs.chmod(executable, 0o755);
		expect(Bun.spawnSync([executable, "--version"]).exitCode).toBe(0);
		expect(await chromiumCdpAvailable(executable, 100)).toBe(false);
	});
});
