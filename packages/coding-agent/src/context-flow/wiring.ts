import type { WiringStatus } from "./types";

/** Static wiring truth — updated by CONTEXT_FLOW_AUDIT.md */
export const RESEARCH_STACK_WIRING: Readonly<Record<string, WiringStatus>> = {
	"omp.root": "hot_path",
	"omp.user": "hot_path",
	"omp.rlm": "conditional",
	"omp.rlm.spill": "conditional",
	"omp.rlm.search": "conditional",
	"omp.rlm.groq_codec": "conditional",
	"omp.tokenomics": "shadow",
	"typesafe.jev": "conditional",
	"omp.auto_thinking": "conditional",
	"omp.compaction": "hot_path",
	"omp.task": "hot_path",
	nanojev: "present_not_wired",
	openjev: "present_not_wired",
	z0int: "present_not_wired",
	kerdoios: "experiment_only",
	"fly.classifier": "present_not_wired",
	"mushroom.classifier": "present_not_wired",
};
