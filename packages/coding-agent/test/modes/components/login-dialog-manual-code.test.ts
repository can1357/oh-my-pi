import { beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { LoginDialogComponent } from "../../../src/modes/components/login-dialog";
import { initTheme } from "../../../src/modes/theme/theme";

/** Minimal TUI stub — the dialog only calls requestRender/setFocus. */
function makeDialog(): LoginDialogComponent {
	const tui = { requestRender() {}, setFocus() {} } as unknown as TUI;
	return new LoginDialogComponent(tui, "openai-codex", () => {});
}

describe("LoginDialogComponent manual code input", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("captures a pasted fallback redirect URL and resolves on submit", async () => {
		// Regression for #5339: paste-code providers (Codex) route the fallback
		// URL through the focused dialog. Without a mounted input, the paste is
		// dropped and login never completes.
		const dialog = makeDialog();
		dialog.showProgress("Waiting for callback");

		const pending = dialog.showManualInput("Paste the authorization code:");
		expect(dialog.render(80).join("\n")).toContain("Paste the authorization code");

		const url = "http://localhost:1455/auth/callback?code=THECODE&state=abc";
		dialog.pasteText(url);
		dialog.handleInput("\r");

		expect(await pending).toBe(url);
	});

	it("rejects the pending input when another callback path wins", async () => {
		const dialog = makeDialog();
		const settled = new AbortController();
		const error = new Error("native callback received");
		const pending = dialog.showManualInput("Paste the authorization code:", settled.signal);

		settled.abort(error);

		await expect(pending).rejects.toBe(error);
	});

	it("reuses the mounted input across re-prompts instead of stacking duplicates", async () => {
		// The OAuth callback loop re-invokes onManualCodeInput after an invalid
		// paste; the second prompt must not append a duplicate input/hint block.
		const dialog = makeDialog();
		dialog.showProgress("Waiting for callback");

		const first = dialog.showManualInput("Paste the code:");
		dialog.handleInput("garbage");
		dialog.handleInput("\r");
		expect(await first).toBe("garbage");

		const second = dialog.showManualInput("Paste the code:");
		const rendered = dialog.render(80).join("\n");
		expect(rendered.split("Paste the code:").length - 1).toBe(1);
		// A stale value from the first attempt must not leak into the retry.
		expect(rendered).not.toContain("garbage");

		const url = "http://localhost:1455/auth/callback?code=OK&state=abc";
		dialog.pasteText(url);
		dialog.handleInput("\r");
		expect(await second).toBe(url);
	});
});
