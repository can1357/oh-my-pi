import { prompt } from "@oh-my-pi/pi-utils";
import analysisPrompt from "./prompts/analysis.md" with { type: "text" };
import fastPrompt from "./prompts/fast.md" with { type: "text" };
import mapPrompt from "./prompts/map.md" with { type: "text" };
import reducePrompt from "./prompts/reduce.md" with { type: "text" };
import summaryPrompt from "./prompts/summary.md" with { type: "text" };
import summaryRewritePrompt from "./prompts/summary-rewrite.md" with { type: "text" };

/** Prompt families used by llm-git's standard commit algorithm. */
export type ConventionalPromptFamily = "analysis" | "fast" | "map" | "reduce" | "summary" | "summary-rewrite";

const PROMPT_BY_FAMILY: Record<ConventionalPromptFamily, string> = {
	analysis: analysisPrompt,
	fast: fastPrompt,
	map: mapPrompt,
	reduce: reducePrompt,
	summary: summaryPrompt,
	"summary-rewrite": summaryRewritePrompt,
};

const USER_SEPARATOR = "<!-- USER -->";

/** Render a static system section and Handlebars-templated user section. */
export function renderConventionalPrompt(
	family: ConventionalPromptFamily,
	context: prompt.TemplateContext = {},
): { system: string; user: string } {
	const template = PROMPT_BY_FAMILY[family];
	const separator = template.indexOf(USER_SEPARATOR);
	if (separator < 0) return { system: "", user: prompt.render(template, context).trim() };
	const system = template.slice(0, separator).trim();
	const userTemplate = template.slice(separator + USER_SEPARATOR.length);
	return { system, user: prompt.render(userTemplate, context).trim() };
}
