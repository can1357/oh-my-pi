import { describe, expect, test } from "bun:test";
import { classifyTask, withTaskRepositorySignals } from "../src/task-router";
import { readWorkspacePackageScripts, setRepositoryProfileForVerification } from "../src/verification";
import type { RepositoryProfile } from "../src/repository-intelligence";

describe("repository intelligence integrations", () => {
	test("Task Router consumes repository signals without changing its classifier API", () => {
		const result = withTaskRepositorySignals({
			repositorySize: "large",
			projectType: "TypeScript repository",
			framework: "React",
			hasTests: true,
			relevantFileCount: 7,
			subsystemCount: 8,
			crossesSubsystems: true,
		}, () => classifyTask("Update the authentication flow."));
		expect(result.signals.likelyFiles).toBe(7);
		expect(result.signals.crossSubsystem).toBe(true);
		expect(result.complexity).toBe("COMPLEX");
	});

	test("Verification can consume cached repository package scripts", async () => {
		const profile: RepositoryProfile = {
			identity: { root: "/tmp/example", name: "example", confidence: 1, evidence: ["test"] },
			languages: ["TypeScript"],
			frameworks: [],
			packageManager: "Bun",
			buildSystem: ["package-script build"],
			testFramework: ["Vitest"],
			entryPoints: [],
			sourceRoots: ["packages/api/src"],
			testRoots: ["packages/api/test"],
			configFiles: ["package.json"],
			generatedDirectories: [],
			ignoredDirectories: [],
			importantDirectories: ["packages/api"],
			workspacePackages: [{ name: "@example/api", root: "packages/api", manifest: "packages/api/package.json", packageManager: "Bun", scripts: { test: "bun test", "check:types": "tsgo --noEmit" }, dependencies: [], devDependencies: [] }, { name: "example", root: ".", manifest: "package.json", packageManager: "Bun", scripts: { test: "bun test", build: "bun run build" }, dependencies: [], devDependencies: [] }],
			gitState: { dirty: false, changedFiles: [], stagedFiles: [], unstagedFiles: [], untrackedFiles: [] },
			lastIndexedState: { indexedAt: Date.now(), headRevision: "test", structuralFingerprint: "test", fileCount: 4, cacheHit: true, invalidations: [] },
		};
		const remove = setRepositoryProfileForVerification("/tmp/example", profile);
		try {
			const result = await readWorkspacePackageScripts("/tmp/example");
			expect(result.rootScripts.build).toBe("bun run build");
			expect(result.packageScripts["packages/api"]["check:types"]).toBe("tsgo --noEmit");
		} finally {
			remove();
		}
	});
});
