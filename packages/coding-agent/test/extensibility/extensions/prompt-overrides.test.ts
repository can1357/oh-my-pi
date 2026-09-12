import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import {
	clearAllPromptOverrides,
	clearPromptOverridesFor,
	hasPromptOverride,
	registerPromptOverrides,
	resolvePromptSource,
} from "../../../src/extensibility/extensions/prompt-overrides";
import { loadExtensions } from "../../../src/extensibility/extensions/loader";

// Content-free prompt-override mechanism contract: the extension is a
// synthetic fixture written to a temp dir and loaded through the real
// extension loader, so the factory -> pi.registerPromptOverrides wiring and
// the registry semantics are exercised exactly as a real localization plugin
// would exercise them. Content (translations) lives in the plugin repo.

const EN_BUILTIN = "EN_BASELINE_BUILTIN";
const FULL_TEMPLATE = "OVERRIDE_FULL_TEXT {{name}}";
const TRANSFORM_MARKER = "OVERRIDE_TRANSFORM_SUFFIX";

const FIXTURE_FACTORY = `
export default function (pi: {
	registerPromptOverrides: (r: {
		overrides: Array<{ id: string; full?: string; transform?: (s: string) => string }>;
	}) => void;
}): void {
	pi.registerPromptOverrides({
		overrides: [
			{ id: "system", full: ${JSON.stringify(FULL_TEMPLATE)} },
			{ id: "agent.task", transform: (src) => src + " " + ${JSON.stringify(TRANSFORM_MARKER)} },
		],
	});
}
`;

describe("prompt overrides (mechanism)", () => {
	let tmpExt: string;
	let extPath: string;

	beforeEach(() => {
		clearAllPromptOverrides();
		tmpExt = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-override-test-"));
		extPath = path.join(tmpExt, "index.ts");
		fs.writeFileSync(extPath, FIXTURE_FACTORY);
	});

	afterEach(() => {
		clearAllPromptOverrides();
		fs.rmSync(tmpExt, { recursive: true, force: true });
	});

	it("falls back to the built-in template when nothing is registered", () => {
		expect(hasPromptOverride("system")).toBe(false);
		expect(resolvePromptSource("system", EN_BUILTIN)).toBe(EN_BUILTIN);
		const rendered = prompt.render(resolvePromptSource("system", EN_BUILTIN + " {{n}}"), { n: 7 });
		expect(rendered).toBe(EN_BUILTIN + " 7");
	});

	it("real loader: extension factory registers all override ids without errors", async () => {
		const result = await loadExtensions([extPath], tmpExt);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(path.basename(result.extensions[0].path)).toBe("index.ts");
		expect(hasPromptOverride("system")).toBe(true);
		expect(hasPromptOverride("agent.task")).toBe(true);
	});

	it("full override replaces the built-in and renders Handlebars variables", async () => {
		await loadExtensions([extPath], tmpExt);
		const rendered = prompt.render(resolvePromptSource("system", EN_BUILTIN), { name: "Ada" });
		expect(rendered).toContain("OVERRIDE_FULL_TEXT");
		expect(rendered).toContain("Ada");
		expect(rendered).not.toContain(EN_BUILTIN);
	});

	it("transform override is applied on top of the built-in text", async () => {
		await loadExtensions([extPath], tmpExt);
		const resolved = resolvePromptSource("agent.task", EN_BUILTIN);
		expect(resolved).toContain(EN_BUILTIN);
		expect(resolved).toContain(TRANSFORM_MARKER);
	});

	it("full wins over transform when both are registered for one id", () => {
		registerPromptOverrides(
			{ overrides: [{ id: "system", full: "FULL_WINS", transform: () => "TRANSFORM_WINS" }] },
			extPath,
		);
		expect(resolvePromptSource("system", EN_BUILTIN)).toBe("FULL_WINS");
	});

	it("a throwing transform degrades to the built-in template", () => {
		registerPromptOverrides(
			{
				overrides: [
					{ id: "system", transform: () => { throw new Error("transform blew up"); } },
				],
			},
			extPath,
		);
		expect(resolvePromptSource("system", EN_BUILTIN)).toBe(EN_BUILTIN);
	});

	it("clearPromptOverridesFor removes only that extension's contributions", async () => {
		const result = await loadExtensions([extPath], tmpExt);
		expect(hasPromptOverride("system")).toBe(true);
		expect(hasPromptOverride("agent.task")).toBe(true);

		clearPromptOverridesFor(result.extensions[0].path);

		expect(hasPromptOverride("system")).toBe(false);
		expect(hasPromptOverride("agent.task")).toBe(false);
		expect(resolvePromptSource("system", EN_BUILTIN)).toBe(EN_BUILTIN);
	});
});
