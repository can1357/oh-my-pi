import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BUILTIN_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import * as piUtils from "@oh-my-pi/pi-utils";

describe("/move directory completion", () => {
	let tempDir: string;
	const move = BUILTIN_SLASH_COMMANDS.find(c => c.name === "move");

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-completion-"));
		vi.spyOn(piUtils, "getProjectDir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("is wired to the /move command", () => {
		expect(move).toBeDefined();
		expect(move!.getArgumentCompletions).toBeDefined();
	});

	it("lists directories in the current project dir when no prefix is given", async () => {
		await fs.mkdir(path.join(tempDir, "src"));
		await fs.mkdir(path.join(tempDir, "tests"));
		await fs.writeFile(path.join(tempDir, "README.md"), "");

		const result = await move!.getArgumentCompletions!("");
		expect(result).not.toBeNull();
		const values = result!.map(i => i.value);
		expect(values).toContain("src/");
		expect(values).toContain("tests/");
		expect(values).not.toContain("README.md");
	});

	it("filters directories by prefix", async () => {
		await fs.mkdir(path.join(tempDir, "src"));
		await fs.mkdir(path.join(tempDir, "scripts"));
		await fs.mkdir(path.join(tempDir, "tests"));

		const result = await move!.getArgumentCompletions!("sr");
		expect(result).not.toBeNull();
		const values = result!.map(i => i.value);
		expect(values).toContain("src/");
		expect(values).not.toContain("scripts/");
		expect(values).not.toContain("tests/");
	});

	it("completes inside a subdirectory", async () => {
		const subDir = path.join(tempDir, "packages");
		await fs.mkdir(subDir);
		await fs.mkdir(path.join(subDir, "coding-agent"));
		await fs.mkdir(path.join(subDir, "tui"));

		const result = await move!.getArgumentCompletions!("packages/");
		expect(result).not.toBeNull();
		const values = result!.map(i => i.value);
		expect(values).toContain("packages/coding-agent/");
		expect(values).toContain("packages/tui/");
	});

	it("completes relative paths", async () => {
		await fs.mkdir(path.join(tempDir, "src"));

		const result = await move!.getArgumentCompletions!("./sr");
		expect(result).not.toBeNull();
		expect(result!.map(i => i.value)).toContain("./src/");
	});

	it("completes parent directory paths", async () => {
		const parentDir = path.dirname(tempDir);
		const siblingName = `omp-move-sibling-${path.basename(tempDir)}`;
		const siblingDir = path.join(parentDir, siblingName);
		await fs.mkdir(siblingDir);
		try {
			const result = await move!.getArgumentCompletions!("..");
			expect(result).not.toBeNull();
			expect(result!.map(i => i.value)).toContain(`../${siblingName}/`);
		} finally {
			await fs.rm(siblingDir, { recursive: true, force: true });
		}
	});

	it("completes directories with spaces in names", async () => {
		const spacedDir = path.join(tempDir, "My Project");
		await fs.mkdir(spacedDir);
		await fs.mkdir(path.join(spacedDir, "src"));

		const result = await move!.getArgumentCompletions!("My Project/");
		expect(result).not.toBeNull();
		expect(result!.map(i => i.value)).toContain("My Project/src/");
	});

	it("filters inside a space-containing directory", async () => {
		const spacedDir = path.join(tempDir, "My Project");
		await fs.mkdir(spacedDir);
		await fs.mkdir(path.join(spacedDir, "src"));
		await fs.mkdir(path.join(spacedDir, "tests"));

		const result = await move!.getArgumentCompletions!("My Project/sr");
		expect(result).not.toBeNull();
		const values = result!.map(i => i.value);
		expect(values).toContain("My Project/src/");
		expect(values).not.toContain("My Project/tests/");
	});

	it("returns null for non-matching prefixes", async () => {
		await fs.mkdir(path.join(tempDir, "src"));

		const result = await move!.getArgumentCompletions!("xyz");
		expect(result).toBeNull();
	});

	it("completes home-relative paths", async () => {
		const homeDir = path.join(tempDir, "fake-home");
		await fs.mkdir(homeDir);
		await fs.mkdir(path.join(homeDir, "project-a"));
		await fs.mkdir(path.join(homeDir, "project-b"));
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);

		const result = await move!.getArgumentCompletions!("~/");
		expect(result).not.toBeNull();
		const values = result!.map(i => i.value);
		expect(values).toContain("~/project-a/");
		expect(values).toContain("~/project-b/");
	});

	it("completes absolute paths", async () => {
		const targetDir = path.join(tempDir, "absolute-target");
		await fs.mkdir(targetDir);

		const result = await move!.getArgumentCompletions!(path.join(tempDir, "absolute-"));
		expect(result).not.toBeNull();
		expect(result!.map(i => i.label)).toContain("absolute-target/");
	});
});
