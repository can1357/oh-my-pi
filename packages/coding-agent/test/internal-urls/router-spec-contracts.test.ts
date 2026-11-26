import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type InternalResource,
	InternalUrlRouter,
	type ProtocolHandler,
	type SchemeSpec,
	UrlSchemeTable,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { registerArtifactsDir } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

const resolveNothing = async (): Promise<InternalResource> => {
	throw new Error("fixture:// never resolves");
};

const fileWrite: NonNullable<SchemeSpec["write"]> = {
	via: "file",
	payload: "text",
	scope: "workspace",
	tier: () => "write",
};

function fixture(spec: SchemeSpec, hooks: Partial<ProtocolHandler> = {}): ProtocolHandler {
	return { scheme: "fixture", spec, resolve: resolveNothing, ...hooks };
}

afterEach(() => {
	InternalUrlRouter.resetForTests();
});

describe("session scheme registration invariants", () => {
	const locate = async (): Promise<string | null> => "/tmp/fixture";
	const register = (handler: ProtocolHandler): void => new UrlSchemeTable("Test scheme").replace([handler]);

	it("refuses a write() hook without spec.write", () => {
		const handler = fixture({ backing: "virtual", selectors: "lines", immutable: false }, { write: async () => {} });
		expect(() => register(handler)).toThrow("fixture:// handler has write() but spec.write.via is absent");
	});

	it("refuses a write() hook when tools own the writes", () => {
		const handler = fixture(
			{ backing: "file", selectors: "lines", immutable: false, write: fileWrite },
			{ locate, write: async () => {} },
		);
		expect(() => register(handler)).toThrow('fixture:// handler has write() but spec.write.via is "file"');
	});

	it("refuses spec.write.via handler without a write() hook", () => {
		const handler = fixture({
			backing: "virtual",
			selectors: "lines",
			immutable: false,
			write: { ...fileWrite, via: "handler" },
		});
		expect(() => register(handler)).toThrow('fixture:// spec.write.via is "handler" but the handler lacks write()');
	});

	it("refuses file writes without a file backing, a locate() hook, or with an immutable spec", () => {
		const table = new UrlSchemeTable("Test scheme");
		const router = new InternalUrlRouter([table]);
		const virtualBacked = fixture(
			{ backing: "virtual", selectors: "lines", immutable: false, write: fileWrite },
			{ locate },
		);
		const unlocatable = fixture({ backing: "file", selectors: "lines", immutable: false, write: fileWrite });
		const immutable = fixture({ backing: "file", selectors: "lines", immutable: true, write: fileWrite }, { locate });
		expect(() => table.replace([virtualBacked])).toThrow('requires backing "file", not "virtual"');
		expect(() => table.replace([unlocatable])).toThrow("requires a locate() hook");
		expect(() => table.replace([immutable])).toThrow("contradicts spec.immutable");
		expect(router.canHandle("fixture://x")).toBe(false);
	});

	it("refuses a sandbox scope sandboxRoots could not locate", () => {
		const handler = fixture(
			{ backing: "file", selectors: "lines", immutable: false, write: { ...fileWrite, scope: "sandbox" } },
			{ locate },
		);
		expect(() => register(handler)).toThrow("requires spec.linkable and a locateSync()");
	});

	it("serves a mutable file-backed session scheme whose tools own the writes, in that session only", () => {
		const table = new UrlSchemeTable("Test scheme");
		const router = new InternalUrlRouter([table]);
		table.replace([fixture({ backing: "file", selectors: "lines", immutable: false, write: fileWrite }, { locate })]);
		expect(router.canHandle("fixture://x")).toBe(true);
		expect(router.fileWritable("fixture://x")).toBe(true);
		expect(InternalUrlRouter.builtins().canHandle("fixture://x")).toBe(false);
		expect(new InternalUrlRouter().canHandle("fixture://x")).toBe(false);
		expect(InternalUrlRouter.isBuiltin("fixture")).toBe(false);
		expect(InternalUrlRouter.isBuiltin("LOCAL")).toBe(true);
	});

	it("reports only the handler that serves a scheme an earlier source shadows", () => {
		const own = new UrlSchemeTable("Host URI scheme");
		const inherited = new UrlSchemeTable("Host URI scheme");
		own.replace([
			fixture({ backing: "remote", selectors: "none", immutable: true }, { promptDoc: () => "own fixture://" }),
		]);
		inherited.replace([
			fixture(
				{ backing: "remote", selectors: "none", immutable: false, write: { ...fileWrite, via: "handler" } },
				{ write: async () => {}, promptDoc: () => "inherited fixture://", complete: async () => [] },
			),
		]);
		const router = new InternalUrlRouter([own, inherited]);
		const host = {
			skillUriAccess: false,
			ruleCount: 0,
			securityEnabled: false,
			settingsApproval: false,
			outReplies: false,
			subagent: false,
		};

		expect(router.specs().get("fixture")).toBe(router.spec("fixture"));
		expect(router.specs().get("fixture")?.write).toBeUndefined();
		expect(router.writeTier("fixture://rows/1", "x", undefined)).toMatchObject({ policy: "deny" });
		expect(router.describe(host).filter(line => line.includes("fixture://"))).toEqual(["own fixture://"]);
		expect(router.completionSchemes()).not.toContain("fixture");
	});
});

