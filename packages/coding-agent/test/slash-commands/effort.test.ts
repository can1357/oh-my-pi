import { describe, expect, it, vi } from "bun:test";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

interface EffortModel {
	provider: string;
	id: string;
	reasoning: boolean;
}

const REASONING_MODEL: EffortModel = { provider: "anthropic", id: "claude-opus-4-5", reasoning: true };
const FULL_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

function effortSession(
	options: {
		model?: EffortModel | undefined;
		thinkingLevel?: string | undefined;
		configured?: string | undefined;
		supported?: string[];
		clamp?: (level: string) => string | undefined;
	} = {},
) {
	const model = "model" in options ? options.model : REASONING_MODEL;
	let thinkingLevel: string | undefined = options.thinkingLevel ?? "high";
	let configured: string | undefined = options.configured ?? thinkingLevel;
	const setThinkingLevel = vi.fn((level: string) => {
		if (level === "auto") {
			configured = "auto";
			thinkingLevel = "high";
			return;
		}
		configured = level;
		thinkingLevel = options.clamp ? options.clamp(level) : level;
	});
	return {
		model,
		setThinkingLevel,
		getThinkingLevel: () => thinkingLevel,
		session: {
			model,
			get thinkingLevel() {
				return thinkingLevel;
			},
			configuredThinkingLevel: () => configured,
			setThinkingLevel,
			getAvailableThinkingLevels: () => options.supported ?? FULL_LADDER,
		},
	};
}

function acpHarness(options?: Parameters<typeof effortSession>[0]) {
	const harness = effortSession(options);
	const output = vi.fn();
	return { ...harness, output, runtime: { session: harness.session, output } };
}

async function runAcp(text: string, runtime: unknown) {
	return Reflect.apply(executeAcpBuiltinSlashCommand, undefined, [text, runtime]);
}

describe("/effort slash command", () => {
	it("reports the current level and supported efforts with no argument", async () => {
		const h = acpHarness();

		expect(await runAcp("/effort", h.runtime)).toEqual({ consumed: true });
		expect(h.output).toHaveBeenCalledWith(
			"Thinking level: high. Supported efforts: minimal, low, medium, high, xhigh, max.",
		);
		expect(h.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("reports auto mode with its currently resolved level", async () => {
		const h = acpHarness({ configured: "auto", thinkingLevel: "medium" });

		await runAcp("/effort", h.runtime);

		expect(h.output).toHaveBeenCalledWith(
			"Thinking level: auto (currently medium). Supported efforts: minimal, low, medium, high, xhigh, max.",
		);
	});

	it("sets the level without changing the model", async () => {
		const h = acpHarness();

		expect(await runAcp("/effort low", h.runtime)).toEqual({ consumed: true });
		expect(h.setThinkingLevel).toHaveBeenCalledWith("low");
		expect(h.model).toBe(REASONING_MODEL);
		expect(h.getThinkingLevel()).toBe("low");
		expect(h.output).toHaveBeenCalledWith("Thinking level set to low on anthropic/claude-opus-4-5.");
	});

	it("accepts the same abbreviations as the :level suffix", async () => {
		const h = acpHarness();

		await runAcp("/effort med", h.runtime);

		expect(h.setThinkingLevel).toHaveBeenCalledWith("medium");
		expect(h.output).toHaveBeenCalledWith("Thinking level set to medium on anthropic/claude-opus-4-5.");
	});

	it("reports the clamped level when the model does not support the request", async () => {
		const h = acpHarness({
			supported: ["minimal", "low", "medium", "high"],
			clamp: level => (level === "xhigh" ? "high" : level),
		});

		await runAcp("/effort xhigh", h.runtime);

		expect(h.setThinkingLevel).toHaveBeenCalledWith("xhigh");
		expect(h.output).toHaveBeenCalledWith(
			"Thinking level set to high (xhigh is not supported by anthropic/claude-opus-4-5; clamped to the closest supported effort).",
		);
	});

	it("rejects unknown levels without touching session state", async () => {
		const h = acpHarness();

		await runAcp("/effort turbo", h.runtime);

		expect(h.setThinkingLevel).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(
			"Unknown thinking level: turbo. Usage: /effort [off|auto|minimal|low|medium|high|xhigh|max]",
		);
	});

	it("is friendly when the active model does not support reasoning", async () => {
		const h = acpHarness({
			model: { provider: "openai", id: "gpt-4o-mini", reasoning: false },
			supported: [],
		});

		await runAcp("/effort high", h.runtime);

		expect(h.setThinkingLevel).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(
			"The current model (openai/gpt-4o-mini) does not support reasoning; thinking level unchanged.",
		);
	});

	it("reports non-reasoning models on bare invocation", async () => {
		const h = acpHarness({
			model: { provider: "openai", id: "gpt-4o-mini", reasoning: false },
			supported: [],
		});

		await runAcp("/effort", h.runtime);

		expect(h.output).toHaveBeenCalledWith("The current model (openai/gpt-4o-mini) does not support reasoning.");
	});

	it("handles a missing model like /model", async () => {
		const h = acpHarness({ model: undefined });

		await runAcp("/effort", h.runtime);

		expect(h.output).toHaveBeenCalledWith("No model is currently selected.");
		expect(h.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("routes through the TUI dispatcher via the shared text handler", async () => {
		const h = effortSession();
		const showStatus = vi.fn();
		const setText = vi.fn();
		const ctx = {
			session: h.session,
			sessionManager: { getCwd: () => "/tmp" },
			settings: {},
			editor: { setText },
			showStatus,
			refreshSlashCommandState: vi.fn(),
		} as unknown as InteractiveModeContext;

		const handled = await executeBuiltinSlashCommand("/effort low", { ctx });

		expect(handled).toBe(true);
		expect(h.setThinkingLevel).toHaveBeenCalledWith("low");
		expect(showStatus).toHaveBeenCalledWith("Thinking level set to low on anthropic/claude-opus-4-5.");
		expect(setText).toHaveBeenCalledWith("");
	});
});
