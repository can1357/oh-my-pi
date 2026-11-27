/**
 * omp settings every metaharness launch path pins, so a run measures the model on
 * its task alone: no messaging with other omp instances, no `report_issue` tool,
 * no marketplace update checks, and no model name in the system prompt.
 *
 * Harbor merges them under `--setting` values (`runner.ts`), TB and compaction
 * write them into `config.yml`, and the edit/scope adapters pass them as
 * in-process Settings overrides (a `config.yml` overlay for RPC runs).
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/** Benchmark-neutral values keyed by setting id. */
export const BENCH_SETTINGS: Readonly<Record<string, unknown>> = {
	"task.crossInstance": false,
	"dev.autoqa": false,
	"marketplace.autoUpdate": "off",
	includeModelInPrompt: false,
};

/** {@link BENCH_SETTINGS} as a `config.yml` fragment: nested keys, newline-terminated. */
export function benchSettingsYaml(): string {
	const tree: Record<string, unknown> = {};
	for (const id in BENCH_SETTINGS) {
		const dot = id.lastIndexOf(".");
		let node = tree;
		for (const part of dot < 0 ? [] : id.slice(0, dot).split(".")) {
			const child = node[part];
			if (isRecord(child)) {
				node = child;
			} else {
				const next: Record<string, unknown> = {};
				node[part] = next;
				node = next;
			}
		}
		node[id.slice(dot + 1)] = BENCH_SETTINGS[id];
	}
	return `${YAML.stringify(tree, null, 2)}\n`;
}
