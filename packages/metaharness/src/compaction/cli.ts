/**
 * Compaction benchmark CLI.
 *
 * - `baseline` runs one ProgramBench task uncompacted, captures the fork image at
 *   the first request ≥ `--fork-tokens`, and scores the workspace at the fork and
 *   at the end.
 * - `arm` resumes a baseline's fork image under one context policy and runs until
 *   the baseline's final turn count (equal work), then scores the workspace.
 *
 * Artifacts land in `<jobs-dir>/<run>/` (summary.json, report.md, turns.json,
 * logs, sessions; `fresh/` for session rebuilds).
 *
 *   bun src/compaction/cli.ts baseline --run qjs-ds41-r1
 *   bun src/compaction/cli.ts arm --from qjs-ds41-r1 --method snapcompact
 */
import * as path from "node:path";
import { parseArgs } from "node:util";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { prepareAgentBinaries } from "../tb/agent";
import { FreshStart } from "./fresh";
import { jevKeepScorer } from "./jev";
import { spotlightKeepScorer } from "./spotlight";
import { AGENT_WALL_SEC, programBenchTask } from "./programbench";
import { RemoteHost, shq } from "./remote";
import { agentConfigYaml, runTrial, SESSION_DIR, type TrialConfig, type TrialSummary, type TurnRecord } from "./trial";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");

/**
 * Context policies an arm can run. omp methods: `snapcompact`, `handoff`, `soft`, `remote`
 * (`soft` stands in for remote where the provider has no server compaction). Session rebuilds
 * (`fresh.ts`): `fresh` keeps the recent tail, `fresh-index` adds a one-line index of archived
 * turns, `fresh-min` keeps only the last turn, `jev` splits the same budget between the tail and
 * older turns TypeSafe Jev rates worth keeping, and `spotlight` does the same with Stencil Spotlight's
 * ranking under the probes in `prompts/spotlight-keep.json`.
 */
const METHODS = [
	"control",
	"snapcompact",
	"handoff",
	"soft",
	"remote",
	"fresh",
	"fresh-index",
	"fresh-min",
	"jev",
	"spotlight",
] as const;
type Method = (typeof METHODS)[number];

const HELP = `Usage: bun src/compaction/cli.ts <baseline|arm> [options]

Common:
  --model <p/m[@up]>      omp model (default openrouter/deepseek/deepseek-v4.1-flash@fireworks)
  --tools <a,b>           omp tool allowlist (default bash,read,write,edit,grep,glob)
  --stop-tokens <n>       Stop resuming once a request is this large (default 900000: omp reserves
                          the model's max output, 131k for DeepSeek V4.1 Flash, so a 1M window
                          rejects input past ~917k)
  --wall-hours <h>        Agent wall-clock budget from the task start (default 6)
  --max-continues <n>     Continue prompts after the agent ends early (default 30)
  --host <ssh-host>       Docker bench host (default xeon.internal)
  --remote-root <path>    Bench root on the host (default $HOME/cbench there)
  --jobs-dir <path>       Local artifacts root (default <repo>/runs/compaction)
  --gateway-url <url>     Local omp auth gateway (default http://127.0.0.1:4000)
  --gateway-token <t>     Gateway token (default no-auth)

baseline:
  --run <name>            Run id (default <task>-<timestamp>)
  --task <instance>       ProgramBench instance (default bellard__quickjs.d7ae12a)
  --fork-tokens <n>       Capture the fork at the first request this large (default 300000)

arm:
  --from <baseline-run>   Baseline whose fork image to resume (required)
  --method <m>            ${METHODS.join("|")}
  --rep <n>               Replicate number, part of the run id (default 1)
  --threshold <n>         Compaction / reset threshold in request tokens (default 300000)
  --tail-chars <n>        Session rebuilds: verbatim budget in characters (default 80000; jev splits
                          it evenly between the recent tail and Jev/Spotlight-selected older turns)
  --jev-model <id>        TypeSafe judge model for jev (default jev-latest; key from TYPESAFE_API_KEY)`;

/** The session-rebuild policy for a `fresh*`/`jev`/`spotlight` arm. Throws for jev without TYPESAFE_API_KEY. */
function freshFor(
	method: Method,
	threshold: number,
	tailChars: number,
	jevModel: string,
	log: (line: string) => void,
): FreshStart {
	if (method === "fresh-min") return new FreshStart({ threshold, tailChars: 1, index: false });
	if (method === "fresh-index") return new FreshStart({ threshold, tailChars, index: true });
	if (method !== "jev" && method !== "spotlight") return new FreshStart({ threshold, tailChars, index: false });
	const half = Math.floor(tailChars / 2);
	if (method === "spotlight") {
		// Spotlight scores are comparable only within a request: keep by rank, no absolute floor.
		return new FreshStart({
			threshold,
			tailChars: half,
			index: false,
			keep: { score: spotlightKeepScorer({ log }), budgetChars: tailChars - half, minProbability: 0 },
		});
	}
	const apiKey = process.env.TYPESAFE_API_KEY;
	if (!apiKey) throw new Error("jev needs TYPESAFE_API_KEY");
	return new FreshStart({
		threshold,
		tailChars: half,
		index: false,
		keep: {
			score: jevKeepScorer({ apiKey, model: jevModel, log }),
			budgetChars: tailChars - half,
			minProbability: 0.5,
		},
	});
}

