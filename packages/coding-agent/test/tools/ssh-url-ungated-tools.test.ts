import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { resolveToolSearchScope } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

// Minimal ToolSession stub (ssh-url-approval.test.ts shape). The ssh:// guard
// fires before any session/SSH access, so no real cwd/fs is needed.
function createTestToolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

// `glob`, `ast_grep`, and `ast_edit` resolve internal URLs through a filesystem
// bounded by their read/write tier and do NOT share the exec-tier approval
// `read`/`grep`/`write` got for ssh://, so they must reject it BEFORE
// `InternalUrlRouter.resolve` — which is the point that opens the outbound SSH
// connection. The security contract these tests defend: a read/write-tier tool
// never calls `resolve` (never connects) for an ssh:// path.
describe("ssh:// is rejected before any connection in read/write-tier tools", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolveToolSearchScope (ast_grep + ast_edit) throws on ssh:// without resolving", async () => {
		// Reject if resolve is ever reached, so a guard regression fails loudly
		// instead of attempting a real connection.
		const spy = vi
			.spyOn(InternalUrlRouter.instance(), "resolve")
			.mockRejectedValue(new Error("resolve must not run for ssh://"));
		await expect(
			resolveToolSearchScope({
				rawPaths: ["ssh://h/x"],
				cwd: os.tmpdir(),
				internalUrlAction: "search",
				filesystem: new InternalUrlFilesystem({ context: {}, tier: "read" }),
			}),
		).rejects.toThrow("Cannot search ssh://h/x: ssh:// access needs exec approval");
		await expect(
			resolveToolSearchScope({
				rawPaths: ["ssh://h/x"],
				cwd: os.tmpdir(),
				internalUrlAction: "rewrite",
				filesystem: new InternalUrlFilesystem({ context: {}, tier: "write" }),
				fileWritableOnly: true,
			}),
		).rejects.toThrow("Cannot rewrite ssh://h/x: ssh:// URLs are not editable files");
		expect(spy).not.toHaveBeenCalled();
	});

	it("glob throws on ssh:// without resolving", async () => {
		const spy = vi
			.spyOn(InternalUrlRouter.instance(), "resolve")
			.mockRejectedValue(new Error("resolve must not run for ssh://"));
		const tool = new GlobTool(createTestToolSession(os.tmpdir()));
		await expect(tool.execute("f", { path: "ssh://h/x" })).rejects.toThrow(/ssh:\/\//);
		expect(spy).not.toHaveBeenCalled();
	});
});
