import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	additionalWorkspaceDirectories,
	normalizeSessionWorkspace,
	reconcileSettingsWorkspaceRoots,
} from "@oh-my-pi/pi-coding-agent/session/session-workspace";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

describe("normalizeSessionWorkspace", () => {
	it("places cwd first and dedupes additional directories", () => {
		const cwd = "/home/user/proj";
		const workspace = normalizeSessionWorkspace({ cwd, directories: ["/home/user/other", cwd, "/home/user/other"] });
		expect(workspace.cwd).toBe(path.resolve(cwd));
		expect(workspace.directories).toEqual([path.resolve(cwd), path.resolve("/home/user/other")]);
	});

	it("resolves relative additional directories against the normalized cwd", () => {
		const workspace = normalizeSessionWorkspace({ cwd: "/home/user/proj", directories: ["../sibling"] });
		expect(workspace.directories).toEqual([path.resolve("/home/user/proj"), path.resolve("/home/user/sibling")]);
	});

	it("expands ~ to home", () => {
		const workspace = normalizeSessionWorkspace({ cwd: "/tmp", directories: ["~/docs"] });
		expect(workspace.directories[1]).toBe(path.join(process.env.HOME ?? os.homedir(), "docs"));
	});
});

describe("additionalWorkspaceDirectories", () => {
	it("returns every directory except cwd", () => {
		const workspace = normalizeSessionWorkspace({ cwd: "/a", directories: ["/b", "/c"] });
		expect(additionalWorkspaceDirectories(workspace)).toEqual([path.resolve("/b"), path.resolve("/c")]);
	});

	it("is empty for a single-root workspace", () => {
		const workspace = normalizeSessionWorkspace({ cwd: "/a" });
		expect(additionalWorkspaceDirectories(workspace)).toEqual([]);
	});
});