async function main(argv: string[]): Promise<void> {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			run: { type: "string" },
			task: { type: "string", default: "bellard__quickjs.d7ae12a" },
			model: { type: "string", default: "openrouter/deepseek/deepseek-v4.1-flash@fireworks" },
			tools: { type: "string", default: "bash,read,write,edit,grep,glob" },
			"fork-tokens": { type: "string", default: "300000" },
			"stop-tokens": { type: "string", default: "900000" },
			"wall-hours": { type: "string", default: String(AGENT_WALL_SEC / 3_600) },
			"max-continues": { type: "string", default: "30" },
			host: { type: "string", default: "xeon.internal" },
			"remote-root": { type: "string" },
			"jobs-dir": { type: "string", default: path.join(REPO_ROOT, "runs", "compaction") },
			"gateway-url": { type: "string", default: "http://127.0.0.1:4000" },
			"gateway-token": { type: "string", default: "no-auth" },
			from: { type: "string" },
			method: { type: "string" },
			rep: { type: "string", default: "1" },
			threshold: { type: "string", default: "300000" },
			"tail-chars": { type: "string", default: "80000" },
			"jev-model": { type: "string", default: "jev-latest" },
			help: { type: "boolean", short: "h" },
		},
	});
	const command = positionals[0];
	if (values.help || (command !== "baseline" && command !== "arm")) {
		console.log(HELP);
		return;
	}
	const host = new RemoteHost(values.host);
	const remoteRoot = values["remote-root"] ?? `${(await host.sh('printf %s "$HOME"')).stdout}/cbench`;
	const jobsDir = values["jobs-dir"];
	const binaries = await prepareAgentBinaries({
		arches: ["x64"],
		cacheDir: path.join(jobsDir, "_agent"),
		rebuild: false,
	});
	const started = performance.now();
	const common = {
		model: values.model,
		tools: values.tools.split(",").filter(Boolean),
		host,
		remoteRoot,
		binary: { path: binaries.x64!, version: binaries.version },
		gatewayUrl: values["gateway-url"],
		gatewayToken: values["gateway-token"],
		stopTokens: Number(values["stop-tokens"]),
		wallSec: Math.round(Number(values["wall-hours"]) * 3_600),
		maxContinues: Number(values["max-continues"]),
		log: (line: string) =>
			console.log(
				`[${new Date().toISOString().slice(11, 19)} +${Math.round((performance.now() - started) / 60_000)}m] ${line}`,
			),
	};

	let config: TrialConfig;
	let stopCapWatch = (): void => {};
	if (command === "baseline") {
		const task = programBenchTask(values.task);
		const runName =
			values.run ??
			`${task.id.split("__")[1]?.split(".")[0]}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
		config = {
			...common,
			runName,
			task,
			localDir: path.join(jobsDir, runName),
			image: task.cleanroomImage,
			configYaml: agentConfigYaml({ enabled: false }),
			forkTokens: Number(values["fork-tokens"]),
			offset: { turns: 0, elapsedSec: 0 },
			turnCap: () => null,
		};
	} else {
		const from = values.from;
		const method = values.method as Method | undefined;
		if (!from || !method || !METHODS.includes(method))
			throw new Error(`arm needs --from and --method (${METHODS.join("|")})`);
		const baselineDir = path.join(jobsDir, from);
		const baselineTurns = (await Bun.file(path.join(baselineDir, "turns.json")).json()) as TurnRecord[];
		const forkTokens = Number(values["fork-tokens"]);
		const fork = baselineTurns.find(record => record.promptTokens >= forkTokens);
		if (!fork) throw new Error(`${from} has no turn at ≥${forkTokens} tokens in turns.json`);
		const image = `cbench-fork:${from}`;
		const resumeSession = (
			await host.sh(`docker run --rm --entrypoint sh ${shq(image)} -c ${shq(`ls ${SESSION_DIR}/*.jsonl`)}`)
		).stdout.trim();
		if (!resumeSession || resumeSession.includes("\n"))
			throw new Error(`${image}: expected one session, found ${resumeSession || "none"}`);
		// Equal work: stop at the baseline's final turn count once its summary exists.
		let cap: number | null = null;
		const refreshCap = async (): Promise<void> => {
			try {
				const baseline = (await Bun.file(path.join(baselineDir, "summary.json")).json()) as TrialSummary;
				if (baseline.turns > 0 && baseline.stopReason) cap = baseline.turns;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		};
		await refreshCap();
		const capTimer = setInterval(() => void refreshCap(), 30_000);
		stopCapWatch = () => clearInterval(capTimer);
		const threshold = Number(values.threshold);
		const rebuild = method.startsWith("fresh") || method === "jev" || method === "spotlight";
		const runName = values.run ?? `${from}-${method}-r${values.rep}`;
		config = {
			...common,
			runName,
			task: programBenchTask(values.task),
			localDir: path.join(jobsDir, runName),
			image,
			configYaml: agentConfigYaml(
				method === "control" || rebuild ? { enabled: false } : { method, thresholdTokens: threshold },
			),
			resumeSession,
			offset: { turns: fork.turn, elapsedSec: fork.elapsedSec },
			turnCap: () => cap,
			fresh: rebuild
				? freshFor(method, threshold, Number(values["tail-chars"]), values["jev-model"], common.log)
				: undefined,
		};
		common.log(
			`arm ${method} from ${image} at turn ${fork.turn} (${fork.promptTokens} tokens), cap ${cap ?? "pending"}`,
		);
	}
	try {
		const summary = await runTrial(config);
		console.log(JSON.stringify(summary, null, 2));
	} finally {
		stopCapWatch();
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch(error => {
		console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
		process.exitCode = 1;
	});
}
