import { describe, expect, it } from "bun:test";
import { isReplyWrite } from "@oh-my-pi/pi-tui/chat/reply-write";
import { Settings } from "../../src/config/settings";
import { InternalUrlRouter } from "../../src/internal-urls";
import type { SchemeHost } from "../../src/internal-urls/types";
import type { ToolSession } from "../../src/tools";

const host: SchemeHost = {
	skillUriAccess: false,
	ruleCount: 0,
	securityEnabled: false,
	settingsApproval: false,
	outReplies: false,
};

/** A caller session; `enabled` undefined leaves `out.enabled` unset. */
function session(
	enabled: boolean | undefined,
	options: { taskDepth?: number; tuiTranscript?: boolean } = {},
): ToolSession {
	const settings = Settings.isolated(enabled === undefined ? {} : { "out.enabled": enabled });
	return {
		settings,
		taskDepth: options.taskDepth ?? 0,
		tuiTranscript: options.tuiTranscript,
	} as unknown as ToolSession;
}

describe("out://", () => {
	it("is advertised only where replies reach the user", () => {
		const router = InternalUrlRouter.instance();
		const advertised = (outReplies: boolean) =>
			router.describe({ ...host, outReplies }).some(line => line.startsWith("`out://`"));
		expect(advertised(true)).toBe(true);
		expect(advertised(false)).toBe(false);
	});

	it("follows the TUI transcript unless `out.enabled` is set, and never lets subagents reply", () => {
		const router = InternalUrlRouter.instance();
		const tier = (caller: ToolSession) => router.writeTier("out://", "hi", caller);
		const off = { policy: "deny", reason: expect.stringContaining("out.enabled") };

		// Unset: on in the interactive TUI, off in print/RPC/ACP.
		expect(tier(session(undefined, { tuiTranscript: true }))).toBe("read");
		expect(tier(session(undefined, { tuiTranscript: false }))).toMatchObject(off);
		// Explicitly configured: applies in every mode.
		expect(tier(session(true, { tuiTranscript: false }))).toBe("read");
		expect(tier(session(false, { tuiTranscript: true }))).toMatchObject(off);
		// A subagent's replies would never reach the user, even when enabled explicitly.
		expect(tier(session(true, { taskDepth: 1 }))).toMatchObject({
			policy: "deny",
			reason: expect.stringContaining("Subagents"),
		});
	});

	it("accepts Markdown as an elidable result and rejects disabled, blank, and oversize replies", async () => {
		const router = InternalUrlRouter.instance();
		const accepted = await router.write("out://", "## Status\n\nhalfway", { session: session(true) });
		expect(accepted).toMatchObject({ content: [{ type: "text", text: "Shown to the user." }], useless: true });

		await expect(router.write("out://", "hi", { session: session(false) })).rejects.toThrow("out.enabled");
		await expect(router.write("out://", " \n ", { session: session(true) })).rejects.toThrow("non-empty");
		await expect(router.write("out://", "x".repeat(64 * 1024 + 1), { session: session(true) })).rejects.toThrow(
			"64 KiB",
		);
		await expect(router.resolve("out://")).rejects.toThrow("write-only");
	});

	it("routes only writes to reply URLs as replies, holding a path that could still become one", () => {
		expect(isReplyWrite("write", { path: "out://", content: "x" })).toBe(true);
		expect(isReplyWrite("write", { path: "OUT://notes" })).toBe(true);
		// Streamed prefixes of `out://` cannot be decided yet.
		expect(isReplyWrite("write", { path: "ou" })).toBeUndefined();
		expect(isReplyWrite("write", { path: "out:/" })).toBeUndefined();
		expect(isReplyWrite("write", {})).toBeUndefined();
		// Paths that can no longer become a reply URL are cards right away.
		expect(isReplyWrite("write", { path: "output.md", content: "x" })).toBe(false);
		expect(isReplyWrite("write", { path: "src/out.ts" })).toBe(false);
		expect(isReplyWrite("write", { path: "local://out.md" })).toBe(false);
		expect(isReplyWrite("edit", { path: "out://" })).toBe(false);
	});
});
