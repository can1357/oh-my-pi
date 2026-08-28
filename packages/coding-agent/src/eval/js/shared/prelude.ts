import javascriptPrelude from "./prelude.txt" with { type: "text" };
import llmQueryTemplate from "../../../prompts/llm_query.md" with { type: "text" };

// The llm_query delegated-prompt shape lives in llm_query.md (never build
// prompts in code — AGENTS.md). The template is embedded into the prelude
// source exactly once, at build/load time; the kernel interpolates
// {{instructions}}/{{snippet}} per call over that string, so there is no host
// round-trip. The .md's trailing newline (the repo's on-disk convention) is
// stripped so the rendered prompt stays byte-identical to the previous inline
// construction: `<instructions>\n\n<snippet>`.
const LLM_QUERY_TEMPLATE = llmQueryTemplate.replace(/\r?\n$/, "");

export const JAVASCRIPT_PRELUDE_SOURCE =
	`const __omp_llm_query_template__ = ${JSON.stringify(LLM_QUERY_TEMPLATE)};\n\n${javascriptPrelude}`;
