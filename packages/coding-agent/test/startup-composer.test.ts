import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, settingCacheScope, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pluginHelpers from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { Composer, type ComposerPreferences } from "@oh-my-pi/pi-tui/prompt/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	applyStartupComposerPreferences,
	beginStartupComposer,
	canReusePrepaintSessionUsage,
	ComposerLease,
	resolveTerminalSessionPrepaint,
	stopPendingStartupComposer,
	takeStartupComposerLease,
} from "@oh-my-pi/pi-coding-agent/modes/startup-composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { sessionDirForCwd, writeTerminalBreadcrumb } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { getAgentDir, getProjectDir, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./collab/helpers/in-memory-relay";
import { createTestSession } from "./utilities";

import {
	cfgAutocompleteMaxVisible,
	cfgComposerShape,
	cfgMarketplaceAutoUpdate,
	cfgShowHardwareCursor,
	cfgSpellingAutocomplete,
	cfgSpellingAutocorrect,
	cfgSpellingTypoDetection,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupQuiet,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
	cfgTuiImeSafeCursor,
	cfgTuiMaxInlineImages,
	cfgTuiResizeScrollback,
} from "@oh-my-pi/pi-coding-agent/modes/settings";

describe("startup composer terminal session identity", () => {
	it("selects the newest nonempty transcript instead of the last cache writer", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-newest-session-"));
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		const originalAgentDir = getAgentDir();
		setAgentDir(agentDir);
		const sessions = sessionDirForCwd(project);
		const olderSessionFile = path.join(sessions, "2026-01-01T00-00-00_old.jsonl");
		const newerSessionFile = path.join(sessions, "2026-01-02T00-00-00_new.jsonl");
		const originalTmuxPane = process.env.TMUX_PANE;
		fs.mkdirSync(project);
		fs.mkdirSync(sessions, { recursive: true });
		for (const [file, id] of [
			[olderSessionFile, "old"],
			[newerSessionFile, "new"],
		] as const) {
			fs.writeFileSync(
				file,
				`${JSON.stringify({ type: "session", id, cwd: project })}\n${JSON.stringify({
					type: "message",
					message: { role: "user", content: `${id} work` },
				})}\n`,
			);
		}
		fs.utimesSync(olderSessionFile, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
		fs.utimesSync(newerSessionFile, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
		process.env.TMUX_PANE = "%startup-newest-session";
		try {
			expect(resolveTerminalSessionPrepaint(project)).toEqual({
				cacheCwd: project,
				sessionFile: newerSessionFile,
			});
		} finally {
			setAgentDir(originalAgentDir);
			if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalTmuxPane;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("maps a recoverable backup to the primary session live resume will restore", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-session-backup-"));
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		const originalAgentDir = getAgentDir();
		setAgentDir(agentDir);
		const sessions = sessionDirForCwd(project);
		const primary = path.join(sessions, "2026-01-02T00-00-00_new.jsonl");
		const backup = `${primary}.123.bak`;
		fs.mkdirSync(project);
		fs.mkdirSync(sessions, { recursive: true });
		fs.writeFileSync(
			backup,
			`${JSON.stringify({ type: "session", id: "new", cwd: project })}\n${JSON.stringify({
				type: "message",
				message: { role: "user", content: "recoverable work" },
			})}\n`,
		);
		try {
			expect(resolveTerminalSessionPrepaint(project)?.sessionFile).toBe(primary);
		} finally {
			setAgentDir(originalAgentDir);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("breaks equal session mtimes with the header creation time used by live resume", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-session-created-"));
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		const originalAgentDir = getAgentDir();
		setAgentDir(agentDir);
		const sessions = sessionDirForCwd(project);
		const olderSessionFile = path.join(sessions, "z-older.jsonl");
		const newerSessionFile = path.join(sessions, "a-newer.jsonl");
		fs.mkdirSync(project);
		fs.mkdirSync(sessions, { recursive: true });
		for (const [file, id, timestamp] of [
			[olderSessionFile, "old", "2026-01-01T00:00:00Z"],
			[newerSessionFile, "new", "2026-01-02T00:00:00Z"],
		] as const) {
			fs.writeFileSync(
				file,
				`${JSON.stringify({ type: "session", id, timestamp, cwd: project })}\n${JSON.stringify({
					type: "message",
					message: { role: "user", content: `${id} work` },
				})}\n`,
			);
			fs.utimesSync(file, new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
		}
		try {
			expect(resolveTerminalSessionPrepaint(project)?.sessionFile).toBe(newerSessionFile);
		} finally {
			setAgentDir(originalAgentDir);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads past a fixed title slot before ranking equal-mtime sessions", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-slotted-created-"));
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		const originalAgentDir = getAgentDir();
		setAgentDir(agentDir);
		const sessions = sessionDirForCwd(project);
		const olderSessionFile = path.join(sessions, "z-older.jsonl");
		const newerSessionFile = path.join(sessions, "a-newer.jsonl");
		fs.mkdirSync(project);
		fs.mkdirSync(sessions, { recursive: true });
		for (const [file, id, timestamp] of [
			[olderSessionFile, "old", "2026-01-01T00:00:00Z"],
			[newerSessionFile, "new", "2026-01-02T00:00:00Z"],
		] as const) {
			fs.writeFileSync(
				file,
				`${JSON.stringify({ type: "title", v: 1, title: `${id} title` })}\n${JSON.stringify({
					type: "session",
					id,
					timestamp,
					cwd: project,
				})}\n`,
			);
			fs.utimesSync(file, new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
		}
		try {
			expect(resolveTerminalSessionPrepaint(project)?.sessionFile).toBe(newerSessionFile);
		} finally {
			setAgentDir(originalAgentDir);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the cached current-project session when a new terminal has no breadcrumb", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-fallback-session-"));
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		const originalAgentDir = getAgentDir();
		const originalTmuxPane = process.env.TMUX_PANE;
		fs.mkdirSync(project);
		setAgentDir(agentDir);
		const sessionFile = path.join(sessionDirForCwd(project), "session.jsonl");
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "cached", cwd: project })}\n${JSON.stringify({
				type: "message",
				message: { role: "user", content: "cached work" },
			})}\n`,
		);
		process.env.TMUX_PANE = "%startup-fallback-session";
		try {
			expect(resolveTerminalSessionPrepaint(project)).toEqual({
				cacheCwd: project,
				sessionFile,
			});
		} finally {
			setAgentDir(originalAgentDir);
			if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalTmuxPane;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not scan a new terminal's history when cached auto-resume is unusable", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-no-auto-resume-scan-"));
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		const originalAgentDir = getAgentDir();
		const originalTmuxPane = process.env.TMUX_PANE;
		fs.mkdirSync(project);
		setAgentDir(agentDir);
		process.env.TMUX_PANE = "%startup-no-auto-resume-scan";
		let scan: ReturnType<typeof vi.spyOn> | undefined;
		try {
			scan = vi.spyOn(fs, "readdirSync");
			expect(resolveTerminalSessionPrepaint(project, { canAutoResume: () => false })).toBeUndefined();
			expect(scan).not.toHaveBeenCalled();
		} finally {
			scan?.mockRestore();
			setAgentDir(originalAgentDir);
			if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalTmuxPane;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the canonical session directory instead of a custom cache-writer directory", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-canonical-session-dir-"));
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		const customSessionFile = path.join(root, "custom", "custom.jsonl");
		const originalAgentDir = getAgentDir();
		const originalTmuxPane = process.env.TMUX_PANE;
		fs.mkdirSync(project);
		fs.mkdirSync(path.dirname(customSessionFile));
		process.env.TMUX_PANE = "%startup-canonical-session-dir";
		setAgentDir(agentDir);
		const canonicalSessionFile = path.join(sessionDirForCwd(project), "canonical.jsonl");
		fs.mkdirSync(path.dirname(canonicalSessionFile), { recursive: true });
		for (const [file, id] of [
			[canonicalSessionFile, "canonical"],
			[customSessionFile, "custom"],
		] as const) {
			fs.writeFileSync(
				file,
				`${JSON.stringify({ type: "session", id, cwd: project })}\n${JSON.stringify({
					type: "message",
					message: { role: "user", content: `${id} work` },
				})}\n`,
			);
		}
		try {
			expect(resolveTerminalSessionPrepaint(project)?.sessionFile).toBe(canonicalSessionFile);
		} finally {
			setAgentDir(originalAgentDir);
			if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalTmuxPane;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("prefers the current project for a cross-cwd breadcrumb while the prior cwd still exists", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-cross-cwd-"));
		const agentDir = path.join(root, "agent");
		const projectA = path.join(root, "project-a");
		const projectB = path.join(root, "project-b");
		const sessionA = path.join(root, "session-a.jsonl");
		const originalAgentDir = getAgentDir();
		const originalTmuxPane = process.env.TMUX_PANE;
		fs.mkdirSync(projectA);
		fs.mkdirSync(projectB);
		fs.writeFileSync(sessionA, `${JSON.stringify({ type: "session", id: "a", cwd: projectA })}\n`);
		setAgentDir(agentDir);
		process.env.TMUX_PANE = "%startup-cross-cwd";
		const sessionB = path.join(sessionDirForCwd(projectB), "session-b.jsonl");
		fs.mkdirSync(path.dirname(sessionB), { recursive: true });
		fs.writeFileSync(
			sessionB,
			`${JSON.stringify({ type: "session", id: "b", cwd: projectB })}\n${JSON.stringify({
				type: "message",
				message: { role: "user", content: "project b work" },
			})}\n`,
		);
		try {
			writeTerminalBreadcrumb(projectA, sessionA);
			expect(resolveTerminalSessionPrepaint(projectB)).toEqual({ cacheCwd: projectB, sessionFile: sessionB });
		} finally {
			setAgentDir(originalAgentDir);
			if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalTmuxPane;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("selects a newer developer-only transcript like the live recent-session selector", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-developer-stub-"));
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		const originalAgentDir = getAgentDir();
		const originalTmuxPane = process.env.TMUX_PANE;
		fs.mkdirSync(project);
		process.env.TMUX_PANE = "%startup-developer-stub";
		setAgentDir(agentDir);
		const sessions = sessionDirForCwd(project);
		const resumable = path.join(sessions, "resumable.jsonl");
		const developerStub = path.join(sessions, "developer-stub.jsonl");
		fs.mkdirSync(sessions, { recursive: true });
		fs.writeFileSync(
			resumable,
			`${JSON.stringify({ type: "session", id: "resumable", cwd: project })}\n${JSON.stringify({
				type: "message",
				message: { role: "user", content: "real work" },
			})}\n`,
		);
		fs.writeFileSync(
			developerStub,
			`${JSON.stringify({ type: "session", id: "stub", cwd: project })}\n${JSON.stringify({
				type: "message",
				message: { role: "developer", content: "persisted reminder" },
			})}\n`,
		);
		fs.utimesSync(resumable, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
		fs.utimesSync(developerStub, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
		try {
			expect(resolveTerminalSessionPrepaint(project)?.sessionFile).toBe(developerStub);
			const live = await SessionManager.continueRecent(project);
			try {
				expect(live.getSessionFile()).toBe(developerStub);
			} finally {
				await live.close();
			}
		} finally {
			setAgentDir(originalAgentDir);
			if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalTmuxPane;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("normalizes an artifact breadcrumb to the interactive parent session", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-artifact-breadcrumb-"));
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		const parentSessionFile = path.join(root, "2026-01-01T00-00-00_parent.jsonl");
		const artifactDir = parentSessionFile.slice(0, -".jsonl".length);
		const childSessionFile = path.join(artifactDir, "agent.jsonl");
		const originalAgentDir = getAgentDir();
		const originalTmuxPane = process.env.TMUX_PANE;
		fs.mkdirSync(project);
		fs.mkdirSync(artifactDir);
		fs.writeFileSync(parentSessionFile, `${JSON.stringify({ type: "session", id: "parent", cwd: project })}\n`);
		fs.writeFileSync(childSessionFile, `${JSON.stringify({ type: "session", id: "child", cwd: project })}\n`);
		process.env.TMUX_PANE = "%startup-artifact-breadcrumb";
		setAgentDir(agentDir);
		try {
			writeTerminalBreadcrumb(project, childSessionFile);
			expect(resolveTerminalSessionPrepaint(project)).toEqual({
				cacheCwd: project,
				sessionFile: parentSessionFile,
			});
		} finally {
			setAgentDir(originalAgentDir);
			if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalTmuxPane;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not scan session history when a same-project breadcrumb is authoritative", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-breadcrumb-no-scan-"));
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		const sessionFile = path.join(root, "session.jsonl");
		const originalAgentDir = getAgentDir();
		const originalTmuxPane = process.env.TMUX_PANE;
		fs.mkdirSync(project);
		fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "current", cwd: project })}\n`);
		process.env.TMUX_PANE = "%startup-breadcrumb-no-scan";
		setAgentDir(agentDir);
		let scan: ReturnType<typeof vi.spyOn> | undefined;
		try {
			writeTerminalBreadcrumb(project, sessionFile);
			scan = vi.spyOn(fs, "readdirSync");
			expect(resolveTerminalSessionPrepaint(project)).toEqual({ cacheCwd: project, sessionFile });
			expect(scan).not.toHaveBeenCalled();
		} finally {
			scan?.mockRestore();
			setAgentDir(originalAgentDir);
			if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalTmuxPane;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips a cached empty /new stub when a different terminal will resume an older transcript", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-nonempty-session-"));
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		const originalAgentDir = getAgentDir();
		const originalTmuxPane = process.env.TMUX_PANE;
		fs.mkdirSync(project);
		setAgentDir(agentDir);
		const sessions = sessionDirForCwd(project);
		const olderSessionFile = path.join(sessions, "2026-01-01T00-00-00_old.jsonl");
		const emptySessionFile = path.join(sessions, "2026-01-02T00-00-00_empty.jsonl");
		fs.mkdirSync(sessions, { recursive: true });
		fs.writeFileSync(
			olderSessionFile,
			`${JSON.stringify({ type: "session", id: "old", cwd: project })}\n${JSON.stringify({
				type: "message",
				message: { role: "user", content: "pre-new work" },
			})}\n`,
		);
		fs.writeFileSync(emptySessionFile, `${JSON.stringify({ type: "session", id: "empty", cwd: project })}\n`);
		fs.utimesSync(olderSessionFile, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
		fs.utimesSync(emptySessionFile, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
		process.env.TMUX_PANE = "%startup-nonempty-session";
		try {
			expect(resolveTerminalSessionPrepaint(project)).toEqual({
				cacheCwd: project,
				sessionFile: olderSessionFile,
			});
		} finally {
			setAgentDir(originalAgentDir);
			if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalTmuxPane;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reuses the prior project cache row when the breadcrumb project moved", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-moved-project-"));
		const agentDir = path.join(root, "agent");
		const originalProject = path.join(root, "project");
		const movedProject = path.join(root, "renamed-project");
		const sessionFile = path.join(root, "session.jsonl");
		const originalAgentDir = getAgentDir();
		const originalTmuxPane = process.env.TMUX_PANE;
		fs.mkdirSync(originalProject);
		fs.writeFileSync(sessionFile, "{}\n");
		process.env.TMUX_PANE = "%startup-moved-project";
		setAgentDir(agentDir);
		try {
			writeTerminalBreadcrumb(originalProject, sessionFile);
			fs.renameSync(originalProject, movedProject);
			expect(resolveTerminalSessionPrepaint(movedProject)).toEqual({
				cacheCwd: originalProject,
				sessionFile,
			});
		} finally {
			setAgentDir(originalAgentDir);
			if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalTmuxPane;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("prefers a current-project session over a moved-project breadcrumb", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-moved-project-current-"));
		const agentDir = path.join(root, "agent");
		const originalProject = path.join(root, "project");
		const movedProject = path.join(root, "renamed-project");
		const oldSessionFile = path.join(root, "old-session.jsonl");
		const originalAgentDir = getAgentDir();
		const originalTmuxPane = process.env.TMUX_PANE;
		fs.mkdirSync(originalProject);
		fs.writeFileSync(oldSessionFile, "{}\n");
		process.env.TMUX_PANE = "%startup-moved-project-current";
		setAgentDir(agentDir);
		try {
			const currentSessionFile = path.join(sessionDirForCwd(movedProject), "current-session.jsonl");
			fs.mkdirSync(path.dirname(currentSessionFile), { recursive: true });
			fs.writeFileSync(
				currentSessionFile,
				`${JSON.stringify({ type: "session", id: "current", cwd: movedProject })}\n${JSON.stringify({
					type: "message",
					message: { role: "user", content: "current project work" },
				})}\n`,
			);
			writeTerminalBreadcrumb(originalProject, oldSessionFile);
			fs.renameSync(originalProject, movedProject);
			expect(resolveTerminalSessionPrepaint(movedProject)).toEqual({
				cacheCwd: movedProject,
				sessionFile: currentSessionFile,
			});
		} finally {
			setAgentDir(originalAgentDir);
			if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalTmuxPane;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("startup settings cache scope", () => {
	it("caches only persisted auto-resume settings", () => {
		expect(settingCacheScope("default")).toBe("global");
		expect(settingCacheScope("global")).toBe("global");
		expect(settingCacheScope("project")).toBe("project");
		expect(settingCacheScope("env")).toBeUndefined();
		expect(settingCacheScope("runtime")).toBeUndefined();
		expect(settingCacheScope("overlay")).toBeUndefined();
	});

	it("rejects cached session usage when launch-local config overlays are present", () => {
		expect(canReusePrepaintSessionUsage(true)).toBeTrue();
		expect(canReusePrepaintSessionUsage(true, ["", "/tmp/launch.yml"].join(path.delimiter))).toBeFalse();
		expect(canReusePrepaintSessionUsage(false, "/tmp/launch.yml")).toBeFalse();
		expect(canReusePrepaintSessionUsage(true, undefined, "/tmp/custom-sessions")).toBeFalse();
	});
});

class CountingTerminal extends VirtualTerminal {
	starts = 0;
	stops = 0;
	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.starts += 1;
		super.start(onInput, onResize);
	}

	override stop(): void {
		this.stops += 1;
		super.stop();
	}
}

class ThrowingStartTerminal extends CountingTerminal {
	override start(): void {
		this.starts += 1;
		throw new Error("terminal start failed");
	}
}
class InputTrackingTerminal extends CountingTerminal {
	startOptions: { deferInput?: boolean } | undefined;
	inputEnables = 0;
	override start(
		onInput: (data: string) => void,
		onResize: () => void,
		_onDisconnect?: () => void,
		options?: { deferInput?: boolean },
	): void {
		this.startOptions = options;
		super.start(onInput, onResize);
	}

	enableInput(): void {
		this.inputEnables += 1;
	}
}

describe("outer startup collaboration gate", () => {
	it.each(["completes", "fails"] as const)("keeps guest mutations gated until outer startup %s", async result => {
		const originalProject = getProjectDir();
		const originalIsTTY = process.stdin.isTTY;
		resetSettingsForTest();
		await initTheme();
		const testSession = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"collab.autoStart": "control",
				"collab.relayUrl": "ws://localhost:8788",
				"collab.webUrl": "https://collab.example",
			},
		});
		setProjectDir(testSession.tempDir);
		const activeSettings = await Settings.init({ inMemory: true, cwd: testSession.tempDir });
		cfgStartupCheckUpdate.override(activeSettings, false);
		cfgStartupChangelogMode.override(activeSettings, "hidden");
		cfgStartupSetupWizard.override(activeSettings, false);
		cfgStartupShowSplash.override(activeSettings, false);
		cfgMarketplaceAutoUpdate.override(activeSettings, "off");
		installInMemoryRelay();
		const publish = registry.publishCollabHost;
		vi.spyOn(registry, "publishCollabHost").mockImplementation((source, options) =>
			publish(source, { ...options, dir: testSession.tempDir }),
		);
		vi.spyOn(ModelRegistry.prototype, "refreshInBackground").mockImplementation(() => {});
		vi.spyOn(pluginHelpers, "preloadPluginRoots").mockResolvedValue(undefined);
		const init = InteractiveMode.prototype.init;
		vi.spyOn(InteractiveMode.prototype, "init").mockImplementation(function (this: InteractiveMode, options) {
			vi.spyOn(this.statusLine, "watchBranch").mockImplementation(() => {});
			return init.call(this, options);
		});
		const enteredReplay = Promise.withResolvers<InteractiveMode>();
		const releaseReplay = Promise.withResolvers<void>();
		const enteredCleanup = Promise.withResolvers<void>();
		const releaseCleanup = Promise.withResolvers<void>();
		const startupFailure = new Error("initial replay failed");
		const finished = new Error("finished observing startup");
		const renderInitialMessages = InteractiveMode.prototype.renderInitialMessages;
		vi.spyOn(InteractiveMode.prototype, "renderInitialMessages").mockImplementation(
			async function (this: InteractiveMode, options) {
				await renderInitialMessages.call(this, options);
				enteredReplay.resolve(this);
				await releaseReplay.promise;
				if (result === "fails") throw startupFailure;
			},
		);
		vi.spyOn(InteractiveMode.prototype, "getUserInput").mockRejectedValue(finished);
		type GuestOutcome = "refused" | "prompt" | "abort" | "agent";
		let outcome = Promise.withResolvers<GuestOutcome>();
		vi.spyOn(testSession.session, "prompt").mockResolvedValue(true);
		const prompt = vi.spyOn(testSession.session, "promptCustomMessage").mockImplementation(async () => {
			outcome.resolve("prompt");
			return true;
		});
		const abort = vi.spyOn(testSession.session, "abort").mockImplementation(async () => {
			outcome.resolve("abort");
		});
		const ensureLive = vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockImplementation(async () => {
			outcome.resolve("agent");
			return testSession.session;
		});
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		const authStorage = await AuthStorage.create(path.join(testSession.tempDir, "startup-auth.db"));
		beginStartupComposer({
			terminal: new VirtualTerminal(),
			version: "test",
			cache: false,
		});
		const rawArgs = ["--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp"];
		const running = runRootCommand(parseArgs(rawArgs), rawArgs, {
			settings: activeSettings,
			discoverAuthStorage: async () => authStorage,
			createAgentSession: async options => {
				if (!options?.preloadedExtensions || !options.eventBus) throw new Error("Missing startup context");
				await options.sessionManager?.close();
				return {
					session: testSession.session,
					setToolUIContext: () => {},
					extensionsResult: options.preloadedExtensions,
					eventBus: options.eventBus,
				};
			},
		}).then(
			() => undefined,
			error => error,
		);
		let mode: InteractiveMode | undefined;
		let writer: CollabSocket | undefined;
		try {
			mode = await Promise.race([
				enteredReplay.promise,
				running.then(error => {
					throw error ?? new Error("startup exited before replay");
				}),
			]);
			await mode.collabController.idle();
			const host = mode.collabHost;
			if (!host) throw new Error("early startup room missing");
			expect(await registry.listCollabHosts({ dir: testSession.tempDir })).toMatchObject([{ access: "control" }]);
			const link = parseCollabLink(host.link);
			if ("error" in link) throw new Error(link.error);
			const welcomed = Promise.withResolvers<boolean>();
			const asked = Promise.withResolvers<number>();
			writer = new CollabSocket({ wsUrl: link.wsUrl, role: "guest", key: await importRoomKey(link.key) });
			writer.onFrame = frame => {
				if (frame.t === "welcome") welcomed.resolve(frame.readOnly === true);
				if (frame.t === "error") outcome.resolve("refused");
				if (frame.t === "ui-request") asked.resolve(frame.request.reqId);
			};
			const guest = writer;
			guest.onOpen = () =>
				guest.send({
					t: "hello",
					proto: COLLAB_PROTO,
					name: "writer",
					writeToken: link.writeToken ? Buffer.from(link.writeToken).toString("base64url") : undefined,
				});
			guest.connect();
			expect(await welcomed.promise).toBe(false);
			const mutations: CollabFrame[] = [
				{ t: "prompt", text: "during replay" },
				{ t: "abort" },
				{ t: "agent-cmd", cmd: "chat", agentId: "startup-agent", text: "during replay" },
			];
			for (const frame of mutations) {
				outcome = Promise.withResolvers<GuestOutcome>();
				guest.send(frame);
				expect(await outcome.promise).toBe("refused");
			}
			expect(prompt).not.toHaveBeenCalled();
			expect(abort).not.toHaveBeenCalled();
			expect(ensureLive).not.toHaveBeenCalled();
			const answer = host.requestGuestUi({ kind: "select", title: "Startup question", options: ["Yes", "No"] });
			if (!answer) throw new Error("startup dialog unavailable");
			guest.send({ t: "ui-response", reqId: await asked.promise, value: "Yes" });
			expect(await answer).toEqual({ kind: "answered", value: "Yes" });

			if (result === "fails") {
				const shutdown = mode.collabController.shutdown.bind(mode.collabController);
				vi.spyOn(mode.collabController, "shutdown").mockImplementation(async reason => {
					enteredCleanup.resolve();
					await releaseCleanup.promise;
					await shutdown(reason);
				});
			}
			releaseReplay.resolve();
			if (result === "fails") {
				await enteredCleanup.promise;
				outcome = Promise.withResolvers<GuestOutcome>();
				guest.send({ t: "prompt", text: "during failure cleanup" });
				expect(await outcome.promise).toBe("refused");
				expect(prompt).not.toHaveBeenCalled();
				releaseCleanup.resolve();
				expect(await running).toBe(startupFailure);
				expect(await registry.listCollabHosts({ dir: testSession.tempDir })).toEqual([]);
			} else {
				expect(await running).toBe(finished);
				outcome = Promise.withResolvers<GuestOutcome>();
				guest.send({ t: "prompt", text: "after startup" });
				expect(await outcome.promise).toBe("prompt");
				expect(prompt).toHaveBeenCalledWith(
					expect.objectContaining({ content: "after startup", attribution: "user" }),
					expect.objectContaining({ streamingBehavior: "steer" }),
				);
			}
		} finally {
			releaseReplay.resolve();
			releaseCleanup.resolve();
			await running;
			writer?.close();
			await mode?.collabController.shutdown("test cleanup");
			mode?.stop();
			stopPendingStartupComposer();
			vi.restoreAllMocks();
			uninstallInMemoryRelay();
			authStorage.close();
			// setProjectDir chdir'd into tempDir; Windows cannot delete the process cwd.
			setProjectDir(originalProject);
			await testSession.cleanup();
			resetSettingsForTest();
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		}
	});
});

describe("Composer prepaint", () => {
	let settings: Settings;

	let config: ComposerPreferences;
	beforeEach(async () => {
		resetSettingsForTest();
		await initTheme();
		settings = await Settings.init({ inMemory: true });
		config = {
			quiet: cfgStartupQuiet.get(settings),
			composerShape: cfgComposerShape.get(settings) ?? "box",
			showHardwareCursor: cfgShowHardwareCursor.get(settings),
			maxInlineImages: cfgTuiMaxInlineImages.get(settings),
			resizeScrollback: cfgTuiResizeScrollback.get(settings),
			imeSafeCursor: cfgTuiImeSafeCursor.get(settings),
			autocompleteMaxVisible: cfgAutocompleteMaxVisible.get(settings),
			spellingTypoDetection: cfgSpellingTypoDetection.get(settings),
			spellingAutocomplete: cfgSpellingAutocomplete.get(settings),
			spellingAutocorrect: cfgSpellingAutocorrect.get(settings),
		};
	});

	afterEach(() => {
		stopPendingStartupComposer();
		resetSettingsForTest();
	});

	it("keeps one live editor and terminal across handoff", () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		const submit = vi.fn();
		composer.editor.onSubmit = submit;

		composer.start();
		terminal.sendInput("alpha");
		terminal.sendInput("\r");

		expect(composer.editor.getExpandedText()).toBe("alpha");
		expect(submit).not.toHaveBeenCalled();
		expect(terminal.starts).toBe(1);

		composer.transfer();
		composer.stop();
		terminal.sendInput(" beta");

		expect(composer.editor.getExpandedText()).toBe("alpha beta");
		expect(terminal.starts).toBe(1);
		expect(terminal.stops).toBe(0);

		composer.ui.stop();
		expect(terminal.stops).toBe(1);
	});

	it("adopts the live draft with final theme, keybindings, and submit behavior", async () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		terminal.sendInput("alpha ");
		terminal.sendInput("\x1b[200~one\ntwo\x1b[201~");
		terminal.sendInput(" omega");
		terminal.sendInput("\x1b[D");

		const expectedDraft = composer.editor.getExpandedText();
		const expectedCursor = composer.editor.getCursor();
		const lease = new ComposerLease(composer);
		const adoptedComposer = lease.composer;
		const testSession = await createTestSession({
			inMemory: true,
			settingsOverrides: { symbolPreset: "ascii" },
		});
		let mode: InteractiveMode | undefined;

		try {
			await initTheme(false, "ascii");
			cfgComposerShape.set(settings, "box");
			vi.spyOn(KeybindingsManager, "create").mockReturnValue(KeybindingsManager.inMemory({ "app.clear": "ctrl+x" }));
			mode = new InteractiveMode(
				testSession.session,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				adoptedComposer,
			);
			lease.adopt();
			vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});

			expect(mode.ui).toBe(adoptedComposer.ui);
			expect(mode.editor).toBe(adoptedComposer.editor);
			await mode.init({ suppressWelcomeIntro: true });

			expect(mode.ui).toBe(adoptedComposer.ui);
			expect(mode.editor).toBe(adoptedComposer.editor);
			expect(mode.editor.getExpandedText()).toBe(expectedDraft);
			expect(mode.editor.getCursor()).toEqual(expectedCursor);
			expect(terminal.starts).toBe(1);
			const adoptedEditor = Bun.stripANSI(mode.editor.render(40).join("\n"));
			expect(adoptedEditor.startsWith("+")).toBe(true);
			expect(adoptedEditor).not.toContain("╭");

			terminal.sendInput("\x03");
			expect(mode.editor.getExpandedText()).toBe(expectedDraft);
			terminal.sendInput("\x18");
			expect(mode.editor.getExpandedText()).toBe("");
			expect(mode.editor.disableSubmit).toBe(false);
			terminal.sendInput("ready");
			expect(mode.editor.getExpandedText()).toBe("ready");

			const submitted = mode.getUserInput();
			expect(mode.editor.disableSubmit).toBe(false);
			terminal.sendInput("\r");
			expect(await submitted).toEqual(expect.objectContaining({ text: "ready" }));
			expect(mode.editor.getExpandedText()).toBe("");
			expect(terminal.starts).toBe(1);
		} finally {
			mode?.stop();
			await testSession.cleanup();
			vi.restoreAllMocks();
			await initTheme();
		}
	});

	it("keeps submit gated during initialization, then dispatches with steer", async () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		const mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease.composer,
		);
		lease.adopt();
		const enteredInit = Promise.withResolvers<void>();
		const releaseInit = Promise.withResolvers<void>();
		vi.spyOn(mode, "refreshSlashCommandState").mockImplementation(async () => {
			enteredInit.resolve();
			await releaseInit.promise;
		});
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		const prompt = vi.spyOn(testSession.session, "prompt").mockResolvedValue(true);

		try {
			const initializing = mode.init({ suppressWelcomeIntro: true });
			await enteredInit.promise;
			terminal.sendInput("alpha");
			terminal.sendInput("\r");

			expect(prompt).not.toHaveBeenCalled();
			expect(mode.editor.getExpandedText()).toBe("alpha");
			expect(mode.editor.disableSubmit).toBe(true);

			releaseInit.resolve();
			await initializing;
			// Init wired the submit pipeline and lifted the gate: an Enter before
			// the input loop's first getUserInput dispatches directly with steer
			// instead of being silently dropped.
			expect(mode.editor.disableSubmit).toBe(false);
			terminal.sendInput("\r");
			for (let i = 0; i < 50 && prompt.mock.calls.length === 0; i++) await Promise.resolve();
			expect(prompt).toHaveBeenCalledWith("alpha", expect.objectContaining({ streamingBehavior: "steer" }));
			expect(mode.editor.getExpandedText()).toBe("");
		} finally {
			releaseInit.resolve();
			mode.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("accepts input while the initial CLI prompt's first turn is still running", async () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		const mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease.composer,
		);
		lease.adopt();
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		const turn = Promise.withResolvers<boolean>();
		const prompt = vi.spyOn(testSession.session, "prompt").mockResolvedValue(true);

		try {
			await mode.init({ suppressWelcomeIntro: true });

			// The `omp "prompt"` launch shape: the CLI message is dispatched after
			// init and its first turn is still in flight when the user types. The
			// input loop has not reached getUserInput yet.
			prompt.mockReturnValueOnce(turn.promise);
			const initialTurn = testSession.session.prompt("count to 25", { streamingBehavior: "steer" });

			terminal.sendInput("also add tests");
			terminal.sendInput("\r");
			for (let i = 0; i < 50 && prompt.mock.calls.length < 2; i++) await Promise.resolve();
			expect(prompt).toHaveBeenCalledWith("also add tests", expect.objectContaining({ streamingBehavior: "steer" }));
			expect(mode.editor.getExpandedText()).toBe("");

			turn.resolve(true);
			await initialTurn;
		} finally {
			mode.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("tracks terminal ownership until a lease is adopted", () => {
		const abandonedTerminal = new CountingTerminal();
		const abandonedComposer = new Composer({ preferences: config, terminal: abandonedTerminal });
		abandonedComposer.start();
		const abandonedLease = new ComposerLease(abandonedComposer);
		abandonedLease.dispose();
		abandonedLease.dispose();
		expect(abandonedTerminal.stops).toBe(1);

		const adoptedTerminal = new CountingTerminal();
		const adoptedComposer = new Composer({ preferences: config, terminal: adoptedTerminal });
		adoptedComposer.start();
		const adoptedLease = new ComposerLease(adoptedComposer);
		adoptedLease.adopt();
		adoptedLease.dispose();
		expect(adoptedTerminal.stops).toBe(0);
		adoptedLease.composer.ui.stop();
		expect(adoptedTerminal.stops).toBe(1);
	});

	it("restores a partially started terminal and leaves no pending owner", () => {
		const terminal = new ThrowingStartTerminal();
		expect(() => beginStartupComposer({ preferences: config, terminal, cache: false })).toThrow(
			"terminal start failed",
		);
		expect(terminal.starts).toBe(1);
		expect(terminal.stops).toBe(1);
		expect(takeStartupComposerLease()).toBeUndefined();
	});

	it("bounds a tall startup draft after adoption in a short terminal", async () => {
		const terminal = new CountingTerminal(80, 8);
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		for (let index = 0; index < 18; index += 1) {
			terminal.sendInput(`line-${index}`);
			if (index < 17) terminal.sendInput("\n");
		}
		const draft = composer.editor.getExpandedText();
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		const mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease.composer,
		);
		lease.adopt();
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});

		try {
			await mode.init({ suppressWelcomeIntro: true });
			await terminal.waitForRender();
			expect(mode.editor.getExpandedText()).toBe(draft);
			expect(draft.split("\n")).toHaveLength(18);
			expect(mode.editor.render(80).length).toBeLessThanOrEqual(4);
			expect(terminal.getViewport().join("\n")).not.toContain("Starting OMP");
		} finally {
			mode.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("restores the terminal before an early double interrupt exits", () => {
		const terminal = new CountingTerminal();
		const exit = vi.fn();
		let now = 1_000;
		const composer = new Composer({ preferences: config, terminal, exit, now: () => now });
		composer.start();

		terminal.sendInput("draft");
		terminal.sendInput("\x03");
		expect(composer.editor.getExpandedText()).toBe("");
		now += 100;
		terminal.sendInput("\x03");

		expect(terminal.stops).toBe(1);
		expect(exit).toHaveBeenCalledWith(130);
	});

	it("forward-deletes a startup draft before interactive keybindings load, exiting once it is empty", () => {
		const terminal = new CountingTerminal();
		const exit = vi.fn();
		const composer = new Composer({ preferences: config, terminal, exit });
		composer.start();

		terminal.sendInput("draft");
		terminal.sendInput("\x1b[D"); // Left, so Ctrl+D has a character ahead of the cursor
		terminal.sendInput("\x04");
		expect(composer.editor.getExpandedText()).toBe("draf");
		expect(exit).not.toHaveBeenCalled();
		expect(terminal.stops).toBe(0);

		for (let i = 0; i < 4; i++) terminal.sendInput("\x7f"); // Backspace the rest of the draft
		expect(composer.editor.getExpandedText()).toBe("");
		terminal.sendInput("\x04");

		expect(exit).toHaveBeenCalledWith(0);
		expect(terminal.stops).toBe(1);
	});

	it("keeps emergency exit live after adoption until interactive handlers replace it", () => {
		const terminal = new CountingTerminal();
		const exit = vi.fn();
		const composer = new Composer({ preferences: config, terminal, exit });
		composer.start();
		const lease = new ComposerLease(composer);
		lease.adopt();

		// InputController.setupKeyHandlers() has not run yet; a stalled startup must
		// still honor Ctrl+D so a raw-mode user can abort.
		terminal.sendInput("\x04");

		expect(exit).toHaveBeenCalledWith(0);
		expect(terminal.stops).toBe(1);
	});

	it("renders the complete interactive welcome scene on the first frame", async () => {
		const terminal = new CountingTerminal(80, 32);
		const composer = new Composer({
			preferences: config,
			terminal,
			welcome: { version: "9.9.9" },
		});
		composer.start();
		await terminal.waitForRender(() => terminal.getViewport().some(row => Bun.stripANSI(row).includes("v9.9.9")));

		const output = terminal
			.getViewport()
			.map(r => Bun.stripANSI(r))
			.join("\n");
		expect(output).not.toContain("Starting OMP");
		expect(output).toContain("╰");
		const initialEditorRow = terminal
			.getViewport()
			.map(row => Bun.stripANSI(row))
			.findLastIndex(row => row.startsWith("╰"));
		composer.updateWelcome({ version: "10.0.0-authoritative" });
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("v10.0.0-authoritative")),
		);
		const updatedEditorRow = terminal
			.getViewport()
			.map(row => Bun.stripANSI(row))
			.findLastIndex(row => row.startsWith("╰"));
		expect(updatedEditorRow).toBe(initialEditorRow);
		composer.stop();
	});

	it("adopted welcome survives handoff with authoritative data", async () => {
		const terminal = new CountingTerminal(80, 32);
		const composer = new Composer({
			preferences: config,
			terminal,
			// The prepaint's speculative version; InteractiveMode's is authoritative.
			welcome: { version: "9.9.8" },
		});
		composer.start();
		await terminal.waitForRender(() => terminal.getViewport().some(row => Bun.stripANSI(row).includes("v9.9.8")));
		const prepaintRows = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(prepaintRows.join("\n")).toContain("v9.9.8");
		const prepaintEditorRow = prepaintRows.findLastIndex(row => row.startsWith("╰"));

		terminal.sendInput("draft message");
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		let mode: InteractiveMode | undefined;

		try {
			mode = new InteractiveMode(
				testSession.session,
				"9.9.9",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				lease.composer,
			);
			lease.adopt();
			vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
			const realTopBorder = vi
				.spyOn(mode.statusLine, "getTopBorder")
				.mockReturnValue({ content: "real status bar", width: 15, revision: 1 });
			terminal.sendInput(" between");
			expect(mode.editor.getExpandedText()).toBe("draft message between");
			await terminal.waitForRender();
			await mode.init({ suppressWelcomeIntro: true });
			await terminal.waitForRender();

			expect(terminal.starts).toBe(1);
			expect(mode.editor.getExpandedText()).toBe("draft message between");
			const output = terminal
				.getViewport()
				.map(r => Bun.stripANSI(r))
				.join("\n");
			expect(output).toContain("v9.9.9");
			expect(output).not.toContain("v9.9.8");
			realTopBorder.mockReturnValue({ content: "real status bar *18 ?5", width: 21, revision: 2 });
			mode.ui.requestRender();
			await terminal.waitForRender(() =>
				terminal.getViewport().some(row => Bun.stripANSI(row).includes("real status bar *18 ?5")),
			);
			const welcomeMatches = (output.match(/v9\.9\.9/g) || []).length;
			expect(welcomeMatches).toBe(1);
			const adoptedEditorRow = terminal
				.getViewport()
				.map(row => Bun.stripANSI(row))
				.findLastIndex(row => row.startsWith("╰"));
			expect(adoptedEditorRow).toBe(prepaintEditorRow);
		} finally {
			mode?.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("preferences feed applies quiet mode", async () => {
		const terminal = new CountingTerminal(80, 32);
		beginStartupComposer({
			preferences: config,
			terminal,
			version: "9.9.9",
			cache: false,
		});
		await terminal.waitForRender(() => terminal.getViewport().some(row => Bun.stripANSI(row).includes("v9.9.9")));

		applyStartupComposerPreferences({
			autoResume: false,
			quiet: true,
			composerShape: "box",
			showHardwareCursor: config.showHardwareCursor,
			maxInlineImages: config.maxInlineImages,
			resizeScrollback: config.resizeScrollback,
			imeSafeCursor: config.imeSafeCursor,
			autocompleteMaxVisible: config.autocompleteMaxVisible,
			spellingTypoDetection: cfgSpellingTypoDetection.get(settings),
			spellingAutocomplete: cfgSpellingAutocomplete.get(settings),
			spellingAutocorrect: cfgSpellingAutocorrect.get(settings),
			theme: {},
		});
		await terminal.waitForRender();

		const output = terminal
			.getViewport()
			.map(r => Bun.stripANSI(r))
			.join("\n");
		expect(output).not.toContain("v9.9.9");

		terminal.sendInput("still editable");
		await terminal.waitForRender();
		expect(
			terminal
				.getViewport()
				.map(r => Bun.stripANSI(r))
				.join("\n"),
		).toContain("still editable");
	});

	it("defers raw input until resolved settings arrive, adoption as fallback", async () => {
		// Regression contract: losing the deferral re-blinds typing during the
		// startup module-load stall; losing the enable leaves the keyboard dead
		// for the whole session.
		const terminal = new InputTrackingTerminal(80, 32);
		beginStartupComposer({
			preferences: config,
			terminal,
			version: "9.9.9",
			cache: false,
		});
		// The prepaint must be physically written before any async runtime import
		// can monopolize the event loop; a merely queued render is still a blind gap.
		expect(terminal.getViewport().some(row => Bun.stripANSI(row).includes("9.9.9"))).toBeTrue();
		expect(terminal.startOptions?.deferInput).toBeTrue();
		expect(terminal.inputEnables).toBe(0);

		applyStartupComposerPreferences({ ...config, theme: {}, autoResume: false });
		expect(terminal.inputEnables).toBe(1);

		// Adoption after preferences must not double-enable…
		const lease = takeStartupComposerLease();
		lease?.adopt();
		expect(terminal.inputEnables).toBe(1);
		lease?.composer.ui.stop();
	});

	it("adoption enables raw input when settings never resolved", () => {
		const terminal = new InputTrackingTerminal(80, 32);
		beginStartupComposer({
			preferences: config,
			terminal,
			version: "9.9.9",
			cache: false,
		});
		const lease = takeStartupComposerLease();
		lease?.adopt();
		expect(terminal.inputEnables).toBe(1);
		lease?.composer.ui.stop();
	});
});
