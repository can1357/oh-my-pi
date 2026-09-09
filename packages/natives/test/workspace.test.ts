import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileType, listWorkspace } from "../native";

it("keeps excluded-name files while pruning directories and finding ignored rules beyond tree depth", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-pruning-"));
	try {
		await Bun.write(path.join(root, ".gitignore"), "**/AGENTS.md\nignored/\n");
		for (const directory of ["src/a/b/c/d", "build/nested", ".DS_Store/nested", "ignored/nested"]) {
			await fs.mkdir(path.join(root, directory), { recursive: true });
		}
		for (const directory of [
			"src",
			"src/a/b/c",
			"src/a/b/c/d",
			"build/nested",
			".DS_Store/nested",
			"ignored/nested",
		]) {
			await Bun.write(path.join(root, directory, "AGENTS.md"), "rules");
		}
		await Bun.write(path.join(root, "dist"), "ordinary file");
		const result = await listWorkspace({ path: root, maxDepth: 1, hidden: true, collectAgentsMd: true });
		expect(result.entries.map(entry => entry.path)).toEqual([".gitignore", "dist", "src"]);
		expect(result.agentsMdFiles).toEqual(["src/AGENTS.md", "src/a/b/c/AGENTS.md"]);
		expect(result.truncated).toBe(false);
		const disabled = await listWorkspace({ path: root, maxDepth: 0, collectAgentsMd: false });
		expect(disabled).toEqual({ entries: [], agentsMdFiles: [], truncated: false });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

it("caps directory rules lexically without counting duplicate discoveries as truncation", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-rules-cap-"));
	try {
		const paths = Array.from({ length: 200 }, (_, index) => `${String(index).padStart(3, "0")}/AGENTS.md`);
		for (const relative of paths.toReversed()) await Bun.write(path.join(root, relative), "rules");
		const exact = await listWorkspace({ path: root, maxDepth: 2, collectAgentsMd: true });
		expect(exact.agentsMdFiles).toEqual(paths);
		expect(exact.entries.filter(entry => entry.path.endsWith("/AGENTS.md")).map(entry => entry.path)).toEqual(paths);
		const firstRulesStat = await fs.stat(path.join(root, paths[0]!));
		expect(exact.entries.find(entry => entry.path === paths[0])?.mtime).toBe(Math.trunc(firstRulesStat.mtimeMs));
		expect(exact.truncated).toBe(false);
		await Bun.write(path.join(root, "zzz/AGENTS.md"), "overflow");
		const overflow = await listWorkspace({ path: root, maxDepth: 0, collectAgentsMd: true });
		expect(overflow.entries).toEqual([]);
		expect(overflow.agentsMdFiles).toEqual(paths);
		expect(overflow.truncated).toBe(true);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

it.skipIf(process.platform === "win32")("finds file symlink rules without traversing directory symlinks", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-symlinks-"));
	try {
		await Bun.write(path.join(root, "source/rules.txt"), "rules");
		await fs.symlink("rules.txt", path.join(root, "source/AGENTS.md"));
		await fs.symlink("source", path.join(root, "linked"));
		const result = await listWorkspace({ path: root, maxDepth: 3, collectAgentsMd: true });
		expect(result.entries.map(entry => entry.path)).toEqual([
			"linked",
			"source",
			"source/AGENTS.md",
			"source/rules.txt",
		]);
		expect(result.agentsMdFiles).toEqual(["source/AGENTS.md"]);
		expect(result.entries.find(entry => entry.path === "source/AGENTS.md")?.fileType).toBe(FileType.Symlink);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
