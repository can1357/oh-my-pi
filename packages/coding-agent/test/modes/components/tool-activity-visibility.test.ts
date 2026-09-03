import { beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { TodoReminderComponent } from "@oh-my-pi/pi-coding-agent/modes/components/todo-reminder";
import { ToolActivityContainer } from "@oh-my-pi/pi-coding-agent/modes/components/tool-activity";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { TtsrNotificationComponent } from "@oh-my-pi/pi-coding-agent/modes/components/ttsr-notification";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Text } from "@oh-my-pi/pi-tui";

const darkTheme = await getThemeByName("dark");

describe("tool activity visibility", () => {
	beforeEach(() => {
		if (!darkTheme) throw new Error("Failed to load dark theme");
		setThemeInstance(darkTheme);
	});

	it("applies visibility to mounted and subsequently added activity blocks", () => {
		const rule: Rule = {
			name: "ts-no-tiny-functions",
			path: "/rules/ts-no-tiny-functions.md",
			content: "Inline tiny wrappers.",
			_source: {
				provider: "test",
				providerName: "Test",
				path: "/rules/ts-no-tiny-functions.md",
				level: "project",
			},
		};
		const transcript = new TranscriptContainer();
		transcript.addChild(new TtsrNotificationComponent([rule]));
		transcript.addChild(new TodoReminderComponent([{ content: "finish the task", status: "in_progress" }], 1, 3));
		transcript.addChild(new ToolActivityContainer(new Text("tool warning", 1, 0)));

		const visible = stripVTControlCharacters(transcript.render(120).join("\n"));
		expect(visible).toContain("ts-no-tiny-functions");
		expect(visible).toContain("finish the task");
		expect(visible).toContain("tool warning");

		transcript.setToolActivityVisible(false);
		expect(stripVTControlCharacters(transcript.render(120).join("\n"))).toBe("");
		transcript.addChild(new ToolActivityContainer(new Text("late activity", 1, 0)));
		expect(stripVTControlCharacters(transcript.render(120).join("\n"))).toBe("");

		transcript.setToolActivityVisible(true);
		const restored = stripVTControlCharacters(transcript.render(120).join("\n"));
		expect(restored).toContain("ts-no-tiny-functions");
		expect(restored).toContain("finish the task");
		expect(restored).toContain("tool warning");
		expect(restored).toContain("late activity");
	});

	it("forwards Ctrl+O expansion to wrapped expandable components", () => {
		// The transcript expansion traversal only visits top-level children;
		// without forwarding, a wrapped renderer freezes at insertion-time state.
		const states: boolean[] = [];
		class ExpandableText extends Text {
			setExpanded(expanded: boolean): void {
				states.push(expanded);
			}
		}
		const wrapper = new ToolActivityContainer(new ExpandableText("activity", 1, 0));
		wrapper.setExpanded(true);
		wrapper.setExpanded(false);
		expect(states).toEqual([true, false]);
	});
});
