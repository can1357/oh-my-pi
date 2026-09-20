/**
 * Natural dogfood tasks for rlm.workerMode=auto — mix of repo files and synthetic corpora.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type DogfoodTaskKind = "simple" | "causal" | "dense_log" | "contradiction" | "repo_scan";

export interface DogfoodTask {
	id: string;
	kind: DogfoodTaskKind;
	question: string;
	patterns: string[];
	repoRelPath?: string;
	buildCorpus?: () => string;
	selectPolicy?: { maxMatches?: number; contextChars?: number; maxTotalBytes?: number };
	expectArm?: "C" | "D";
}

const PKG = path.resolve(import.meta.dir, "../../..");

function readRepo(rel: string): string {
	return fs.readFileSync(path.join(PKG, rel), "utf8");
}

export const RLM_AUTO_DOGFOOD_TASKS: DogfoodTask[] = [
	{
		id: "simple_pool_limit",
		kind: "simple",
		expectArm: "C",
		question: "What is the checkout pool_limit under peak load?",
		patterns: ["pool_limit"],
		buildCorpus: () => {
			const pad = `${".".repeat(4_000)}\n`;
			return pad + "metric: checkout pool_limit=50 under peak load\n" + pad;
		},
		selectPolicy: { maxMatches: 1, contextChars: 96, maxTotalBytes: 900 },
	},
	{
		id: "causal_timeout_cascade",
		kind: "causal",
		expectArm: "D",
		question: "What is the likely first causal condition before downstream DB errors?",
		patterns: ["active_connections", "pool_limit", "timeout cascade"],
		buildCorpus: () => {
			const prefix = `${"x".repeat(8_000)}\n`;
			const mid = "line 500: requests begin timing out only after active_connections reaches pool_limit\n";
			const midPad = `${"y".repeat(6_000)}\n`;
			const late = "line 910: downstream DB errors appear after timeout cascade\n";
			return prefix + mid + midPad + late + `${"z".repeat(8_000)}`;
		},
	},
	{
		id: "dense_checkout_log",
		kind: "dense_log",
		expectArm: "D",
		question: "From the error log excerpt, what timeout preceded checkout failure?",
		patterns: ["ERROR", "checkout", "timeout"],
		buildCorpus: () => {
			const lines = [
				"INFO session start",
				"WARN retry checkout attempt=2",
				"ERROR checkout timeout after 30s pool exhausted",
				"ERROR downstream latency spike",
			];
			return `${"l".repeat(12_000)}\n${lines.join("\n")}\n${"m".repeat(12_000)}`;
		},
	},
	{
		id: "contradict_pool_limits",
		kind: "contradiction",
		expectArm: "D",
		question: "What is the effective connection pool limit under load?",
		patterns: ["max_connections", "pool_limit"],
		buildCorpus: () => {
			const a = `${"a".repeat(6_000)}\nconfig: max_connections=100 for checkout pool\n`;
			const c = "runtime: observed pool_limit=50 while active_connections=95 under load\n";
			return a + `${"b".repeat(6_000)}\n` + c + `${"d".repeat(6_000)}`;
		},
	},
	{
		id: "repo_worker_mode_enum",
		kind: "repo_scan",
		expectArm: "C",
		question: "What values does rlm.workerMode accept in settings-schema?",
		patterns: ["rlm.workerMode", "evidence-packet", "auto"],
		repoRelPath: "src/config/settings-schema.ts",
		selectPolicy: { maxMatches: 2, contextChars: 256, maxTotalBytes: 4096 },
	},
	{
		id: "repo_tokenomics_policy",
		kind: "repo_scan",
		expectArm: "D",
		question: "When does deriveContextPolicy return rlm-search-grants-groq?",
		patterns: ["rlm-search-grants-groq", "evidence-packet", "workerMode"],
		repoRelPath: "src/rlm/tokenomics-bridge.ts",
		selectPolicy: { maxMatches: 3, contextChars: 320, maxTotalBytes: 6000 },
	},
	{
		id: "repo_auto_gate_policy",
		kind: "repo_scan",
		expectArm: "D",
		question: "What complexity classes route to evidence-packet under auto mode?",
		patterns: ["multi_region", "contradictory", "dense_log"],
		repoRelPath: "src/rlm/worker-mode-policy.ts",
		selectPolicy: { maxMatches: 4, contextChars: 384, maxTotalBytes: 8192 },
	},
	{
		id: "repo_rlm_tool_query",
		kind: "repo_scan",
		expectArm: "D",
		question: "Where does RlmTool log the auto worker-mode decision?",
		patterns: ["worker-mode-auto", "formatWorkerModeDecisionLine", "auto decision"],
		repoRelPath: "src/tools/rlm.ts",
		selectPolicy: { maxMatches: 3, contextChars: 256, maxTotalBytes: 5000 },
	},
];

export function corpusForTask(task: DogfoodTask): string {
	if (task.repoRelPath) return readRepo(task.repoRelPath);
	if (task.buildCorpus) return task.buildCorpus();
	throw new Error(`task ${task.id} has no corpus source`);
}
