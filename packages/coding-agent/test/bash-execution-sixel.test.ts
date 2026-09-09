import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { BashExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/bash-execution";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { sanitizeWithOptionalSixelPassthrough } from "@oh-my-pi/pi-coding-agent/utils/sixel";
import type { TUI } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";

const SIXEL = "\x1bPqabc\x1b\\";
let darkTheme: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	expect(loaded).toBeDefined();
	darkTheme = loaded!;
});

describe("BashExecutionComponent SIXEL sanitization", () => {
	const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(() => {
		setThemeInstance(darkTheme);
	});
	afterEach(() => {
		if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
		if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
	});

	it("preserves SIXEL output when passthrough gates are enabled", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const component = new BashExecutionComponent("echo sixel", ui, false);
		component.appendOutput(SIXEL);
		component.setComplete(0, false);

		expect(component.getOutput()).toContain(SIXEL);
	});

	it("does not truncate long SIXEL payload lines", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const payload = `\x1bPq${"A".repeat(5000)}\x1b\\`;
		const component = new BashExecutionComponent("echo sixel", ui, false);
		component.appendOutput(payload);
		component.setComplete(0, false);

		const output = component.getOutput();
		expect(output).toContain("\x1bPq");
		expect(output).toContain("\x1b\\");
		expect(output).not.toContain("visible columns omitted");
	});

	it("still truncates long non-SIXEL lines", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const longText = "x".repeat(5000);
		const component = new BashExecutionComponent("echo text", ui, false);
		component.appendOutput(longText);
		component.setComplete(0, false);

		const output = component.getOutput();
		expect(output).toContain("visible columns omitted");
		expect(output).not.toContain("\x1bPq");
	});

	it("strips SIXEL control escapes when passthrough gates are disabled", () => {
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;

		// appendOutput receives pre-sanitized chunks from OutputSink.
		// Simulate that: sanitize before passing to the component.
		const sanitized = sanitizeWithOptionalSixelPassthrough(SIXEL, sanitizeText);
		const component = new BashExecutionComponent("test sixel", ui, false);
		component.appendOutput(sanitized);
		component.setComplete(0, false);

		expect(component.getOutput()).not.toContain("\x1bPq");
		expect(component.getOutput()).toBe("");
	});
});

describe("BashExecutionComponent streaming throttle", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(() => {
		setThemeInstance(darkTheme);
	});

	it("caps stored lines during streaming", () => {
		const component = new BashExecutionComponent("test", ui, false);

		// Flood with 500 lines in one chunk (exceeds STREAMING_LINE_CAP of 100)
		const lines = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n");
		component.appendOutput(lines);

		// Internal lines should be capped (we can't read #outputLines directly,
		// but getOutput() returns the joined lines — it should have at most ~100 lines)
		const output = component.getOutput();
		const outputLineCount = output.split("\n").length;
		expect(outputLineCount).toBeLessThanOrEqual(101); // 100 cap + possible partial
		// Should retain the tail, not the head
		expect(output).toContain("line499");
		expect(output).not.toContain("line0\n");
	});

	it("gate drops rapid chunks", () => {
		vi.useFakeTimers();
		try {
			const component = new BashExecutionComponent("test", ui, false);

			// Send 100 chunks rapidly (all in same tick, before the gate fires).
			for (let i = 0; i < 100; i++) {
				component.appendOutput(`chunk${i}\n`);
			}

			const output = component.getOutput();
			expect(output).toContain("chunk0");
			expect(output).not.toContain("chunk99");

			vi.advanceTimersByTime(50);
			component.appendOutput("after_gate\n");
			expect(component.getOutput()).toContain("after_gate");
		} finally {
			vi.useRealTimers();
		}
	});

	it("setComplete replaces streaming output with final output", () => {
		const component = new BashExecutionComponent("test", ui, false);

		// Stream some partial output
		component.appendOutput("streaming_line\n");

		// Complete with different final output
		component.setComplete(0, false, { output: "final_line_1\nfinal_line_2" });

		const output = component.getOutput();
		expect(output).toContain("final_line_1");
		expect(output).toContain("final_line_2");
		// Streaming output is replaced, not appended
		expect(output).not.toContain("streaming_line");
	});
});

describe("BashExecutionComponent expand footer", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(() => {
		setThemeInstance(darkTheme);
	});

	// PREVIEW_LINES is 20: 27 lines leaves 7 hidden in the collapsed preview.
	const makeComponent = () => {
		const component = new BashExecutionComponent("ls", ui, false);
		const lines = Array.from({ length: 27 }, (_, i) => `entry${i}`);
		component.setComplete(0, false, { output: lines.join("\n") });
		return component;
	};

	it("advertises hidden lines while collapsed", () => {
		const rendered = makeComponent().render(120).join("\n");
		expect(rendered).toContain("more lines");
		expect(rendered).toContain("ctrl+o to expand");
	});

	it("drops the hidden-lines footer once expanded", () => {
		const component = makeComponent();
		component.setExpanded(true);
		const rendered = component.render(120).join("\n");
		expect(rendered).not.toContain("more lines");
		expect(rendered).not.toContain("ctrl+o to expand");
		// Every line is now present, including the previously hidden prefix.
		expect(rendered).toContain("entry0");
		expect(rendered).toContain("entry26");
	});

	it("restores the footer when collapsed again", () => {
		const component = makeComponent();
		component.setExpanded(true);
		component.setExpanded(false);
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("more lines");
		expect(rendered).toContain("ctrl+o to expand");
	});
});
