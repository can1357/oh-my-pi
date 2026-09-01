import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RepositoryIntelligence } from "../src/repository-intelligence";

const tempRoots: string[] = [];
async function fixture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-intelligence-"));
	tempRoots.push(root);
	await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
	await fs.mkdir(path.join(root, "test"), { recursive: true });
	await fs.mkdir(path.join(root, "packages", "api", "src"), { recursive: true });
	await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture-app", workspaces: ["packages/*"], scripts: { build: "bun run build", test: "bun test", "check:types": "tsgo --noEmit", lint: "biome check ." }, dependencies: { react: "1.0.0" }, devDependencies: { vitest: "1.0.0" } }, null, 2));
	await fs.writeFile(path.join(root, "bun.lock"), "fixture\n");
	await fs.writeFile(path.join(root, "tsconfig.json"), "{}\n");
	await fs.writeFile(path.join(root, "pytest.ini"), "[pytest]\n");
	await fs.writeFile(path.join(root, "src", "main.ts"), "export { session } from './auth/session';\n");
	await fs.writeFile(path.join(root, "src", "auth", "session.ts"), "export function session() { return true; }\nexport class SessionManager {}\n");
	await fs.writeFile(path.join(root, "test", "session.test.ts"), "import { session } from '../src/auth/session';\ntest('session', () => session());\n");
	await fs.writeFile(path.join(root, "main.py"), "def main():\n    return 1\n");
	await fs.writeFile(path.join(root, "main.go"), "package main\nfunc main() {}\n");
	await fs.writeFile(path.join(root, "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\n");
	await fs.writeFile(path.join(root, "Cargo.lock"), "# fixture\n");
	await fs.writeFile(path.join(root, "go.mod"), "module example.com/fixture\n");
	await fs.writeFile(path.join(root, "packages", "api", "package.json"), JSON.stringify({ name: "@fixture/api", scripts: { test: "bun test", "check:types": "tsgo --noEmit" } }, null, 2));
	await fs.writeFile(path.join(root, "packages", "api", "src", "index.ts"), "export const api = true;\n");
	await git(root, ["init"]);
	await git(root, ["config", "user.email", "test@example.invalid"]);
	await git(root, ["config", "user.name", "OMP Test"]);
	await git(root, ["add", "."]);
	await git(root, ["commit", "-m", "fixture"]);
	return root;
}
async function git(cwd: string, args: string[]): Promise<void> {
	const process = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
	const exit = await process.exited;
	if (exit !== 0) throw new Error(`git ${args.join(" ")} failed with ${exit}`);
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("repository intelligence", () => {
	test("discovers project facts, roots, workspaces, and entry points", async () => {
		const root = await fixture();
		const intelligence = new RepositoryIntelligence({ root, cache: false });
		const profile = await intelligence.refresh("full");
		expect(profile.packageManager).toBe("Bun");
		expect(profile.frameworks).toContain("React");
		expect(profile.testFramework).toContain("Vitest");
		expect(profile.testFramework).toContain("pytest");
		expect(profile.testFramework).toContain("go test");
		expect(profile.testFramework).toContain("cargo test");
		expect(profile.languages).toEqual(expect.arrayContaining(["TypeScript", "Python", "Go", "Rust"]));
		expect(profile.sourceRoots).toContain("src");
		expect(profile.testRoots).toContain("test");
		expect(profile.entryPoints.map(entry => entry.path)).toContain("src/main.ts");
		expect(profile.workspacePackages.map(workspace => workspace.root)).toContain("packages/api");
	});

	test("builds lightweight import and symbol indexes", async () => {
		const root = await fixture();
		const intelligence = new RepositoryIntelligence({ root, cache: false });
		await intelligence.refresh("full");
		expect(intelligence.findDependencies("src/main.ts")).toContain("src/auth/session.ts");
		expect(intelligence.findDependents("src/auth/session.ts")).toContain("src/main.ts");
		expect((await intelligence.findSymbolDefinition("SessionManager"))[0]?.path).toBe("src/auth/session.ts");
	});

	test("uses the persistent cache for a clean warm read", async () => {
		const root = await fixture();
		const first = new RepositoryIntelligence({ root });
		await first.refresh("full");
		const second = new RepositoryIntelligence({ root });
		const profile = await second.refresh("auto");
		expect(profile.lastIndexedState.cacheHit).toBe(true);
		expect(second.telemetry.indexMode).toBe("cache");
		expect(second.telemetry.filesIndexed).toBe(0);
	});

	test("updates only changed files incrementally", async () => {
		const root = await fixture();
		const intelligence = new RepositoryIntelligence({ root });
		await intelligence.refresh("full");
		await fs.appendFile(path.join(root, "src", "auth", "session.ts"), "export const touched = true;\n");
		const profile = await intelligence.refresh("auto");
		expect(profile.lastIndexedState.cacheHit).toBe(false);
		expect(intelligence.telemetry.indexMode).toBe("incremental");
		expect(intelligence.telemetry.filesIndexed).toBe(1);
	});

	test("invalidates broadly when project configuration changes", async () => {
		const root = await fixture();
		const intelligence = new RepositoryIntelligence({ root });
		await intelligence.refresh("full");
		const packageFile = path.join(root, "package.json");
		const packageJson = JSON.parse(await fs.readFile(packageFile, "utf8")) as Record<string, unknown>;
		(packageJson.dependencies as Record<string, string>).vue = "1.0.0";
		await fs.writeFile(packageFile, JSON.stringify(packageJson, null, 2));
		const profile = await intelligence.refresh("auto");
		expect(profile.frameworks).toContain("Vue");
		expect(intelligence.telemetry.indexMode).toBe("full");
		expect(intelligence.telemetry.invalidations.length).toBeGreaterThan(0);
	});

	test("removes deleted files incrementally", async () => {
		const root = await fixture();
		const intelligence = new RepositoryIntelligence({ root });
		await intelligence.refresh("full");
		await fs.rm(path.join(root, "src", "auth", "session.ts"));
		const profile = await intelligence.refresh("auto");
		expect(profile.lastIndexedState.fileCount).toBe(13);
		expect(intelligence.telemetry.indexMode).toBe("incremental");
		expect(intelligence.findDependencies("src/main.ts")).toEqual([]);
	});

	test("degrades cleanly outside a git repository", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-fallback-"));
		tempRoots.push(root);
		await fs.writeFile(path.join(root, "main.py"), "print('ok')\n");
		const intelligence = new RepositoryIntelligence({ root, cache: false });
		const profile = await intelligence.refresh("auto");
		expect(intelligence.telemetry.indexMode).toBe("fallback");
		expect(profile.identity.evidence).toContain("repository indexing unavailable");
	});
});
