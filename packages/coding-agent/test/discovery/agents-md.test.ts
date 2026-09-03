import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { loadAgentsMd } from "@oh-my-pi/pi-coding-agent/discovery/agents-md";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

function writeAgents(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

describe("standalone AGENTS.md discovery", () => {
	let tempDir!: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-md-"));
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("finds workspace AGENTS.md above a nested repository without loading home context", async () => {
		const home = path.join(tempDir, "home");
		const workspaceRoot = path.join(home, "repos", "writer");
		const repoRoot = path.join(workspaceRoot, "internal", "service");
		const cwd = path.join(repoRoot, "src");
		fs.mkdirSync(cwd, { recursive: true });

		const repoAgents = path.join(repoRoot, "AGENTS.md");
		const workspaceAgents = path.join(workspaceRoot, "AGENTS.md");
		const homeAgents = path.join(home, "AGENTS.md");
		writeAgents(repoAgents, "repo context");
		writeAgents(workspaceAgents, "workspace context");
		writeAgents(homeAgents, "home context");

		const context: LoadContext = { cwd, home, repoRoot };
		const result = await loadAgentsMd(context);

		expect(result.items.map(file => file.path)).toEqual([repoAgents, workspaceAgents]);
	});

	test("loads cwd and intermediate context with no repository root under home", async () => {
		const home = path.join(tempDir, "home");
		const workspaceRoot = path.join(home, "workspace");
		const intermediate = path.join(workspaceRoot, "packages");
		const cwd = path.join(intermediate, "service");
		fs.mkdirSync(cwd, { recursive: true });

		const cwdAgents = path.join(cwd, "AGENTS.md");
		const intermediateAgents = path.join(intermediate, "AGENTS.md");
		const homeAgents = path.join(home, "AGENTS.md");
		writeAgents(cwdAgents, "cwd context");
		writeAgents(intermediateAgents, "intermediate context");
		writeAgents(homeAgents, "home context");

		const context: LoadContext = { cwd, home, repoRoot: null };
		const result = await loadAgentsMd(context);

		expect(result.items.map(file => file.path)).toEqual([cwdAgents, intermediateAgents, homeAgents]);
	});

	test("includes home context when the repository root is above home", async () => {
		const workspaceRoot = path.join(tempDir, "workspace");
		const home = path.join(workspaceRoot, "user");
		const repoRoot = workspaceRoot;
		const cwd = path.join(home, "project");
		fs.mkdirSync(cwd, { recursive: true });

		const repoAgents = path.join(repoRoot, "AGENTS.md");
		const homeAgents = path.join(home, "AGENTS.md");
		writeAgents(repoAgents, "repo context");
		writeAgents(homeAgents, "home context");

		const context: LoadContext = { cwd, home, repoRoot };
		const result = await loadAgentsMd(context);

		expect(result.items.map(file => file.path)).toEqual([homeAgents, repoAgents]);
	});

	test("keeps the repository root boundary when the repository is outside home", async () => {
		const home = path.join(tempDir, "home");
		const workspaceRoot = path.join(tempDir, "workspace");
		const repoRoot = path.join(workspaceRoot, "service");
		const cwd = path.join(repoRoot, "src");
		fs.mkdirSync(cwd, { recursive: true });

		const repoAgents = path.join(repoRoot, "AGENTS.md");
		const workspaceAgents = path.join(workspaceRoot, "AGENTS.md");
		writeAgents(repoAgents, "repo context");
		writeAgents(workspaceAgents, "workspace context");

		const context: LoadContext = { cwd, home, repoRoot };
		const result = await loadAgentsMd(context);

		expect(result.items.map(file => file.path)).toEqual([repoAgents]);
	});

	test("skips AGENTS.md inside a hidden owner directory", async () => {
		const home = path.join(tempDir, "home");
		const repoRoot = path.join(home, "repo");
		const hiddenRoot = path.join(repoRoot, ".hidden");
		const cwd = path.join(hiddenRoot, "service");
		fs.mkdirSync(cwd, { recursive: true });

		const hiddenAgents = path.join(hiddenRoot, "AGENTS.md");
		const repoAgents = path.join(repoRoot, "AGENTS.md");
		writeAgents(hiddenAgents, "hidden context");
		writeAgents(repoAgents, "repo context");

		const context: LoadContext = { cwd, home, repoRoot };
		const result = await loadAgentsMd(context);

		expect(result.items.map(file => file.path)).toEqual([repoAgents]);
	});
});
