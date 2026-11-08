import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	cleanupTemporaryArtifactsDir,
	registerTemporaryArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});

it("completes overlapping disposal requests before treating later requests as a no-op", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-overlapping-disposal-"));
	try {
		await Bun.write(path.join(dir, "Worker.md"), "output\n");
		registerTemporaryArtifactsDir(dir);
		await Promise.all(Array.from({ length: 8 }, () => cleanupTemporaryArtifactsDir(dir)));
		expect(
			await fs.stat(dir).then(
				() => true,
				() => false,
			),
		).toBe(false);
		await cleanupTemporaryArtifactsDir(dir);
		expect(
			await fs.stat(dir).then(
				() => true,
				() => false,
			),
		).toBe(false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
