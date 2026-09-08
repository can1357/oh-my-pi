import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type EditMode, type EditModeSessionLike, resolveEditMode } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";

const originalEditVariant = Bun.env.PI_EDIT_VARIANT;
const originalStrictEditMode = Bun.env.PI_STRICT_EDIT_MODE;

function restoreEnv(): void {
	if (originalEditVariant === undefined) {
		delete Bun.env.PI_EDIT_VARIANT;
	} else {
		Bun.env.PI_EDIT_VARIANT = originalEditVariant;
	}
	if (originalStrictEditMode === undefined) {
		delete Bun.env.PI_STRICT_EDIT_MODE;
	} else {
		Bun.env.PI_STRICT_EDIT_MODE = originalStrictEditMode;
	}
}

function createSession(args: {
	activeModel?: string;
	modelVariant?: EditMode | null;
	settingsMode?: EditMode;
}): EditModeSessionLike {
	return {
		getActiveModelString: () => args.activeModel,
		settings: {
			get: () => args.settingsMode ?? "hashline",
			getEditVariantForModel: () => args.modelVariant ?? null,
		},
	};
}

describe("resolveEditMode", () => {
	beforeEach(() => {
		delete Bun.env.PI_EDIT_VARIANT;
		delete Bun.env.PI_STRICT_EDIT_MODE;
	});

	afterEach(() => {
		restoreEnv();
	});

	test("falls back from hashline to replace for Kimi models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe("replace");
	});

	test("falls back from hashline to replace for MiMo models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "xiaomi/MiMo-V2.5-Pro" }))).toBe("replace");
	});

	test("falls back from hashline to replace for DeepSeek models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "tensormesh/deepseek-ai/DeepSeek-V4-Flash" }))).toBe(
			"replace",
		);
		expect(resolveEditMode(createSession({ activeModel: "deepseek/deepseek-chat" }))).toBe("replace");
		expect(resolveEditMode(createSession({ activeModel: "deepseek/deepseek-reasoner" }))).toBe("replace");
	});

	test("falls back from hashline to replace for Step 3.7 Flash models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "kilo/stepfun/step-3.7-flash:free" }))).toBe("replace");
	});

	test("does not exclude non-Kimi Moonshot models", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "moonshot/moonshot-v1-128k" }))).toBe("hashline");
	});

	test("keeps explicit model variants ahead of the Kimi fallback", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(
			resolveEditMode(
				createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct", modelVariant: "hashline" }),
			),
		).toBe("hashline");
	});

	test("keeps PI_EDIT_VARIANT ahead of the Kimi fallback", () => {
		Bun.env.PI_EDIT_VARIANT = "hashline";

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe(
			"hashline",
		);
	});

	test("only falls back when the resolved mode is hashline", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(
			resolveEditMode(
				createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct", settingsMode: "apply_patch" }),
			),
		).toBe("apply_patch");
	});

	test("keeps strict edit mode ahead of the Kimi fallback", () => {
		delete Bun.env.PI_EDIT_VARIANT;
		Bun.env.PI_STRICT_EDIT_MODE = "1";

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe(
			"hashline",
		);
	});
});
