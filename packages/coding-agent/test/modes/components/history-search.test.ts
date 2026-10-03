import { beforeAll, describe, expect, it } from "bun:test";
import { HistorySearchComponent, type HistorySearchScope } from "@oh-my-pi/pi-tui/overlays/history-search";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

function source(label: string, prompts: string[]): HistorySearchScope {
	const entries = prompts.map(prompt => ({ prompt, created_at: 1 }));
	return {
		label,
		getRecent: limit => entries.slice(0, limit),
		search: (query, limit) => entries.filter(entry => entry.prompt.includes(query)).slice(0, limit),
	};
}

function render(component: HistorySearchComponent): string {
	return Bun.stripANSI(component.render(80).join("\n"));
}

describe("HistorySearchComponent", () => {
	it("cycles bound sources in both directions while retaining the query and resetting selection", () => {
		const selected: string[] = [];
		const component = new HistorySearchComponent(
			[
				source("conversation", ["deploy session first", "deploy session second", "unrelated"]),
				source("folder", ["deploy folder first", "deploy folder second"]),
				source("everywhere", ["deploy global"]),
			],
			prompt => selected.push(prompt),
			() => {},
		);
		for (const char of "deploy") component.handleInput(char);
		expect(render(component)).not.toContain("unrelated");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		component.handleInput("\t");
		expect(render(component)).toContain("deploy folder first");
		expect(render(component)).not.toContain("deploy session");
		component.handleInput("\r");
		component.handleInput("\x1b[Z");
		component.handleInput("\r");
		component.handleInput("\x1b[Z");
		component.handleInput("\r");
		expect(selected).toEqual([
			"deploy session second",
			"deploy folder first",
			"deploy session first",
			"deploy global",
		]);
	});

	it("clears stale selectable results on read failure and retries on the next input", () => {
		let fail = false;
		const selected: string[] = [];
		const backing = source("folder", ["deploy release"]);
		const component = new HistorySearchComponent(
			[
				{
					...backing,
					search: (query, limit) => {
						if (fail) throw new Error("read failed");
						return backing.search(query, limit);
					},
				},
			],
			prompt => selected.push(prompt),
			() => {},
		);
		fail = true;
		component.handleInput("d");
		component.handleInput("\r");
		expect(selected).toEqual([]);
		expect(render(component)).not.toContain("deploy release");
		fail = false;
		component.handleInput("e");
		component.handleInput("\r");
		expect(selected).toEqual(["deploy release"]);
	});

	it("moves the query cursor with Left/Right instead of cycling the scope", () => {
		const component = new HistorySearchComponent(
			[source("folder", ["abc folder"]), source("conversation", ["abc conversation"])],
			() => {},
			() => {},
		);

		// Left/Right belong to the query field, not the scope ring: `handleTabSwitchKey` would
		// consume them and cycle the scope, so the insertion below would land at the end of the
		// query and the title would move off the initial scope.
		for (const char of "abc") component.handleInput(char);
		expect(component.title).toBe("History (folder)");
		expect(render(component)).toContain("abc folder");

		component.handleInput("\x1b[D"); // Left
		component.handleInput("z");

		expect(component.title).toBe("History (folder)");
		expect(render(component)).not.toContain("abc folder");

		// Right must move the cursor back toward the end: typing then appends ("abzcy"),
		// where an unhandled Right would leave the cursor before "c" and yield "abzyc".
		component.handleInput("\x1b[C"); // Right
		component.handleInput("y");
		expect(component.title).toBe("History (folder)");
		expect(render(component)).toContain("abzcy");
	});
});
