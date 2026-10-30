import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { resolveToolSearchScope } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

// `ast_edit` resolves internal URLs through a filesystem bounded by its write
// tier, and `glob`/`ast_grep`/`find` bound theirs by the approved tier, so a
// scope filesystem below exec must reject ssh:// BEFORE
// `InternalUrlRouter.resolve` — which is the point that opens the outbound SSH
// connection. The security contract these tests defend: a read/write-tier
// filesystem never calls `resolve` (never connects) for an ssh:// path.
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
});
