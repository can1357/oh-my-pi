import { describe, expect, it } from "bun:test";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "../src/slash-commands/builtin-control";
import type { TuiSlashCommandRuntime } from "../src/slash-commands/types";

/**
 * The `/autoprompt` command's own surface: the loop's controller is tested in
 * `composer-prediction-controller.test.ts`, and this file is about the words a person types -
 * the four limits, their defaults and maxima, and the three verbs.
 */
function harness(options: { status?: unknown; stopReturns?: boolean; startThrows?: Error } = {}) {
	const statuses: string[] = [];
	const errors: string[] = [];
	const starts: unknown[] = [];
	let stops = 0;
	const command = BUILTIN_CONTROL_SLASH_COMMANDS.find(spec => spec.name === "autoprompt");
	if (!command?.handleTui) throw new Error("expected /autoprompt to have a TUI handler");
	const run = async (args: string) => {
		const runtime = {
			// the command clears only text it still owns; a detached draft keeps the stub composer out of it
			draftDetached: true,
			ctx: {
				showStatus: (message: string) => statuses.push(message),
				showError: (message: string) => errors.push(message),
				eventController: {
					composerPrediction: {
						startAutomatic: (limits: unknown) => {
							if (options.startThrows) throw options.startThrows;
							starts.push(limits);
						},
						stopAutomatic: () => {
							stops++;
							return options.stopReturns ?? true;
						},
						getAutomaticStatus: () => options.status,
					},
				},
			},
		} as unknown as TuiSlashCommandRuntime;
		await command.handleTui(
			{ name: "autoprompt", args, text: `/autoprompt ${args}`.trim() } as Parameters<NonNullable<typeof command.handleTui>>[0],
			runtime,
		);
		return { statuses, errors, starts, stops };
	};
	return run;
}

describe("ComposerPredictionController / /autoprompt", () => {
	it("reports rather than starting when given no verb: a bare command never begins a billed loop", async () => {
		const out = await harness()("");
		expect(out.starts).toEqual([]);
		expect(out.errors).toEqual([]);
		expect(out.statuses).toEqual(["Auto-prompt is not running."]);
	});

	it("starts with the defaults when `start` is given no limits", async () => {
		const out = await harness()("start");
		expect(out.errors).toEqual([]);
		expect(out.starts).toEqual([{ minutes: 480, tokens: 100_000, dollars: 5, turns: 20 }]);
		expect(out.statuses.join("\n")).toContain("up to 20 follow-ups, 480 min, 100000 tokens");
	});

	it("takes every limit, as --flag value and as --flag=value, and nothing else", async () => {
		const spaced = await harness()("start --minutes 5 --tokens 1000 --dollars 0.5 --turns 2");
		expect(spaced.starts).toEqual([{ minutes: 5, tokens: 1000, dollars: 0.5, turns: 2 }]);
		const joined = await harness()("start --minutes=6 --tokens=2000 --dollars=1.25 --turns=3");
		expect(joined.starts).toEqual([{ minutes: 6, tokens: 2000, dollars: 1.25, turns: 3 }]);
		// flags without a verb are still a verb position: the usage line, not an implicit start
		const bare = await harness()("--turns 1");
		expect(bare.starts).toEqual([]);
		expect(bare.errors.join("\n")).toContain("Usage: /autoprompt start");
	});

	it("refuses an option it does not know, a missing value, a value that is not positive and one past the maximum", async () => {
		const cases: Array<[string, string]> = [
			["start --seeds 4", "Unknown auto-prompt option: --seeds"],
			["start --minutes", "--minutes needs a positive whole number"],
			["start --turns 0", "--turns needs a positive whole number"],
			["start --minutes 1.5", "--minutes needs a positive whole number"],
			["start --dollars -2", "--dollars needs a positive number"],
			["start --turns 1001", "--turns needs a positive whole number no greater than 1000"],
		];
		for (const [args, message] of cases) {
			const out = await harness()(args);
			expect(out.starts).toEqual([]);
			expect(out.errors.join("\n")).toContain(message.slice(0, 30));
		}
	});

	it("takes a fractional spend limit, which is the one limit that is not whole", async () => {
		const out = await harness()("start --dollars 0.75");
		expect(out.errors).toEqual([]);
		expect(out.starts).toEqual([{ minutes: 480, tokens: 100_000, dollars: 0.75, turns: 20 }]);
	});

	it("reports what is running, and says so plainly when nothing is", async () => {
		const idle = await harness()("status");
		expect(idle.statuses).toEqual(["Auto-prompt is not running."]);
		const active = await harness({
			status: {
				turns: 3,
				elapsedMs: 90_000,
				tokens: 1_500,
				dollars: 0.25,
				limits: { turns: 20, minutes: 480, tokens: 100_000, dollars: 5 },
			},
		})("status");
		expect(active.statuses.join("\n")).toContain("Auto-prompt active: 3/20 turns, 1/480 min, 1500/100000 tokens, $0.25/$5.00.");
	});

	it("stops a run, and says when there was none to stop", async () => {
		const stopped = await harness({ stopReturns: true })("stop");
		expect(stopped.stops).toBe(1);
		expect(stopped.statuses).toEqual(["Auto-prompt stopped."]);
		const nothing = await harness({ stopReturns: false })("stop");
		expect(nothing.statuses).toEqual(["Auto-prompt is not running."]);
	});

	it("surfaces why the loop refused to start instead of claiming it did", async () => {
		const out = await harness({
			startThrows: new Error("Auto-prompt is available only in the main session"),
		})("start");
		expect(out.errors).toEqual(["Auto-prompt is available only in the main session"]);
		expect(out.statuses).toEqual([]);
	});
});
