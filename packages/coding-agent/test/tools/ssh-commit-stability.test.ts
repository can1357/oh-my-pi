/**
 * Issue #3177: `sshToolRenderer.renderResult` swaps the pending icon/frame
 * state for the SSH glyph + success state when `options.isPartial` flips
 * false. Without the renderer's `provisionalPartialResult: true` opt-out, a
 * long-running SSH command keeps the same partial header bytes for the whole
 * `STABLE_PREFIX_COMMIT_FRAMES` window, the transcript's stable-prefix
 * ratchet promotes them to native scrollback, and the final render strands a
 * pending `⏳ SSH: [host]` header above the final `⇄ SSH: [host]` header
 * (the bug the user reported). Contract: while a partial SSH result is in
 * flight, the block reports commit-unstable so `deriveLiveCommitState` keeps
 * its rows in the live region; once the result settles it is commit-stable
 * again.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@pk-nerdsaver-ai/pi-tui";

const uiStub = { requestRender() {} } as unknown as TUI;

function makeSshComponent() {
	return new ToolExecutionComponent("ssh", { host: "sccpu", command: "uptime" }, {}, undefined, uiStub);
}

function partialResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

describe("ssh tool block commit stability", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports commit-unstable while an SSH result is partial", () => {
		const component = makeSshComponent();
		component.updateResult(partialResult("connecting…"), true);

		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(component.isTranscriptBlockCommitStable()).toBe(false);
	});

	it("flips commit-stable as soon as the SSH result settles", () => {
		const component = makeSshComponent();
		component.updateResult(partialResult("connecting…"), true);
		expect(component.isTranscriptBlockCommitStable()).toBe(false);

		component.updateResult(partialResult("done\n"), false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
	});

	it("does not opt other foreground tools out of partial-result stream commits", () => {
		// Sanity: bash and friends still get the existing `isPartial`
		// commit-stable behaviour — the SSH opt-in must be renderer-scoped.
		const component = new ToolExecutionComponent("bash", { command: "ls" }, {}, undefined, uiStub);
		component.updateResult(partialResult("a\nb\n"), true);

		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
	});
});
