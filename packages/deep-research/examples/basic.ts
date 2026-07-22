/**
 * Minimal deep-research CLI.
 *
 * Usage:
 *   TAVILY_API_KEY=... OPENAI_API_KEY=... bun packages/deep-research/examples/basic.ts "your research question"
 *
 * Models default to the open_deep_research defaults (gpt-4.1 family) and can be
 * overridden with env vars, e.g. RESEARCH_MODEL=anthropic:claude-sonnet-4.
 */
import { type DeepResearchEvent, runDeepResearch } from "../src/index";

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
	console.error('Usage: bun examples/basic.ts "your research question"');
	process.exit(1);
}

function logEvent(event: DeepResearchEvent): void {
	switch (event.type) {
		case "research_brief":
			console.error(`\n=== Research brief ===\n${event.brief}\n`);
			break;
		case "researcher_start":
			console.error(`→ researcher started: ${event.topic.slice(0, 100)}`);
			break;
		case "researcher_complete":
			console.error(`✓ researcher done (${event.compressedLength} chars)`);
			break;
		case "supervisor_iteration":
			console.error(`· supervisor iteration ${event.iteration}/${event.maxIterations}`);
			break;
		case "final_report_start":
			console.error("\n=== Writing final report ===\n");
			break;
		default:
			break;
	}
}

const result = await runDeepResearch(question, {
	researchModel: Bun.env.RESEARCH_MODEL ?? "openai:gpt-4.1",
	summarizationModel: Bun.env.SUMMARIZATION_MODEL ?? "openai:gpt-4.1-mini",
	compressionModel: Bun.env.COMPRESSION_MODEL ?? "openai:gpt-4.1",
	finalReportModel: Bun.env.FINAL_REPORT_MODEL ?? "openai:gpt-4.1",
	onEvent: logEvent,
});

if (result.status === "clarification_needed") {
	console.log(`Clarification needed: ${result.clarificationQuestion}`);
} else {
	console.log(result.finalReport);
	console.error(`\n(${result.usage.totalTokens} tokens, $${result.usage.cost.toFixed(4)})`);
}
