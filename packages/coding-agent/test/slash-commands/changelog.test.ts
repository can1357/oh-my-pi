import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import {
	CHANGELOG_COMMAND_USAGE,
	getChangelogPath,
	parseChangelog,
	RECENT_CHANGELOG_ENTRY_LIMIT,
} from "@oh-my-pi/pi-coding-agent/utils/changelog";

function versionHeadings(markdown: string): string[] {
	return markdown.match(/^## \[[^\]]+\]/gm) ?? [];
}

function acpRuntime() {
	const chunks: string[] = [];
	const output = vi.fn((text: string) => {
		chunks.push(text);
	});
	const runtime = { output } as unknown as SlashCommandRuntime;
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
});
