/**
 * ProgramBench wiring for the compaction benchmark: images, the cleanroom
 * container contract, submission packing, and scoring.
 *
 * Container limits mirror the official mini-swe-agent inference config
 * (`--network none --cpus 20 --memory 60g --cap-drop SYS_PTRACE`, user `agent`,
 * `/workspace`); scoring calls ProgramBench's own `score_instance`, so ignored
 * branches and tests match the public leaderboard.
 */
import * as path from "node:path";
import { type RemoteHost, shq } from "./remote";

/** One ProgramBench instance. */
export interface ProgramBenchTask {
	/** Instance id, e.g. `bellard__quickjs.d7ae12a`. */
	id: string;
	/** Image agents solve in: artifact-free, offline. */
	cleanroomImage: string;
}

/** Resolve an instance id to its Docker Hub images (`__` becomes `_1776_`). */
export function programBenchTask(id: string): ProgramBenchTask {
	return { id, cleanroomImage: `programbench/${id.replace("__", "_1776_")}:task_cleanroom_v6` };
}

/** Official agent wall-clock budget. */
export const AGENT_WALL_SEC = 6 * 60 * 60;

/** Unprivileged user and its home inside ProgramBench images. */
export const AGENT_USER = "agent";
export const AGENT_HOME = "/home/agent";

/** `docker run` flags matching the official inference sandbox. */
export const CONTAINER_FLAGS = [
	"--network",
	"none",
	"--cpus",
	"20",
	"--memory",
	"60g",
	"--memory-swap",
	"60g",
	"--cap-drop",
	"SYS_PTRACE",
	"--init",
];

/** Environment the official config sets for every agent command. */
export const AGENT_ENV: Record<string, string> = {
	PAGER: "cat",
	MANPAGER: "cat",
	LESS: "-R",
	PIP_PROGRESS_BAR: "off",
	TQDM_DISABLE: "1",
};

/** Where a container's or image's workspace comes from when packing a submission. */
export type WorkspaceSource = { container: string } | { image: string };

/**
 * Tar `/workspace` into `<evalDir>/<id>/submission.tar.gz` on the host, the layout
 * `programbench eval` expects. Packs as root so root-owned files are included;
 * the evaluator strips the reference executable itself.
 */
export async function packSubmission(
	host: RemoteHost,
	source: WorkspaceSource,
	evalDir: string,
	task: ProgramBenchTask,
): Promise<string> {
	const out = path.posix.join(evalDir, task.id, "submission.tar.gz");
	const tar = "tar czf - -C /workspace .";
	const producer =
		"container" in source
			? `docker exec -u root ${shq(source.container)} ${tar}`
			: `docker run --rm --network none -u root --entrypoint sh ${shq(source.image)} -c ${shq(tar)}`;
	await host.sh(`mkdir -p ${shq(path.posix.dirname(out))} && ${producer} > ${shq(out)}`);
	return out;
}

/**
 * Pack the container's last commit (`git archive HEAD`) as `<evalDir>/<id>/submission.tar.gz`: a fresh
 * checkout, which the task requires `compile.sh` to build. Scoring it alongside the working tree
 * separates what the agent finished from edits a cutoff interrupted mid-change.
 *
 * Throws when the workspace has no commit.
 */
export async function packCommitted(
	host: RemoteHost,
	container: string,
	evalDir: string,
	task: ProgramBenchTask,
): Promise<string> {
	const out = path.posix.join(evalDir, task.id, "submission.tar.gz");
	await host.sh(
		`mkdir -p ${shq(path.posix.dirname(out))} && docker exec -w /workspace ${shq(container)} git archive --format=tar HEAD | gzip > ${shq(out)}`,
	);
	return out;
}

/**
 * Run `programbench eval` over one packed run directory and return the instance's
 * pass fraction (0..1) after ProgramBench's active-branch and ignored-test filtering.
 *
 * Throws when the evaluator fails or writes no score for the instance.
 */
export async function evaluateSubmission(host: RemoteHost, evalDir: string, task: ProgramBenchTask): Promise<number> {
	await host.sh(`cd ${shq(evalDir)} && uvx programbench eval . > eval.log 2>&1`);
	const score = await host.sh(
		`cd ${shq(evalDir)} && uvx --from programbench python -c ${shq(
			"import json, pathlib; from programbench.submission import benchmark_instances, score_run; print(json.dumps(score_run(pathlib.Path('.'), benchmark_instances())))",
		)}`,
	);
	const scores = JSON.parse(score.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, number>;
	const value = scores[task.id];
	if (typeof value !== "number") throw new Error(`programbench wrote no score for ${task.id} in ${evalDir}`);
	return value;
}
