import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as capability from "@oh-my-pi/pi-coding-agent/capability";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { resetActiveRulesForTests, setActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import type { CapabilityResult } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { resetActiveSkillsForTests, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import {
	applyInternalUrlCompletion,
	extractInternalUrlContext,
	getInternalUrlSuggestions,
	isInternalUrlPrefix,
} from "@oh-my-pi/pi-coding-agent/modes/internal-url-autocomplete";
import { PromptActionAutocompleteProvider } from "@oh-my-pi/pi-coding-agent/modes/prompt-action-autocomplete";

function skill(name: string, description = ""): Skill {
	return { name, description, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}`, source: "test" };
}

function rule(name: string, description?: string): Rule {
	return {
		name,
		path: `/rules/${name}.md`,
		content: `# ${name}`,
		...(description ? { description } : {}),
		_source: { provider: "test", providerName: "Test", path: `/rules/${name}.md`, level: "project" },
	};
}

describe("internal-url-autocomplete", () => {
	beforeEach(() => {
		setActiveSkills([skill("humanizer", "Remove AI tells"), skill("react", "React UI"), skill("tla", "TLA+ specs")]);
		setActiveRules([rule("python", "robomp rules"), rule("style")]);
	});

	afterEach(() => {
		resetActiveSkillsForTests();
		resetActiveRulesForTests();
		vi.restoreAllMocks();
	});

	describe("extractInternalUrlContext", () => {
		it("detects a bare scheme with the full :// typed", () => {
			expect(extractInternalUrlContext("local://")).toEqual({ scheme: "local", query: "", token: "local://" });
		});

		it("treats a single slash as the same in-progress token (preserving exact text)", () => {
			expect(extractInternalUrlContext("local:/")).toEqual({ scheme: "local", query: "", token: "local:/" });
		});

		it("captures the host/path query and the boundary-delimited token", () => {
			expect(extractInternalUrlContext("look at skill://hum")).toEqual({
				scheme: "skill",
				query: "hum",
				token: "skill://hum",
			});
		});

		it("keeps nested paths in the query", () => {
			expect(extractInternalUrlContext("local://dir/file.json")).toMatchObject({
				scheme: "local",
				query: "dir/file.json",
			});
		});

		it("ignores schemes with no completion handler (http/https)", () => {
			expect(extractInternalUrlContext("https://example.com/x")).toBeNull();
		});

		it("does not fire on a bare colon in prose", () => {
			expect(extractInternalUrlContext("note: hello")).toBeNull();
			expect(extractInternalUrlContext("TODO: ship it")).toBeNull();
		});

		it("requires at least one slash after the colon", () => {
			expect(extractInternalUrlContext("local:")).toBeNull();
		});
	});

	describe("getInternalUrlSuggestions", () => {
		it("lists every skill for a bare skill:// and prefixes the scheme", async () => {
			const result = await getInternalUrlSuggestions("skill://");
			expect(result).not.toBeNull();
			expect(result!.prefix).toBe("skill://");
			expect(result!.items.map(i => i.value).sort()).toEqual(["skill://humanizer", "skill://react", "skill://tla"]);
		});

		it("fuzzy-filters candidates by the typed query", async () => {
			const result = await getInternalUrlSuggestions("skill://hum");
			expect(result!.items.map(i => i.value)).toEqual(["skill://humanizer"]);
		});

		it("ranks an exact/prefix match ahead of a scattered subsequence", async () => {
			// "ra" is a prefix of "react" (score 80) and a subsequence of "humanizer" (lower).
			const result = await getInternalUrlSuggestions("skill://ra");
			expect(result!.items[0]!.value).toBe("skill://react");
		});

		it("returns null when no candidate matches", async () => {
			expect(await getInternalUrlSuggestions("skill://zzzzz")).toBeNull();
		});

		it("returns null for schemes without a completion handler", async () => {
			expect(await getInternalUrlSuggestions("issue://")).toBeNull();
		});

		it("percent-encodes a configured ssh host with reserved characters while matching a raw query", async () => {
			const result: CapabilityResult<SSHHost> = {
				items: [
					{
						name: "alice@prod",
						host: "10.0.0.9",
						_source: { provider: "ssh-json", providerName: "SSH Config", path: "/x", level: "user" },
					},
				],
				all: [],
				warnings: [],
				providers: [],
			} as unknown as CapabilityResult<SSHHost>;
			vi.spyOn(capability, "loadCapability").mockResolvedValue(result as CapabilityResult<unknown>);
			const suggestions = await getInternalUrlSuggestions(
				"ssh://alice@pr",
				"/tmp/proj",
				new AbortController().signal,
			);
			// Inserted value is percent-encoded so the URL stays well-formed; the label
			// keeps the human-readable name and the raw query still fuzzy-matches.
			expect(suggestions?.items[0]).toMatchObject({ value: "ssh://alice%40prod", label: "alice@prod" });
		});
	});

	describe("router.complete dispatch", () => {
		it("returns candidates for a completion-capable scheme", async () => {
			const candidates = await InternalUrlRouter.instance().complete("rule", "");
			expect(candidates?.map(c => c.value).sort()).toEqual(["python", "style"]);
		});

		it("returns null for a known scheme that opted out of completion", async () => {
			expect(await InternalUrlRouter.instance().complete("issue", "")).toBeNull();
			expect(await InternalUrlRouter.instance().complete("pr", "")).toBeNull();
		});

		it("returns null for an unknown scheme", async () => {
			expect(await InternalUrlRouter.instance().complete("bogus", "")).toBeNull();
		});

		it("exposes the completion-capable schemes", () => {
			const schemes = InternalUrlRouter.instance().completionSchemes().sort();
			expect(schemes).toEqual([
				"agent",
				"artifact",
				"history",
				"local",
				"memory",
				"omp",
				"rule",
				"security",
				"skill",
				"ssh",
			]);
		});
	});

	describe("applyInternalUrlCompletion", () => {
		it("replaces the token in place and appends a trailing space", () => {
			const line = "look at skill://hum";
			const result = applyInternalUrlCompletion(
				[line],
				0,
				line.length,
				{ value: "skill://humanizer", label: "humanizer" },
				"skill://hum",
			);
			expect(result.lines[0]).toBe("look at skill://humanizer ");
			expect(result.cursorCol).toBe("look at skill://humanizer ".length);
		});

		it("preserves text after the cursor", () => {
			const line = "skill://hum and more";
			const cursorCol = "skill://hum".length;
			const result = applyInternalUrlCompletion(
				[line],
				0,
				cursorCol,
				{ value: "skill://humanizer", label: "humanizer" },
				"skill://hum",
			);
			expect(result.lines[0]).toBe("skill://humanizer  and more");
		});
	});

	describe("isInternalUrlPrefix", () => {
		it("recognizes a completion prefix token", () => {
			expect(isInternalUrlPrefix("skill://hum")).toBe(true);
			expect(isInternalUrlPrefix("local://")).toBe(true);
		});

		it("rejects non-url prefixes", () => {
			expect(isInternalUrlPrefix("@src/foo")).toBe(false);
			expect(isInternalUrlPrefix("/model")).toBe(false);
		});
	});

	describe("PromptActionAutocompleteProvider integration", () => {
		it("returns url suggestions before falling back to file/emoji completion", async () => {
			const provider = new PromptActionAutocompleteProvider([], process.cwd(), []);
			const line = "look at skill://hum";
			const result = await provider.getSuggestions([line], 0, line.length);
			expect(result?.prefix).toBe("skill://hum");
			expect(result?.items.map(i => i.value)).toEqual(["skill://humanizer"]);
		});

		it("applies the selected url candidate in place", async () => {
			const provider = new PromptActionAutocompleteProvider([], process.cwd(), []);
			const line = "look at skill://hum";
			const result = await provider.getSuggestions([line], 0, line.length);
			const applied = provider.applyCompletion([line], 0, line.length, result!.items[0]!, result!.prefix);
			expect(applied.lines[0]).toBe("look at skill://humanizer ");
		});
	});
});
