import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	cleanupTemporaryArtifactsDir,
	registerTemporaryArtifactsDir,
	resetRegisteredArtifactDirsForTests,
	setTemporaryArtifactsRecovery,
	sweepTemporaryArtifactsDirs,
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

it("reclaims every containing lease after the last capture settles without racing recursive removals", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-containing-disposal-"));
	try {
		const inner = path.join(root, "Parent");
		const third = path.join(inner, "Third");
		const dirs = [root, inner, third];
		await Bun.write(path.join(third, "Worker.patch"), "recovery\n");
		for (const dir of dirs) registerTemporaryArtifactsDir(dir);
		setTemporaryArtifactsRecovery(third, "capture", true);
		for (const dir of dirs) await cleanupTemporaryArtifactsDir(dir);
		setTemporaryArtifactsRecovery(third, "capture", false);
		await Promise.all(dirs.map(dir => cleanupTemporaryArtifactsDir(dir)));
		for (const dir of dirs)
			expect(
				await fs.stat(dir).then(
					() => true,
					() => false,
				),
			).toBe(false);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

for (const state of ["applied", "unapplied", "empty"] as const) {
	for (const topology of ["root", "nested", "sibling"] as const) {
		for (const owner of ["present", "released", "never-registered"] as const) {
			for (const timing of ["before-release", "during-release", "after-settlement"] as const) {
				it(`capture lease invariant: ${state}/${topology}/${owner}/${timing}`, async () => {
					const root = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-capture-matrix-"));
					try {
						const dir = path.join(root, "lease");
						const captureDir = topology === "nested" ? path.join(dir, "Parent/Child") : dir;
						const patchPath = path.join(captureDir, "Worker.patch");
						const outputPath = path.join(dir, "Worker.md");
						await Bun.write(outputPath, "output\n");
						registerTemporaryArtifactsDir(dir);
						const unrelated = path.join(root, "lease-other");
						await Bun.write(path.join(unrelated, "Other.md"), "unrelated\n");
						registerTemporaryArtifactsDir(unrelated);
						const registry = AgentRegistry.global();
						if (owner !== "never-registered") {
							registry.register({
								id: "Worker",
								displayName: "worker",
								kind: "sub",
								status: "parked",
								session: null,
								sessionFile: path.join(captureDir, "Worker.jsonl"),
							});
						}
						const older = "older-capture";
						const current = "current-capture";
						setTemporaryArtifactsRecovery(dir, older, true);
						const capture = async () => {
							if (state === "empty") return;
							setTemporaryArtifactsRecovery(captureDir, current, true);
							await Bun.write(patchPath, "captured unique bytes\n");
						};
						if (timing === "before-release") await capture();
						// Disposal during an older pending capture must not remove the lease.
						if (timing !== "after-settlement") await cleanupTemporaryArtifactsDir(dir);
						if (timing === "during-release") await capture();
						if (owner === "released") registry.unregister("Worker");
						setTemporaryArtifactsRecovery(dir, older, false);
						if (timing === "after-settlement") await capture();
						if (topology === "sibling") {
							// Applying a sibling must not release the current capture.
							setTemporaryArtifactsRecovery(path.join(dir, "Sibling"), "sibling-capture", true);
							setTemporaryArtifactsRecovery(path.join(dir, "Sibling"), "sibling-capture", false);
						}
						if (state === "applied") setTemporaryArtifactsRecovery(captureDir, current, false);
						await cleanupTemporaryArtifactsDir(dir);
						const beforeExit = await Bun.file(outputPath).exists();
						expect(beforeExit).toBe(state === "unapplied" || owner === "present");
						sweepTemporaryArtifactsDirs();
						expect(await Bun.file(outputPath).exists()).toBe(state === "unapplied");
						expect(await Bun.file(path.join(unrelated, "Other.md")).exists()).toBe(false);
						if (state === "unapplied") expect(await Bun.file(patchPath).text()).toBe("captured unique bytes\n");
					} finally {
						await fs.rm(root, { recursive: true, force: true });
					}
				});
			}
		}
	}
}
