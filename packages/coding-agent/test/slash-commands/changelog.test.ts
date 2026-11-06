import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import {
	CHANGELOG_COMMAND_USAGE,
	CHANGELOG_SUMMARY_MAX_BYTES,
	changelogSummaryMaxBytes,
	getChangelogPath,
	parseChangelog,
	RECENT_CHANGELOG_ENTRY_LIMIT,
	type ChangelogEntry,
} from "@oh-my-pi/pi-coding-agent/utils/changelog";

function versionHeadings(markdown: string): string[] {
	return markdown.match(/^## \[[^\]]+\]/gm) ?? [];
}

function acpRuntime() {
	const chunks: string[] = [];
	const output = vi.fn((text: string) => {
		chunks.push(text);
	});
	// `session: {}` keeps the summary path's `session.model?.contextWindow`
	// lookup on an unset model, exercising the default byte cap.
	const runtime = { output, session: {} } as unknown as SlashCommandRuntime;
	return { chunks, output, runtime };
}

describe("/changelog", () => {
	it("shows the recent default, one release for bare last, and N releases for last N", async () => {
		const all = await parseChangelog(getChangelogPath());
		expect(all.length).toBeGreaterThan(RECENT_CHANGELOG_ENTRY_LIMIT);

		const recent = acpRuntime();
		await executeAcpBuiltinSlashCommand("/changelog", recent.runtime);
		expect(versionHeadings(recent.chunks.join("\n"))).toEqual(
			all
				.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT)
				.map(entry => `## [${entry.major}.${entry.minor}.${entry.patch}]`)
				.reverse(),
		);

		const last = acpRuntime();
		await executeAcpBuiltinSlashCommand("/changelog last", last.runtime);
		expect(versionHeadings(last.chunks.join("\n"))).toEqual([
			`## [${all[0]!.major}.${all[0]!.minor}.${all[0]!.patch}]`,
		]);

		const lastTwo = acpRuntime();
		await executeAcpBuiltinSlashCommand("/changelog last 2", lastTwo.runtime);
		expect(versionHeadings(lastTwo.chunks.join("\n"))).toEqual(
			all
				.slice(0, 2)
				.map(entry => `## [${entry.major}.${entry.minor}.${entry.patch}]`)
				.reverse(),
		);

		const full = acpRuntime();
		await executeAcpBuiltinSlashCommand("/changelog full", full.runtime);
		expect(versionHeadings(full.chunks.join("\n")).length).toBe(all.length);
	});

	it("caps the summary prompt to the session model's context budget", () => {
		expect(changelogSummaryMaxBytes(undefined)).toBe(CHANGELOG_SUMMARY_MAX_BYTES);
		// 8k token window: a third of the window at ~4 bytes/token.
		expect(changelogSummaryMaxBytes(8192)).toBe(Math.floor((8192 / 3) * 4));
		// Narrow windows keep the 4 KiB floor; large windows keep the 64 KiB default.
		expect(changelogSummaryMaxBytes(2048)).toBe(4096);
		expect(changelogSummaryMaxBytes(1_000_000)).toBe(CHANGELOG_SUMMARY_MAX_BYTES);
	});

	it("rejects a zero count and unknown subcommands", async () => {
		for (const text of ["/changelog last 0", "/changelog yesterday"]) {
			const h = acpRuntime();
			await executeAcpBuiltinSlashCommand(text, h.runtime);
			expect(h.chunks.join("\n")).toContain(text.endsWith("0") ? "positive integer" : CHANGELOG_COMMAND_USAGE);
		}
	});

	it("forwards TUI args and clears the editor", async () => {
		const handleChangelogCommand = vi.fn(async () => {});
		const setText = vi.fn();
		const runtime = {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleChangelogCommand,
			} as unknown as InteractiveModeContext,
		};

		expect(await executeBuiltinSlashCommand("/changelog last 3", runtime)).toBe(true);
		expect(handleChangelogCommand).toHaveBeenCalledWith("last 3");
		expect(setText).toHaveBeenCalledWith("");
	});

	it("asks the model to review the recent default releases for bare summary", async () => {
		const all = await parseChangelog(getChangelogPath());
		const h = acpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/changelog summary", h.runtime);
		if (!result || !("prompt" in result) || typeof result.prompt !== "string") {
			throw new Error("expected a prompt result");
		}
		const markdown: string = result.prompt;
		expect(markdown).toContain("the 3 most recent releases");
		// Newest-first: matches both the digest order the template asks for and
		// the truncation direction of the 64 KiB cap (newest survive).
		expect(versionHeadings(markdown)).toEqual(
			all.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT).map(entry => `## [${entry.major}.${entry.minor}.${entry.patch}]`),
		);
		expect(h.chunks).toEqual([]); // nothing echoed: the prompt goes to the model
	});

	it("scopes the review to one release for summary last 1", async () => {
		const all = await parseChangelog(getChangelogPath());
		const h = acpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/changelog summary last 1", h.runtime);
		if (!result || !("prompt" in result) || typeof result.prompt !== "string") {
			throw new Error("expected a prompt result");
		}
		const markdown: string = result.prompt;
		expect(markdown).toContain("the latest release");
		expect(versionHeadings(markdown)).toEqual([`## [${all[0]!.major}.${all[0]!.minor}.${all[0]!.patch}]`]);
	});

	it("keeps the newest releases in the prompt when full summary is truncated", async () => {
		const all = await parseChangelog(getChangelogPath());
		const h = acpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/changelog summary full", h.runtime);
		if (!result || !("prompt" in result) || typeof result.prompt !== "string") {
			throw new Error("expected a prompt result");
		}
		const markdown: string = result.prompt;
		const latestHeading = `## [${all[0]!.major}.${all[0]!.minor}.${all[0]!.patch}]`;
		const oldestHeading = `## [${(all.at(-1) as ChangelogEntry).major}.${(all.at(-1) as ChangelogEntry).minor}.${(all.at(-1) as ChangelogEntry).patch}]`;
		expect(markdown.length).toBeLessThan(CHANGELOG_SUMMARY_MAX_BYTES + 1000);
		// Newest-first: the current release survives every cap; the oldest
		// entries are what gets dropped.
		expect(markdown).toContain(latestHeading);
		expect(markdown).not.toContain(oldestHeading);
	});

	it("rejects an unknown summary range", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/changelog summary bogus", h.runtime);
		expect(h.chunks.join("\n")).toContain(CHANGELOG_COMMAND_USAGE);
	});

	it("submits the summary as the next user prompt in the TUI", async () => {
		const all = await parseChangelog(getChangelogPath());
		const setText = vi.fn();
		const runtime = {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showWarning: vi.fn(),
				showStatus: vi.fn(),
				handleChangelogCommand: vi.fn(async () => {}),
				session: {},
			} as unknown as InteractiveModeContext,
		};
		const result = await executeBuiltinSlashCommand("/changelog summary last 1", runtime);
		if (typeof result !== "string") throw new Error("expected the summary prompt to be submitted");
		expect(result).toContain(`## [${all[0]!.major}.${all[0]!.minor}.${all[0]!.patch}]`);
		expect(setText).toHaveBeenCalledWith("");
	});
});
