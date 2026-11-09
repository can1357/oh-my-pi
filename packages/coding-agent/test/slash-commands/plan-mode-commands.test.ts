import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildTuiBuiltinSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";

async function suggested(provider: CombinedAutocompleteProvider, query: string): Promise<string[]> {
	const result = await provider.getSuggestions([query], 0, query.length);
	return result?.items.map(item => item.value) ?? [];
}

describe("plan-mode-only slash commands", () => {
	it("list /exec-model and /plan-review only while plan mode is on", async () => {
		const ctx = { planModeEnabled: false, goalModeEnabled: false, settings: Settings.isolated() };
		const runtime = { ctx } as unknown as TuiSlashCommandRuntime;
		const provider = new CombinedAutocompleteProvider(
			buildTuiBuiltinSlashCommands(runtime).filter(command =>
				["plan", "plan-review", "exec-model"].includes(command.name),
			),
			process.cwd(),
		);

		expect(await suggested(provider, "/exec-model")).not.toContain("exec-model");
		expect(await suggested(provider, "/plan-review")).not.toContain("plan-review");
		// /plan itself is the way in, so it never hides.
		expect(await suggested(provider, "/plan")).toContain("plan");

		ctx.planModeEnabled = true;
		expect(await suggested(provider, "/exec-model")).toContain("exec-model");
		expect(await suggested(provider, "/plan-review")).toContain("plan-review");
	});

	it("keeps bare /exec-model a complete invocation: no subcommand popup until a prefix is typed", async () => {
		const runtime = { ctx: { planModeEnabled: true } } as unknown as TuiSlashCommandRuntime;
		const command = buildTuiBuiltinSlashCommands(runtime).find(entry => entry.name === "exec-model");

		expect(await command?.getArgumentCompletions?.("")).toBeNull();
		expect((await command?.getArgumentCompletions?.("cl"))?.map(item => item.value)).toEqual(["clear "]);
	});
});
