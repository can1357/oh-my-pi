import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { SessionInfoOverlay } from "@oh-my-pi/pi-tui/overlays/session-info-overlay";
import { applyHyperlinkSetting, fileUriForTerminal } from "@oh-my-pi/pi-tui/render/hyperlink";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const OSC8_OPEN = /\x1b\]8;[^;]*;([^\x1b\x07]+)(?:\x1b\\|\x07)/g;
const cx = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

function isNode(child: NativeChild | undefined): child is NativeNode {
	return child !== undefined && typeof child === "object" && "k" in child && typeof child.k === "string";
}

function findAll(root: NativeNode, pred: (n: NativeNode) => boolean): NativeNode[] {
	const found: NativeNode[] = [];
	const visit = (n: NativeNode): void => {
		if (pred(n)) found.push(n);
		for (const child of n.c ?? []) if (isNode(child)) visit(child);
	};
	visit(root);
	return found;
}

/** The report `/session` hands to its overlay for a session stored at `sessionFile`. */
async function sessionReport(sessionFile: string): Promise<string> {
	const showSessionInfo = vi.fn();
	const settings = Settings.isolated();
	const ctx = {
		settings,
		session: {
			settings,
			getSessionStats: () => ({
				sessionFile,
				sessionId: "s-1",
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: 2,
				editRejections: 0,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
				premiumRequests: 0,
			}),
			sessionManager: { getEntries: () => [], getUsageStatistics: () => ({ premiumRequests: 0 }) },
			model: undefined,
			getContextUsage: () => undefined,
			getPromptCacheStatus: () => undefined,
		},
		showSessionInfo,
	} as unknown as InteractiveModeContext;
	await new CommandController(ctx).handleSessionCommand();
	return showSessionInfo.mock.calls[0]![0] as string;
}

describe("/session File row", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => applyHyperlinkSetting("auto"));

	it("links the transcript file in the terminal sheet and the native one", async () => {
		applyHyperlinkSetting("always");
		for (const sessionFile of [
			"/home/alice/.omp/agent/sessions/demo/2026-11-02_s-1.jsonl",
			"C:\\Users\\alice\\.omp\\agent\\sessions\\demo\\2026-11-02_s-1.jsonl",
		]) {
			const target = fileUriForTerminal(sessionFile, undefined, TERMINAL.id)!;
			const overlay = new SessionInfoOverlay({ terminal: { rows: 40 } }, await sessionReport(sessionFile), () => {});

			const rows = overlay.render(140).join("\n");
			expect([...rows.matchAll(OSC8_OPEN)].map(match => match[1])).toContain(target);
			const [, fileCopy] = findAll(overlay.describe(cx), n => n.p?.role === "omp.info.copy");
			expect(JSON.stringify(fileCopy)).toContain(`"href":"${target}"`);
		}
	});
});
