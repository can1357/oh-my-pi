import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { createAgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

describe("advisor watchdog prompt discovery", () => {
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		await Bun.sleep(0);
		for (const tempDir of tempDirs.splice(0)) {
			await tempDir.remove();
		}
	});

	async function withAdvisorHistory(
		tempDir: TempDir,
		cwd: string,
		run: (dump: string) => void | Promise<void>,
	): Promise<void> {
		const authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		let session: AgentSession | undefined;
		try {
			authStorage.setRuntimeApiKey("openai", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			const sessionManager = SessionManager.create(cwd, tempDir.join("sessions"));
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
			if (dump === null) throw new Error("Advisor history was not available.");
			await run(dump);
		} finally {
			try {
				await session?.dispose();
			} finally {
				authStorage.close();
			}
		}
	}

	it("discovers and appends WATCHDOG.md to the advisor prompt", async () => {
		const tempDir = TempDir.createSync("@pi-advisor-watchdog-");
		tempDirs.push(tempDir);
		const cwd = tempDir.join("project-root");
		fs.mkdirSync(cwd, { recursive: true });

		// Write a WATCHDOG.md file
		const watchdogContent = "Watchdog rule: Watch out for cheating on edits.";
		fs.writeFileSync(path.join(cwd, "WATCHDOG.md"), watchdogContent, "utf8");

		const authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		let session: AgentSession | undefined;
		try {
			authStorage.setRuntimeApiKey("openai", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			const sessionManager = SessionManager.create(cwd, tempDir.join("sessions"));
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
			expect(dump).toContain("</attention>");
		} finally {
			try {
				await session?.dispose();
			} finally {
				authStorage.close();
			}
		}
	});

	it("adds built-in active child repo context to the advisor prompt", async () => {
		const tempDir = TempDir.createSync("@pi-advisor-watchdog-");
		tempDirs.push(tempDir);
		const cwd = tempDir.join("parent-cwd");
		fs.mkdirSync(path.join(cwd, "active-project", ".git"), { recursive: true });
		const watchdogContent = "Parent watchdog remains before built-in active repo context.";
		fs.writeFileSync(path.join(cwd, "WATCHDOG.md"), watchdogContent, "utf8");

		await withAdvisorHistory(tempDir, cwd, dump => {
			expect(dump).toContain("Especially pay attention to:");
			expect(dump).toContain("exactly one direct child git repository");
			expect(dump).toContain("`active-project`");
			expect(dump).toContain("Do not claim work is missing, destroyed, or absent at the parent cwd");
			expect(dump).toContain(watchdogContent);
			expect(dump.indexOf(watchdogContent)).toBeLessThan(
				dump.indexOf("Do not claim work is missing, destroyed, or absent at the parent cwd"),
			);
		});
	});

	it("omits built-in active child repo context when multiple direct child repos exist", async () => {
		const tempDir = TempDir.createSync("@pi-advisor-watchdog-");
		tempDirs.push(tempDir);
		const cwd = tempDir.join("parent-cwd");
		fs.mkdirSync(path.join(cwd, "active-project", ".git"), { recursive: true });
		fs.mkdirSync(path.join(cwd, "second-project", ".git"), { recursive: true });

		await withAdvisorHistory(tempDir, cwd, dump => {
			expect(dump).not.toContain("exactly one direct child git repository");
			expect(dump).not.toContain("Do not claim work is missing, destroyed, or absent at the parent cwd");
		});
	});

	it("resolves nested folders and sorts by depth", async () => {
		const tempDir = TempDir.createSync("@pi-advisor-watchdog-");
		tempDirs.push(tempDir);
		const parentCwd = tempDir.join("project-root");
		const childCwd = path.join(parentCwd, "subfolder");
		fs.mkdirSync(childCwd, { recursive: true });

		// Write two WATCHDOG.md files
		const parentWatchdogContent = "Parent watchdog rule.";
		const childWatchdogContent = "Child watchdog rule.";
		fs.writeFileSync(path.join(parentCwd, "WATCHDOG.md"), parentWatchdogContent, "utf8");
		fs.writeFileSync(path.join(childCwd, "WATCHDOG.md"), childWatchdogContent, "utf8");

		const authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		let session: AgentSession | undefined;
		try {
			authStorage.setRuntimeApiKey("openai", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			const sessionManager = SessionManager.create(childCwd, tempDir.join("sessions"));
			const result = await createAgentSession({
				cwd: childCwd,
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
			expect(dump).toContain("</attention>");
			expect(dump).toContain(parentWatchdogContent);
			expect(dump).toContain(childWatchdogContent);
			// Check ordering: parent is farther (depth 1), child is closer (depth 0).
			// So parent watchdog should appear first, followed by child watchdog.
			const parentIndex = dump!.indexOf(parentWatchdogContent);
			const childIndex = dump!.indexOf(childWatchdogContent);
			expect(parentIndex).toBeGreaterThan(-1);
			expect(childIndex).toBeGreaterThan(-1);
			expect(parentIndex).toBeLessThan(childIndex);
		} finally {
			try {
				await session?.dispose();
			} finally {
				authStorage.close();
			}
		}
	});

	it("discovers user-level and native project-level watchdog files", async () => {
		const tempDir = TempDir.createSync("@pi-advisor-watchdog-");
		tempDirs.push(tempDir);
		const cwd = tempDir.join("project-root");
		const ompDir = path.join(cwd, ".omp");
		const userAgentDir = tempDir.join("user-agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(ompDir, { recursive: true });
		fs.mkdirSync(userAgentDir, { recursive: true });

		const userWatchdogContent = "User-level watchdog rule.";
		const nativeWatchdogContent = "Native project watchdog rule.";
		const standaloneWatchdogContent = "Standalone project watchdog rule.";

		fs.writeFileSync(path.join(userAgentDir, "WATCHDOG.md"), userWatchdogContent, "utf8");
		fs.writeFileSync(path.join(ompDir, "WATCHDOG.md"), nativeWatchdogContent, "utf8");
		fs.writeFileSync(path.join(cwd, "WATCHDOG.md"), standaloneWatchdogContent, "utf8");

		const authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		let session: AgentSession | undefined;
		try {
			authStorage.setRuntimeApiKey("openai", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			const sessionManager = SessionManager.create(cwd, tempDir.join("sessions"));
			const result = await createAgentSession({
				cwd,
				agentDir: userAgentDir,
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
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			session = result.session;

			expect(session.isAdvisorActive()).toBe(true);
			const dump = session.formatAdvisorHistoryAsText();
			expect(dump).not.toBeNull();
			expect(dump).toContain(userWatchdogContent);
			expect(dump).toContain(nativeWatchdogContent);
			expect(dump).toContain(standaloneWatchdogContent);

			// Check ordering: user-level should appear first, then native project level (.omp/WATCHDOG.md has depth 0),
			// then standalone project level (cwd/WATCHDOG.md has depth 0).
			// Between native and standalone, they both have depth 0, so their relative order doesn't strictly matter
			// as long as user-level comes before both of them.
			const userIndex = dump!.indexOf(userWatchdogContent);
			const nativeIndex = dump!.indexOf(nativeWatchdogContent);
			const standaloneIndex = dump!.indexOf(standaloneWatchdogContent);

			expect(userIndex).toBeGreaterThan(-1);
			expect(nativeIndex).toBeGreaterThan(-1);
			expect(standaloneIndex).toBeGreaterThan(-1);

			expect(userIndex).toBeLessThan(nativeIndex);
			expect(userIndex).toBeLessThan(standaloneIndex);
		} finally {
			try {
				await session?.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
});
