import Handlebars from "handlebars";
import clarifyTemplate from "./prompts/clarify.md" with { type: "text" };
import compressHumanTemplate from "./prompts/compress-research-human.md" with { type: "text" };
import compressSystemTemplate from "./prompts/compress-research-system.md" with { type: "text" };
import finalReportTemplate from "./prompts/final-report.md" with { type: "text" };
import leadResearcherTemplate from "./prompts/lead-researcher.md" with { type: "text" };
import researchBriefTemplate from "./prompts/research-brief.md" with { type: "text" };
import researcherSystemTemplate from "./prompts/researcher-system.md" with { type: "text" };
import summarizeWebpageTemplate from "./prompts/summarize-webpage.md" with { type: "text" };

// Prompt content includes markdown and XML-ish tags, so escaping must stay off.
function compile(template: string): Handlebars.TemplateDelegate {
	return Handlebars.compile(template, { noEscape: true });
}

const clarify = compile(clarifyTemplate);
const compressHuman = compile(compressHumanTemplate);
const compressSystem = compile(compressSystemTemplate);
const finalReport = compile(finalReportTemplate);
const leadResearcher = compile(leadResearcherTemplate);
const researchBrief = compile(researchBriefTemplate);
const researcherSystem = compile(researcherSystemTemplate);
const summarizeWebpage = compile(summarizeWebpageTemplate);

export const prompts = {
	clarifyWithUser: (vars: { messages: string; date: string }): string => clarify(vars),
	researchBrief: (vars: { messages: string; date: string }): string => researchBrief(vars),
	leadResearcher: (vars: {
		date: string;
		max_concurrent_research_units: number;
		max_researcher_iterations: number;
	}): string => leadResearcher(vars),
	researcherSystem: (vars: { date: string; extra_tool_prompt: string; search_tool_name: string }): string =>
		researcherSystem(vars),
	compressResearchSystem: (vars: { date: string }): string => compressSystem(vars),
	compressResearchHuman: (): string => compressHuman({}),
	finalReport: (vars: { research_brief: string; messages: string; findings: string; date: string }): string =>
		finalReport(vars),
	summarizeWebpage: (vars: { webpage_content: string; date: string }): string => summarizeWebpage(vars),
};
