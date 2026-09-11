import { describe, expect, test } from "bun:test";
import { editDescription } from "@oh-my-pi/pi-natives";
import { resolveEditToolDescription } from "@oh-my-pi/pi-coding-agent/edit";

describe("resolveEditToolDescription", () => {
	test("renders the compact prompt for models whose catalog policy selects it", () => {
		const compact = resolveEditToolDescription("hashline", { editPromptVariant: "compact" });
		expect(compact.startsWith("Hashline patches.")).toBe(true);
		expect(compact).not.toContain("<anti-patterns>");
		// Density changes, language does not: every PUT/CUT/REM/MV op stays
		// expressible in the compact rendering.
		expect(compact).toContain("PUT N.=M:");
		expect(compact).toContain("CUT N.=M");
		expect(compact).toContain("`REM`");
		expect(compact).toContain("MV DEST");
		expect(compact.length).toBeLessThan(editDescription("hashline").length);
	});

	test("keeps the full prompt for models without the compact policy", () => {
		const full = resolveEditToolDescription("hashline", undefined);
		expect(full).toContain("<anti-patterns>");
		expect(full).toContain("Decorator/doc-comment separate block");
		// Explicit "full" and an unset policy render identically.
		expect(resolveEditToolDescription("hashline", { editPromptVariant: "full" })).toBe(full);
	});

	test("falls back to the full prompt for modes without a compact variant", () => {
		const fallback = resolveEditToolDescription("replace", { editPromptVariant: "compact" });
		const full = resolveEditToolDescription("replace", undefined);
		expect(fallback).toBe(full);
		expect(fallback).toContain(editDescription("replace").split("\n")[0]);
	});
});
