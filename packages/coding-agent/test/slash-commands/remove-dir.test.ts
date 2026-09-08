import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as lsp from "@oh-my-pi/pi-coding-agent/lsp";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("/remove-dir dispatch (ACP)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refreshes the prompt and confirms removal when language-server teardown fails", async () => {
		const tempDir = TempDir.createSync("@omp-remove-dir-lsp-teardown-");
		try {
			const extra = path.join(tempDir.path(), "extra");
			await Bun.write(path.join(extra, ".keep"), "");
			const sessionManager = SessionManager.inMemory(tempDir.path());
			await sessionManager.addWorkspaceDirectory(extra);
			const refreshBaseSystemPrompt = vi.fn(async () => {});
			const output = vi.fn();
			const runtime = {
				session: {
					isStreaming: false,
					getLspClientOwner: () => lsp.createLspClientOwner(),
					refreshBaseSystemPrompt,
				},
				sessionManager,
				cwd: tempDir.path(),
				output,
			} as unknown as SlashCommandRuntime;
			vi.spyOn(lsp, "releaseRemovedWorkspaceRoots").mockRejectedValue(
				new Error("Failed to stop LSP server(s) with superseded configuration: extra-lsp"),
			);

			const result = await executeAcpBuiltinSlashCommand(`/remove-dir ${extra}`, runtime);

			expect(result).toEqual({ consumed: true });
			expect(sessionManager.getAdditionalDirectories()).toEqual([]);
			expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
			const confirmation = String(output.mock.calls[0]?.[0] ?? "");
			expect(confirmation).toContain(`Removed ${extra}.`);
			expect(confirmation).toContain(`${tempDir.path()} (working directory)`);
			expect(confirmation).not.toContain(`  ${extra}`);
		} finally {
			tempDir.removeSync();
		}
	});
});
