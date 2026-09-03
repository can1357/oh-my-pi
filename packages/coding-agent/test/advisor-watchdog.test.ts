import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { discoverWatchdogFiles } from "../src/advisor/watchdog";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("advisor watchdog prompt discovery", () => {
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			await tempDir.remove();
		}
	});

	it("appends WATCHDOG.md and active child repo context to the advisor prompt", async () => {
		const tempDir = TempDir.createSync("@pi-advisor-watchdog-");
		tempDirs.push(tempDir);
		const cwd = tempDir.join("project-root");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(path.join(cwd, "active-project", ".git"), { recursive: true });

		// Write a WATCHDOG.md file
		const watchdogContent = "Watchdog rule: Watch out for cheating on edits.";
		fs.writeFileSync(path.join(cwd, "WATCHDOG.md"), watchdogContent, "utf8");
		const activeRepoMarker = "`active-project`";

		const authStorage = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		try {
			authStorage.setRuntimeApiKey("openai", "test-key");
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const sessionManager = SessionManager.inMemory(cwd);
			const result = await createAgentSession({
				cwd,
				agentDir: tempDir.path(),
				sessionManager,
				authStorage,
				modelRegistry,
				settings: (() => {
					const s = Settings.isolated({
						"async.enabled": false,
						"advisor.enabled": true,
					});
					s.setModelRole("advisor", "openai/gpt-4o-mini");
					return s;
				})(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				workspaceTree: {
					rootPath: cwd,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			session = result.session;

			expect(session.isAdvisorActive()).toBe(true);
			const dump = session.formatAdvisorHistoryAsText();
			expect(dump).not.toBeNull();
			expect(dump).toContain("Especially pay attention to:");
			expect(dump).toContain("<attention>");
			expect(dump).toContain(watchdogContent);
			expect(dump).toContain(activeRepoMarker);
			expect(dump!.indexOf(watchdogContent)).toBeLessThan(dump!.indexOf(activeRepoMarker));
			expect(dump).toContain("</attention>");
		} finally {
			try {
				await session?.dispose();
			} finally {
				authStorage.close();
			}
		}
	});

	it("resolves nested folders and sorts by depth", async () => {
		const tempDir = TempDir.createSync("@pi-advisor-watchdog-");
		tempDirs.push(tempDir);
		const parentCwd = tempDir.join("project-root");
		const childCwd = path.join(parentCwd, "subfolder");
		fs.mkdirSync(path.join(parentCwd, ".git"), { recursive: true });
		fs.mkdirSync(childCwd, { recursive: true });

		// Write two WATCHDOG.md files
		const parentWatchdogContent = "Parent watchdog rule.";
		const childWatchdogContent = "Child watchdog rule.";
		fs.writeFileSync(path.join(parentCwd, "WATCHDOG.md"), parentWatchdogContent, "utf8");
		fs.writeFileSync(path.join(childCwd, "WATCHDOG.md"), childWatchdogContent, "utf8");

		const dump = (await discoverWatchdogFiles(childCwd, tempDir.path())).join("\n\n");
		expect(dump).toContain("Especially pay attention to:");
		expect(dump).toContain("<attention>");
		expect(dump).toContain("</attention>");
		expect(dump).toContain(parentWatchdogContent);
		expect(dump).toContain(childWatchdogContent);
		// Parent is farther (depth 1), so it must precede the leaf watchdog.
		const parentIndex = dump.indexOf(parentWatchdogContent);
		const childIndex = dump.indexOf(childWatchdogContent);
		expect(parentIndex).toBeGreaterThan(-1);
		expect(childIndex).toBeGreaterThan(-1);
		expect(parentIndex).toBeLessThan(childIndex);
	});

	it("discovers user-level and native project-level watchdog files", async () => {
		const tempDir = TempDir.createSync("@pi-advisor-watchdog-");
		tempDirs.push(tempDir);
		const cwd = tempDir.join("project-root");
		const ompDir = path.join(cwd, ".omp");
		const userAgentDir = tempDir.join("user-agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
		fs.mkdirSync(ompDir, { recursive: true });
		fs.mkdirSync(userAgentDir, { recursive: true });

		const userWatchdogContent = "User-level watchdog rule.";
		const nativeWatchdogContent = "Native project watchdog rule.";
		const standaloneWatchdogContent = "Standalone project watchdog rule.";

		fs.writeFileSync(path.join(userAgentDir, "WATCHDOG.md"), userWatchdogContent, "utf8");
		fs.writeFileSync(path.join(ompDir, "WATCHDOG.md"), nativeWatchdogContent, "utf8");
		fs.writeFileSync(path.join(cwd, "WATCHDOG.md"), standaloneWatchdogContent, "utf8");

		const dump = (await discoverWatchdogFiles(cwd, userAgentDir)).join("\n\n");
		expect(dump).toContain(userWatchdogContent);
		expect(dump).toContain(nativeWatchdogContent);
		expect(dump).toContain(standaloneWatchdogContent);

		// User-level instructions precede both project-level variants.
		const userIndex = dump.indexOf(userWatchdogContent);
		const nativeIndex = dump.indexOf(nativeWatchdogContent);
		const standaloneIndex = dump.indexOf(standaloneWatchdogContent);
		expect(userIndex).toBeGreaterThan(-1);
		expect(nativeIndex).toBeGreaterThan(-1);
		expect(standaloneIndex).toBeGreaterThan(-1);
		expect(userIndex).toBeLessThan(nativeIndex);
		expect(userIndex).toBeLessThan(standaloneIndex);
	});
});