describe("InternalUrlRouter URL shape", () => {
	it("rewrites only single-slash aliases of schemes that declare one", () => {
		const router = InternalUrlRouter.builtins();
		expect(router.normalize("local:/notes.md")).toBe("local://notes.md");
		expect(router.normalize("vault:/Work/a.md")).toBe("vault:/Work/a.md");
	});

	it("strips a filesystem path prefixed onto an aliasing scheme's URL", () => {
		const router = InternalUrlRouter.builtins();
		expect(router.normalize("/home/me/repo/local://notes.md")).toBe("local://notes.md");
		expect(router.normalize("notes/local://a/b.md:10-20")).toBe("local://a/b.md:10-20");
		// The first prefixed scheme wins; a later `local://` is part of the URL's path.
		expect(router.normalize("/repo/local://a/b/local://notes.md")).toBe("local://a/b/local://notes.md");
		// Windows cwd spellings, and the bare session-local root.
		expect(router.normalize("C:\\repo\\local://rules.md")).toBe("local://rules.md");
		expect(router.normalize("C:/repo/local://rules.md")).toBe("local://rules.md");
		expect(router.normalize("/repo/local://")).toBe("local://");
		expect(router.canHandle("/repo/local://")).toBe(true);
		// A single slash after the scheme can be a real `local:` directory; leave it.
		expect(router.normalize("/home/me/repo/local:/notes.md")).toBe("/home/me/repo/local:/notes.md");
		// A prefix that is itself a URL, or a scheme without the alias, is not repaired.
		expect(router.normalize("https://host/local://x")).toBe("https://host/local://x");
		expect(router.normalize("/repo/skill://x")).toBe("/repo/skill://x");
	});

	it("never treats a URL query as a glob, but keeps path globs", () => {
		const router = InternalUrlRouter.builtins();
		for (const url of [
			"vault://W?op=search&q=[x]",
			"vault://W?op=search&q=a/*.md",
			"issue://?search=fix*",
			"issue://owner/repo?state=closed",
			"vault://Work/a.md?op=backlinks",
		]) {
			expect(router.isGlob(url)).toBe(false);
		}
		for (const url of ["local://*.md", "local:/drafts/*.md", "memory://root/skills/?.md", "vault://Work/*.md?op=x"]) {
			expect(router.isGlob(url)).toBe(true);
		}
	});
});

describe("InternalUrlRouter.requireLocal diagnostics", () => {
	it("surfaces the handler's not-found detail for an unknown agent output id", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "router-require-local-"));
		const unregister = registerArtifactsDir(artifactsDir);
		try {
			await Bun.write(path.join(artifactsDir, "reviewer_0.md"), "report\n");
			await expect(InternalUrlRouter.builtins().requireLocal("agent://reviewer_9", "find", {})).rejects.toThrow(
				"Cannot find agent://reviewer_9: Not found: reviewer_9",
			);
		} finally {
			unregister();
			await fs.rm(artifactsDir, { recursive: true, force: true });
		}
	});
});

describe("InternalUrlRouter write approval", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	it("denies writes to read-only schemes at the gate instead of prompting", () => {
		const session: ToolSession = {
			cwd: os.tmpdir(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tool = new WriteTool(session);
		for (const target of ["history://Worker", "skill://docs/SKILL.md"]) {
			expect(resolveApproval(tool, { path: target, content: "x" }, "always-ask")).toMatchObject({
				policy: "deny",
				source: "tool",
			});
		}
		// Declared policies still decide: local:// is session scratch, approved at read tier.
		expect(resolveApproval(tool, { path: "local:/notes.md", content: "x" }, "always-ask").policy).toBe("allow");
		expect(resolveApproval(tool, { path: "notes.md", content: "x" }, "always-ask").policy).toBe("prompt");
	});
});
