import { afterEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import {
	buildExtractionPrompt,
	extractFacts,
	extractFactsSafe,
	heuristicExtractFacts,
	parseFacts,
	parseExtractedFactCategories,
} from "@oh-my-pi/pi-mnemopi/core/extraction";
import { getExtractionStats, resetExtractionStats } from "@oh-my-pi/pi-mnemopi/core/extraction/diagnostics";
import {
	CallableLlmBackend,
	resetHostLlmBackendForTests,
	setHostLlmBackend,
} from "@oh-my-pi/pi-mnemopi/core/llm-backends";
import {
	type MnemopiLlmCompletionTask,
	type ResolvedMnemopiRuntimeOptions,
	withMnemopiRuntimeOptions,
} from "@oh-my-pi/pi-mnemopi/core/runtime-options";

const OLD_ENV = { ...process.env };
function restoreEnv(): void {
	for (const key in process.env) {
		if (!(key in OLD_ENV)) delete process.env[key];
	}
	for (const key in OLD_ENV) {
		const value = OLD_ENV[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	restoreEnv();
	resetHostLlmBackendForTests();
	resetExtractionStats();
});

describe("structured extraction", () => {
	it("builds prompts and parses JSON and legacy facts", () => {
		const prompt = buildExtractionPrompt("I love coffee");
		expect(prompt).toContain("I love coffee");
		expect(prompt.toLowerCase()).toContain("extract");

		expect(parseFacts('{"facts":["The user likes coffee"],"preferences":["The user prefers tea"]}')).toEqual([
			"The user likes coffee",
			"The user prefers tea",
		]);
		expect(parseFacts("1. The user loves coffee\n- The user hates mornings")).toEqual([
			"The user loves coffee",
			"The user hates mornings",
		]);
		expect(parseFacts("NO_FACTS")).toEqual([]);
	});

	it("unwraps category-specific object facts and drops unrecognized objects", () => {
		const modelJson = JSON.stringify({
			facts: [{ fact: "The user prefers tabs over spaces" }, { nested: {} }, "The user likes concise replies."],
			instructions: [{ instruction: "Always include verification details" }],
			preferences: [{ preference: "Prefers dark mode" }],
			timelines: [
				{ date: "2026-08-01", description: "release" },
				{ subject: "release", predicate: "on", object: "2026-08-01" },
			],
		});

		expect(parseFacts(modelJson)).toEqual([
			"The user prefers tabs over spaces",
			"The user likes concise replies",
			"Always include verification details",
			"Prefers dark mode",
			"release 2026-08-01",
		]);
	});

	it("treats a valid empty structured extraction as no facts", () => {
		expect(parseFacts('{"facts": [], "instructions": [], "preferences": [], "timelines": [], "kg": []}')).toEqual([]);
		expect(
			parseFacts('```json\n{"facts": [], "instructions": [], "preferences": [], "timelines": [], "kg": []}\n```'),
		).toEqual([]);
	});


	it("does not promote chatter, arbitrary lines, or broken JSON into facts", () => {
		expect(parseFacts("Selam Echo\nThank you very much\nTamam, teşekkür ederim")).toEqual([]);
		expect(parseFacts("This response contains no persistent information.\nNo durable memories to extract.")).toEqual([]);
		expect(parseFacts('{"facts": ["Teşekkür ederim", "The user prefers tabs"')).toEqual(["The user prefers tabs"]);
		expect(parseFacts("- Thank you very much\n- The user prefers tabs")).toEqual(["The user prefers tabs"]);
		expect(parseFacts('{"facts":["Selam Echo","Thank you very much"],"preferences":[]}')).toEqual([]);
		expect(parseFacts('{"facts":[{"text":"The user prefers tabs","kind":"world"}, {"text":"unfinished')).toEqual(["The user prefers tabs"]);
		expect(parseFacts('{"facts":[{"text":"unfinished')).toEqual([]);
		expect(parseFacts('{"facts":[broken "The user prefers tabs"]}')).toEqual([]);
	});

	it("retains assertions containing no-facts phrases while ignoring whole-line empty markers", () => {
		expect(parseFacts("- The user has no memories of the incident\n- The database has no facts stored")).toEqual([
			"The user has no memories of the incident",
			"The database has no facts stored",
		]);
		expect(parseFacts("No memories.\n- NO_FACTS\nNothing to remember.\nThere are no durable facts to extract.")).toEqual([]);
	});

	it("keeps Turkish declarative facts and scheduled events in legacy line output", () => {
		expect(parseFacts("Gabi İstanbul'da oturur.\nToplantı yarın saat 15:00'te.\nKullanıcı geliştiricidir.\nSelam Echo")).toEqual([
			"Gabi İstanbul'da oturur",
			"Toplantı yarın saat 15:00'te",
			"Kullanıcı geliştiricidir",
		]);
	});

	it("preserves semantic provenance while normalizing structured fact text", () => {
		const extracted = parseExtractedFactCategories(JSON.stringify({
			facts: [
				{ text: "The user prefers tabs.", kind: "world" },
				{ text: "The agent fixed the parser!", kind: "experience" },
				{ text: "Thank you very much", kind: "world" },
			],
			preferences: [{ text: "Koyu tema tercih ediyor.", kind: "world" }],
		}));
		expect(extracted.facts).toEqual([
			{ text: "The user prefers tabs", kind: "world" },
			{ text: "The agent fixed the parser", kind: "experience" },
		]);
		expect(extracted.preferences).toEqual([{ text: "Koyu tema tercih ediyor", kind: "world" }]);
		expect(parseFacts('{"facts":[{"text":"The agent fixed the parser","kind":"experience"}]}')).toEqual([
			"The agent fixed the parser",
		]);
	});

	it("keeps coincident normalized texts typed independently across items and categories", () => {
		const extracted = parseExtractedFactCategories(JSON.stringify({
			facts: [
				{ text: "The parser uses tabs.", kind: "world" },
				{ text: "The parser uses tabs!", kind: "experience" },
			],
			timelines: [{ text: "The parser uses tabs", kind: "world" }],
		}));
		expect(extracted.facts).toEqual([
			{ text: "The parser uses tabs", kind: "world" },
			{ text: "The parser uses tabs", kind: "experience" },
		]);
		expect(extracted.timelines).toEqual([{ text: "The parser uses tabs", kind: "world" }]);
	});
	it("uses deterministic heuristic extraction when no LLM is configured", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "false";
		const facts = await extractFactsSafe("My name is Ada. I work at Example Corp and I prefer dark mode.");
		expect(facts).toContain("The user's name is Ada");
		expect(facts).toContain("The user works at Example Corp");
		expect(facts).toContain("The user prefers dark mode");

		const stats = getExtractionStats();
		expect(stats.totals.successes).toBe(1);
		expect(stats.by_tier.local.successes).toBe(1);
	});

	it("skips the model and heuristic extraction for content-free greetings", async () => {
		expect(await extractFacts("Selam Echo!")).toEqual([]);
		expect(await extractFacts("[role: user]\nSelam Echo!\n[user:end]")).toEqual([]);
		expect(await extractFacts("Okay, thank you very much.")).toEqual([]);
		expect(heuristicExtractFacts("I am fine, thank you.")).toEqual([]);
		expect(getExtractionStats().totals.calls).toBe(0);
	});

	it("returns empty without recording for empty input", async () => {
		expect(await extractFacts("   ")).toEqual([]);
		expect(getExtractionStats().totals.calls).toBe(0);
	});

	it("routes enabled host LLM extraction before remote and keeps temperature zero", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_ENABLED = "true";
		process.env.MNEMOPI_LLM_BASE_URL = "http://remote.invalid/v1";
		let capturedTemperature = -1;
		setHostLlmBackend(
			new CallableLlmBackend("fake", (_prompt, opts) => {
				capturedTemperature = opts?.temperature ?? -1;
				return "- Alex uses Neovim.\n- Alex dislikes VSCode.";
			}),
		);

		const facts = await extractFacts("Alex said they prefer Neovim and dislike VSCode.");
		expect(facts).toEqual(["Alex uses Neovim", "Alex dislikes VSCode"]);
		expect(capturedTemperature).toBe(0);
		expect(getExtractionStats().by_tier.host.successes).toBe(1);
	});

	it("strips reasoning wrappers from remote extraction so facts are not reasoning prose", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_ENABLED = "false";
		process.env.MNEMOPI_LLM_BASE_URL = "http://reasoning.invalid/v1";
		const content =
			'<think>\nThe user is providing information in English. Let me analyze what qualifies:\n- candidate fact\n</think>\n{"facts":["My preferred shell is zsh"],"instructions":[],"preferences":[],"timelines":[],"kg":[]}';
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const facts = await extractFacts("I use zsh.", { fetch: fetchMock });
		expect(facts).toEqual(["My preferred shell is zsh"]);
		expect(getExtractionStats().by_tier.remote.successes).toBe(1);
	});

	it("prefers a configured completion with the extraction-prompt override at temperature zero", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		let capturedPrompt = "";
		let capturedTemperature = -1;
		let capturedTask: MnemopiLlmCompletionTask | undefined;
		const resolved: ResolvedMnemopiRuntimeOptions = {
			llm: {
				enabled: true,
				extractionPrompt: "ONLY-LINES for: {text}\nItems:",
				complete: (prompt, opts) => {
					capturedPrompt = prompt;
					capturedTemperature = opts?.temperature ?? -1;
					capturedTask = opts?.task;
					return "Sam works at Globex\nSam prefers dark mode";
				},
			},
		};

		const facts = await withMnemopiRuntimeOptions(resolved, () =>
			extractFacts("Sam works at Globex and prefers dark mode."),
		);

		expect(facts).toEqual(["Sam works at Globex", "Sam prefers dark mode"]);
		expect(capturedPrompt).toContain("ONLY-LINES for: Sam works at Globex and prefers dark mode.");
		expect(capturedTemperature).toBe(0);
		expect(capturedTask).toEqual({
			kind: "memory-extraction",
			input: "Sam works at Globex and prefers dark mode.",
		});
		expect(getExtractionStats().by_tier.host.successes).toBe(1);
	});

	it("extracts simple facts with the standalone heuristic helper", () => {
		expect(heuristicExtractFacts("I live in Berlin and I use TypeScript.")).toEqual([
			"The user lives in Berlin",
			"The user uses TypeScript",
		]);
	});

	it("captures `Instruction:` facts only when a subject precedes always/never", () => {
		// Subject-led imperatives are still captured.
		expect(heuristicExtractFacts("I never use semicolons and you always wrap lines at 100.")).toEqual([
			"Instruction: never use semicolons",
			"Instruction: always wrap lines at 100",
		]);
	});

	it("ignores subjectless always/never sentences (issue #3372)", () => {
		// Pre-fix this would have produced `Instruction: never activates` and
		// `Instruction: never populates …` from assistant narrative prose.
		const transcript =
			"[role: assistant]\nso reorder never activates and the panel never populates (because pointer events fire before the drop handler binds).\n[assistant:end]";
		const facts = heuristicExtractFacts(transcript);
		expect(facts.some(f => f.startsWith("Instruction:"))).toBe(false);
	});
});
