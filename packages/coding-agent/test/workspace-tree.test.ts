import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildDirectoryTree, buildWorkspaceTree } from "@oh-my-pi/pi-coding-agent/workspace-tree";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workspace-tree-"));
	tempDirs.push(dir);
	return dir;
}

async function writeFileWithMtime(filePath: string, content: string, mtimeMs: number): Promise<void> {
	await Bun.write(filePath, content);
	const mtime = new Date(mtimeMs);
	await fs.utimes(filePath, mtime, mtime);
}

async function touchDirWithMtime(dirPath: string, mtimeMs: number): Promise<void> {
	await fs.mkdir(dirPath, { recursive: true });
	const mtime = new Date(mtimeMs);
	await fs.utimes(dirPath, mtime, mtime);
}

function lineIndex(rendered: string, needle: string): number {
	return rendered.split("\n").findIndex(line => line.includes(needle));
}

describe("buildWorkspaceTree", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	it("sorts files and directories together by modification time", async () => {
		const cwd = await makeTempDir();
		const base = Date.now() - 60_000;
		const recentDir = path.join(cwd, "recent-dir");
		const staleDir = path.join(cwd, "stale-dir");
		await touchDirWithMtime(recentDir, base + 3_000);
		await touchDirWithMtime(staleDir, base);
		await writeFileWithMtime(path.join(cwd, "newest.txt"), "newest", base + 4_000);
		await writeFileWithMtime(path.join(cwd, "old.txt"), "old", base + 2_000);
		await touchDirWithMtime(recentDir, base + 3_000);
		await touchDirWithMtime(staleDir, base);

		const tree = await buildWorkspaceTree(cwd);

		expect(lineIndex(tree.rendered, "newest.txt")).toBeGreaterThan(-1);
		expect(lineIndex(tree.rendered, "recent-dir/")).toBeGreaterThan(lineIndex(tree.rendered, "newest.txt"));
		expect(lineIndex(tree.rendered, "old.txt")).toBeGreaterThan(lineIndex(tree.rendered, "recent-dir/"));
		expect(lineIndex(tree.rendered, "stale-dir/")).toBeGreaterThan(lineIndex(tree.rendered, "old.txt"));
	});

	it("keeps the newest entries, a truncation marker, and the oldest entry per directory", async () => {
		const cwd = await makeTempDir();
		const base = Date.now() - 60_000;
		for (let i = 0; i < 13; i += 1) {
			const ageRank = String(i).padStart(2, "0");
			await writeFileWithMtime(path.join(cwd, `file-${ageRank}.txt`), ageRank, base + (13 - i) * 1_000);
		}

		const tree = await buildWorkspaceTree(cwd);

		expect(tree.truncated).toBe(true);
		expect(tree.rendered).toContain("… 1 more");
		expect(tree.rendered).toContain("file-00.txt");
		expect(tree.rendered).toContain("file-10.txt");
		expect(tree.rendered).not.toContain("file-11.txt");
		expect(tree.rendered).toContain("file-12.txt");
		expect(lineIndex(tree.rendered, "… 1 more")).toBeLessThan(lineIndex(tree.rendered, "file-12.txt"));
	});

	it("enforces the depth cap and skips hidden, excluded, and gitignored paths", async () => {
		const cwd = await makeTempDir();
		await Bun.write(path.join(cwd, ".gitignore"), "ignored.txt\nignored-dir/\na/b/ignored-nested.txt\n");
		await writeFileWithMtime(path.join(cwd, "kept.txt"), "kept", Date.now() - 1_000);
		await writeFileWithMtime(path.join(cwd, "ignored.txt"), "ignored", Date.now() - 1_000);
		await touchDirWithMtime(path.join(cwd, "ignored-dir"), Date.now() - 1_000);
		await writeFileWithMtime(path.join(cwd, "ignored-dir", "child.txt"), "ignored", Date.now() - 1_000);
		await touchDirWithMtime(path.join(cwd, "node_modules"), Date.now() - 1_000);
		await writeFileWithMtime(path.join(cwd, "node_modules", "pkg.js"), "ignored", Date.now() - 1_000);
		await touchDirWithMtime(path.join(cwd, ".git"), Date.now() - 1_000);
		await writeFileWithMtime(path.join(cwd, ".git", "config"), "ignored", Date.now() - 1_000);
		await touchDirWithMtime(path.join(cwd, "a", "b", "c", "d"), Date.now() - 1_000);
		await writeFileWithMtime(path.join(cwd, "a", "b", "c", "d", "deep.txt"), "deep", Date.now() - 1_000);
		await writeFileWithMtime(path.join(cwd, "a", "b", "ignored-nested.txt"), "ignored", Date.now() - 1_000);

		const tree = await buildWorkspaceTree(cwd);

		expect(tree.rendered).toContain("kept.txt");
		expect(tree.rendered).toContain("c/");
		expect(tree.rendered).not.toContain("ignored.txt");
		expect(tree.rendered).not.toContain("ignored-dir");
		expect(tree.rendered).not.toContain("ignored-nested.txt");
		expect(tree.rendered).not.toContain("node_modules");
		expect(tree.rendered).not.toContain(".git");
		expect(tree.rendered).not.toContain("d/");
		expect(tree.rendered).not.toContain("deep.txt");
	});

	it("caps the rendered tree at the hard line limit", async () => {
		const cwd = await makeTempDir();
		const base = Date.now() - 60_000;
		for (let dirIndex = 0; dirIndex < 12; dirIndex += 1) {
			const dirName = `dir-${String(dirIndex).padStart(2, "0")}`;
			const dirPath = path.join(cwd, dirName);
			await fs.mkdir(dirPath, { recursive: true });
			for (let fileIndex = 0; fileIndex < 12; fileIndex += 1) {
				const fileName = `file-${String(fileIndex).padStart(2, "0")}.txt`;
				await writeFileWithMtime(path.join(dirPath, fileName), fileName, base + fileIndex);
			}
			await touchDirWithMtime(dirPath, base + dirIndex);
		}

		const tree = await buildWorkspaceTree(cwd);
		const renderedLines = tree.rendered.split("\n");

		expect(tree.truncated).toBe(true);
		expect(tree.totalLines).toBeLessThanOrEqual(120);
		expect(renderedLines.length).toBeLessThanOrEqual(120);
		expect(tree.rendered).toContain("ln elided…]");
	});

	it("can keep root entries uncapped while truncating child directories", async () => {
		const cwd = await makeTempDir();
		const childDir = path.join(cwd, "child");
		const base = Date.now() - 60_000;
		await touchDirWithMtime(childDir, base + 30_000);
		await writeFileWithMtime(path.join(cwd, ".DS_Store"), "mac metadata", base + 40_000);
		for (let i = 0; i < 13; i += 1) {
			const fileName = `root-${String(i).padStart(2, "0")}.txt`;
			await writeFileWithMtime(path.join(cwd, fileName), fileName, base + i);
		}
		for (let i = 0; i < 13; i += 1) {
			const fileName = `child-${String(i).padStart(2, "0")}.txt`;
			await writeFileWithMtime(path.join(childDir, fileName), fileName, base + i);
		}

		const tree = await buildDirectoryTree(cwd, {
			maxDepth: 2,
			perDirLimit: 12,
			rootLimit: null,
		});

		expect(tree.truncated).toBe(true);
		expect(tree.rendered).not.toContain(".DS_Store");
		expect(tree.rendered).toContain("root-11.txt");
		expect(tree.rendered).toContain("root-12.txt");
		expect(tree.rendered).toContain("child-11.txt");
		expect(tree.rendered).not.toContain("child-01.txt");
		expect(tree.rendered).toContain("child-00.txt");
		expect(tree.rendered).toContain("… 1 more");
	});

	it("returns AGENTS.md files at directory depths one through four", async () => {
		const cwd = await makeTempDir();

		await Bun.write(path.join(cwd, "AGENTS.md"), "root rules");
		await Bun.write(path.join(cwd, "one", "AGENTS.md"), "depth one rules");
		await Bun.write(path.join(cwd, "one", "two", "AGENTS.md"), "depth two rules");
		await Bun.write(path.join(cwd, "one", "two", "three", "AGENTS.md"), "depth three rules");
		await Bun.write(path.join(cwd, "one", "two", "three", "four", "AGENTS.md"), "depth four rules");
		await Bun.write(path.join(cwd, "one", "two", "three", "four", "five", "AGENTS.md"), "too deep");

		const tree = await buildWorkspaceTree(cwd);

		expect(tree.agentsMdFiles).toEqual([
			"one/AGENTS.md",
			"one/two/AGENTS.md",
			"one/two/three/AGENTS.md",
			"one/two/three/four/AGENTS.md",
		]);
	});

	it("surfaces gitignored AGENTS.md files but not AGENTS.md under ignored directories", async () => {
		const cwd = await makeTempDir();
		await Bun.write(path.join(cwd, ".gitignore"), "src/AGENTS.md\nignored-dir/\nnode_modules/\n.git/\n.hidden/\n");
		await Bun.write(path.join(cwd, "src", "AGENTS.md"), "src rules");
		await Bun.write(path.join(cwd, "src", "main.ts"), "source");
		await Bun.write(path.join(cwd, "ignored-dir", "AGENTS.md"), "ignored dir rules");
		await Bun.write(path.join(cwd, "node_modules", "pkg", "AGENTS.md"), "ignored dependency rules");
		await Bun.write(path.join(cwd, ".git", "AGENTS.md"), "ignored git rules");
		await Bun.write(path.join(cwd, ".hidden", "AGENTS.md"), "ignored hidden rules");

		const tree = await buildWorkspaceTree(cwd);

		expect(tree.rendered).toContain("src/");
		expect(tree.rendered).toContain("AGENTS.md");
		expect(tree.rendered).toContain("main.ts");
		expect(tree.rendered).not.toContain("ignored-dir");
		expect(tree.rendered).not.toContain("node_modules");
		expect(tree.rendered).not.toContain(".hidden");
		expect(tree.agentsMdFiles).toEqual(["src/AGENTS.md"]);
	});

	it("renders prompt-cache-stable absolute mtimes (not render-time relative ages)", async () => {
		const cwd = await makeTempDir();
		// Fixed mtime in the past so the absolute render is deterministic.
		const fixedMtime = Date.UTC(2025, 0, 2, 3, 4, 0); // 2025-01-02 03:04 UTC
		await writeFileWithMtime(path.join(cwd, "stable.txt"), "x", fixedMtime);

		const first = await buildWorkspaceTree(cwd);
		// A relative "ago" age would drift with the wall clock between builds;
		// an absolute mtime must not. Two builds of an unchanged tree must be
		// byte-identical so the system-prompt prefix stays cacheable.
		const second = await buildWorkspaceTree(cwd);

		expect(first.rendered).toBe(second.rendered);
		expect(first.rendered).toContain("2025-01-02 03:04");
		expect(first.rendered).not.toContain("ago");
	});

	it("keeps relative ages for buildDirectoryTree (tool output, not cached)", async () => {
		const cwd = await makeTempDir();
		await writeFileWithMtime(path.join(cwd, "recent.txt"), "x", Date.now() - 5 * 60_000);

		const tree = await buildDirectoryTree(cwd, { maxDepth: 1 });

		expect(tree.rendered).toContain("ago");
	});
});
