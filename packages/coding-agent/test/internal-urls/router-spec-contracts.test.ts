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
} from "@oh-my-pi/pi-coding-agent/internal-urls";
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

describe("InternalUrlRouter.register invariants", () => {
	const locate = async (): Promise<string | null> => "/tmp/fixture";

	it("refuses a write() hook without spec.write", () => {
		const handler = fixture({ backing: "virtual", selectors: "lines", immutable: false }, { write: async () => {} });
		expect(() => InternalUrlRouter.instance().register(handler)).toThrow(
			"fixture:// handler has write() but spec.write.via is absent",
		);
	});

	it("refuses a write() hook when tools own the writes", () => {
		const handler = fixture(
			{ backing: "file", selectors: "lines", immutable: false, write: fileWrite },
			{ locate, write: async () => {} },
		);
		expect(() => InternalUrlRouter.instance().register(handler)).toThrow(
			'fixture:// handler has write() but spec.write.via is "file"',
		);
	});

	it("refuses spec.write.via handler without a write() hook", () => {
		const handler = fixture({
			backing: "virtual",
			selectors: "lines",
			immutable: false,
			write: { ...fileWrite, via: "handler" },
		});
		expect(() => InternalUrlRouter.instance().register(handler)).toThrow(
			'fixture:// spec.write.via is "handler" but the handler lacks write()',
		);
	});

	it("refuses file writes without a file backing, a locate() hook, or with an immutable spec", () => {
		const router = InternalUrlRouter.instance();
		const virtualBacked = fixture(
			{ backing: "virtual", selectors: "lines", immutable: false, write: fileWrite },
			{ locate },
		);
		const unlocatable = fixture({ backing: "file", selectors: "lines", immutable: false, write: fileWrite });
		const immutable = fixture({ backing: "file", selectors: "lines", immutable: true, write: fileWrite }, { locate });
		expect(() => router.register(virtualBacked)).toThrow('requires backing "file", not "virtual"');
		expect(() => router.register(unlocatable)).toThrow("requires a locate() hook");
		expect(() => router.register(immutable)).toThrow("contradicts spec.immutable");
		expect(router.canHandle("fixture://x")).toBe(false);
	});

	it("refuses a sandbox scope sandboxRoots could not locate", () => {
		const handler = fixture(
			{ backing: "file", selectors: "lines", immutable: false, write: { ...fileWrite, scope: "sandbox" } },
			{ locate },
		);
		expect(() => InternalUrlRouter.instance().register(handler)).toThrow("requires spec.linkable and a locateSync()");
	});

	it("registers a mutable file-backed scheme whose tools own the writes", () => {
		const router = InternalUrlRouter.instance();
		router.register(fixture({ backing: "file", selectors: "lines", immutable: false, write: fileWrite }, { locate }));
		expect(router.canHandle("fixture://x")).toBe(true);
		expect(router.fileWritable("fixture://x")).toBe(true);
		expect(router.isBuiltin("fixture")).toBe(false);
		expect(router.isBuiltin("LOCAL")).toBe(true);
	});
});

describe("InternalUrlRouter URL shape", () => {
	it("rewrites only single-slash aliases of schemes that declare one", () => {
		const router = InternalUrlRouter.instance();
		expect(router.normalize("local:/notes.md")).toBe("local://notes.md");
		expect(router.normalize("vault:/Work/a.md")).toBe("vault:/Work/a.md");
		expect(router.normalize("artifact:/3")).toBe("artifact:/3");
	});

	it("never treats a URL query as a glob, but keeps path globs", () => {
		const router = InternalUrlRouter.instance();
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

	it("rejects a glob in an id authority with a scheme-specific error", async () => {
		const router = InternalUrlRouter.instance();
		for (const scheme of ["skill", "agent", "artifact", "rule"]) {
			await expect(router.locateGlob(`${scheme}://*/SKILL.md`)).rejects.toThrow(
				`Globs are not supported in ${scheme}:// ids`,
			);
		}
	});
});

describe("InternalUrlRouter.requireLocal diagnostics", () => {
	it("surfaces the handler's not-found detail for an unknown artifact id", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "router-require-local-"));
		try {
			await Bun.write(path.join(artifactsDir, "4.bash.log"), "log\n");
			const context = {
				localProtocolOptions: { getArtifactsDir: () => artifactsDir, getSessionId: () => "s" },
			};
			await expect(InternalUrlRouter.instance().requireLocal("artifact://9", "find", context)).rejects.toThrow(
				"Cannot find artifact://9: Artifact 9 not found. Available: 4",
			);
		} finally {
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
		for (const target of ["artifact://3", "history://Worker", "skill://docs/SKILL.md"]) {
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