describe("SessionManager workspace directories", () => {
	it("starts with no additional directories", () => {
		const session = SessionManager.inMemory();
		expect(session.getAdditionalDirectories()).toEqual([]);
		expect([session.getCwd(), ...session.getAdditionalDirectories()]).toEqual([session.getCwd()]);
	});

	it("seeds from setAdditionalDirectories and excludes cwd", async () => {
		const session = SessionManager.inMemory();
		await session.setAdditionalDirectories(["/some/other", session.getCwd()]);
		// cwd is filtered out of the additional set.
		expect(session.getAdditionalDirectories()).toEqual(["/some/other"]);
		expect([session.getCwd(), ...session.getAdditionalDirectories()]).toEqual([session.getCwd(), "/some/other"]);
	});

	it("addWorkspaceDirectory rejects the cwd itself", async () => {
		const session = SessionManager.inMemory();
		await expect(session.addWorkspaceDirectory(session.getCwd())).rejects.toThrow(/primary workspace root/);
	});

	it("addWorkspaceDirectory returns the resolved path and dedupes on repeat", async () => {
		const session = SessionManager.inMemory();
		const added = await session.addWorkspaceDirectory("/another/repo");
		expect(added).toBe(path.resolve("/another/repo"));
		expect(session.getAdditionalDirectories()).toEqual([path.resolve("/another/repo")]);

		// Second add of the same path is a no-op.
		const second = await session.addWorkspaceDirectory("/another/repo");
		expect(second).toBeNull();
		expect(session.getAdditionalDirectories()).toEqual([path.resolve("/another/repo")]);
	});

	it("addWorkspaceDirectory expands ~ to home", async () => {
		const session = SessionManager.inMemory();
		const home = os.homedir();
		const added = await session.addWorkspaceDirectory("~/projects");
		expect(added).toBe(path.join(home, "projects"));
		expect(session.getAdditionalDirectories()).toEqual([path.join(home, "projects")]);
	});

	it("removeWorkspaceDirectory removes a known root and returns null when absent", async () => {
		const session = SessionManager.inMemory();
		await session.addWorkspaceDirectory("/x");
		const removed = await session.removeWorkspaceDirectory("/x");
		expect(removed).toBe(path.resolve("/x"));
		expect(session.getAdditionalDirectories()).toEqual([]);

		const again = await session.removeWorkspaceDirectory("/x");
		expect(again).toBeNull();
	});

	it("removeWorkspaceDirectory matches ~-expanded paths", async () => {
		const session = SessionManager.inMemory();
		const home = os.homedir();
		await session.addWorkspaceDirectory("~/projects");
		// Removing with the ~ form should match the expanded stored path.
		const removed = await session.removeWorkspaceDirectory("~/projects");
		expect(removed).toBe(path.join(home, "projects"));
		expect(session.getAdditionalDirectories()).toEqual([]);
	});

	it("persists additionalDirectories in the session header across reopen", async () => {
		using tempDir = TempDir.createSync("@pi-session-workspace-persist-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		await session.addWorkspaceDirectory(path.join(tempDir.path(), "sibling"));
		// Materialize on disk so reopen reads the header (lazy gate needs assistant output).
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const file = session.getSessionFile();
		expect(file).toBeDefined();
		const reopened = await SessionManager.open(file!);
		expect(reopened.getAdditionalDirectories()).toEqual([path.join(tempDir.path(), "sibling")]);
		expect([reopened.getCwd(), ...reopened.getAdditionalDirectories()]).toEqual([
			tempDir.path(),
			path.join(tempDir.path(), "sibling"),
		]);
	});

	it("clears the header field when the last additional directory is removed", async () => {
		using tempDir = TempDir.createSync("@pi-session-workspace-clear-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		await session.addWorkspaceDirectory(path.join(tempDir.path(), "extra"));
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		await session.removeWorkspaceDirectory(path.join(tempDir.path(), "extra"));
		const file = session.getSessionFile()!;
		const header = JSON.parse(
			fs
				.readFileSync(file, "utf8")
				.split("\n")
				.filter(l => l.trim())[1]!,
		);
		expect(header.additionalDirectories).toBeUndefined();
	});

	it("setAdditionalDirectories clears stale roots when called with an empty list", async () => {
		const session = SessionManager.inMemory();
		await session.addWorkspaceDirectory("/stale");
		expect(session.getAdditionalDirectories()).toEqual([path.resolve("/stale")]);

		await session.setAdditionalDirectories([]);
		expect(session.getAdditionalDirectories()).toEqual([]);
	});

	it("setAdditionalDirectories persists the updated header on a resumed session", async () => {
		using tempDir = TempDir.createSync("@pi-session-workspace-resume-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		// Simulate a resumed session: append an assistant message so the file exists, then setAdditionalDirectories.
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		await session.setAdditionalDirectories([path.join(tempDir.path(), "added")]);
		const file = session.getSessionFile()!;
		const header = JSON.parse(
			fs
				.readFileSync(file, "utf8")
				.split("\n")
				.filter(l => l.trim())[1]!,
		);
		expect(header.additionalDirectories).toEqual([path.join(tempDir.path(), "added")]);
	});

	it("keeps seeded roots in memory until the session is durable (no empty session file)", async () => {
		using tempDir = TempDir.createSync("@pi-session-workspace-lazy-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		await session.setAdditionalDirectories([path.join(tempDir.path(), "extra")]);
		await session.addWorkspaceDirectory(path.join(tempDir.path(), "extra2"));
		// Seeding roots must not materialize an empty resumable session file.
		expect(fs.readdirSync(tempDir.path()).filter(f => f.endsWith(".jsonl"))).toEqual([]);

		// Once the session produces durable output, the header carries the roots.
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const reopened = await SessionManager.open(session.getSessionFile()!);
		expect(reopened.getAdditionalDirectories()).toEqual([
			path.join(tempDir.path(), "extra"),
			path.join(tempDir.path(), "extra2"),
		]);
	});

	it("forkFrom preserves additionalDirectories from the source session", async () => {
		using tempDir = TempDir.createSync("@pi-session-workspace-fork-");
		const source = SessionManager.create(tempDir.path(), tempDir.path());
		await source.addWorkspaceDirectory(path.join(tempDir.path(), "extra"));
		source.appendMessage(makeAssistantMessage());
		await source.flush();

		const forked = await SessionManager.forkFrom(source.getSessionFile()!, tempDir.path());
		expect(forked.getAdditionalDirectories()).toEqual([path.join(tempDir.path(), "extra")]);
	});
});

describe("reconcileSettingsWorkspaceRoots", () => {
	const cwd = "/home/user/proj";
	const A = path.resolve("/roots/a");
	const B = path.resolve("/roots/b");
	const HEADER = path.resolve("/roots/from-header");

	it("revokes a root the new settings value dropped", () => {
		// Unioning the live list with the new value made this unreachable: the live
		// list already holds A, so [A] -> [] kept A granted and a directory removed
		// from settings could never lose tool access.
		const { roots, owned } = reconcileSettingsWorkspaceRoots({
			cwd,
			live: [A],
			previouslyOwned: new Set([A]),
			configured: [],
		});
		expect(roots).toEqual([]);
		expect([...owned]).toEqual([]);
	});

	it("replaces rather than accumulates when the value changes wholesale", () => {
		const { roots } = reconcileSettingsWorkspaceRoots({
			cwd,
			live: [A],
			previouslyOwned: new Set([A]),
			configured: [B],
		});
		expect(roots).toEqual([B]);
	});

	it("keeps a root that settings never granted", () => {
		// Session-header (resume/fork) and `/add-dir` roots are not settings-owned,
		// so a settings re-read must leave them alone even when it grants nothing.
		const { roots } = reconcileSettingsWorkspaceRoots({
			cwd,
			live: [HEADER, A],
			previouslyOwned: new Set([A]),
			configured: [],
		});
		expect(roots).toEqual([HEADER]);
	});

	it("keeps a root that is both live-added and still configured", () => {
		const { roots, owned } = reconcileSettingsWorkspaceRoots({
			cwd,
			live: [A, HEADER],
			previouslyOwned: new Set([A]),
			configured: [A, B],
		});
		expect(roots).toEqual([A, HEADER, B]);
		expect([...owned]).toEqual([A, B]);
	});

	it("keeps a manual root the settings value named and then dropped", () => {
		// HEADER is live on an independent grant (session header or `/add-dir`).
		// The setting then names the same path, and later drops it. Claiming it as
		// settings-owned on the overlap made the next reconcile revoke a directory
		// the operator granted separately and never withdrew.
		const overlap = reconcileSettingsWorkspaceRoots({
			cwd,
			live: [HEADER],
			previouslyOwned: new Set(),
			configured: [HEADER, B],
		});
		expect(overlap.roots).toEqual([HEADER, B]);
		// The overlapping path is NOT claimed; the genuinely new root is.
		expect([...overlap.owned]).toEqual([B]);

		const removal = reconcileSettingsWorkspaceRoots({
			cwd,
			live: overlap.roots,
			previouslyOwned: overlap.owned,
			configured: [],
		});
		// B was granted by the setting and is gone; HEADER's own grant survives.
		expect(removal.roots).toEqual([HEADER]);
		expect([...removal.owned]).toEqual([]);
	});

	it("normalizes the incoming value so a relative entry compares equal", () => {
		// The live list is normalized by SessionManager, so an unnormalized
		// settings entry would otherwise look like a different root and both
		// revoke the real one and add a duplicate.
		const { roots } = reconcileSettingsWorkspaceRoots({
			cwd,
			live: [path.resolve(cwd, "sub")],
			previouslyOwned: new Set([path.resolve(cwd, "sub")]),
			configured: ["sub"],
		});
		expect(roots).toEqual([path.resolve(cwd, "sub")]);
	});

	it("grants a new root on the first reconcile, when nothing was owned yet", () => {
		const { roots, owned } = reconcileSettingsWorkspaceRoots({
			cwd,
			live: [],
			previouslyOwned: new Set(),
			configured: [A],
		});
		expect(roots).toEqual([A]);
		expect([...owned]).toEqual([A]);
	});
});
