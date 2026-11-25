/**
 * One compaction-benchmark trial: omp on one ProgramBench task inside an
 * offline Docker container on the bench host, with every turn's request size
 * recorded.
 *
 * - **Baseline** (`forkTokens` set): starts from the cleanroom image on the task
 *   prompt with auto-compaction off. The first turn whose request reaches
 *   `forkTokens` is captured with `docker commit`; the commit pauses the
 *   container, so the image holds the workspace and the session prefix with no
 *   tool mid-run.
 * - **Arm** (`resumeSession` set): starts from that fork image, resumes the
 *   captured session under the arm's context policy (`configYaml`: omp
 *   auto-compaction method, or `fresh` for the session-rebuild method), and stops
 *   at the baseline's final turn count so every arm is scored after equal work.
 *
 * When the agent ends its turn before the wall clock, it is resumed with a fixed
 * continue prompt (as PaperBench's IterativeAgent does); ten minutes before the
 * deadline it is interrupted and gets ProgramBench's wrap-up instruction.
 *
 * Architecture: omp runs detached in the container (`--mode json`, one process
 * per segment, `--resume <session>` after the first) and writes its event stream
 * to a log the runner follows over SSH. The container has no network; omp reaches
 * the host's auth gateway through an SSH-forwarded unix socket and a relay.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage, prompt } from "@oh-my-pi/pi-utils";
import { benchSettingsYaml } from "../bench-settings";
import type { Subprocess } from "bun";
import { type FreshStart, HISTORY_DIR } from "./fresh";
import continuePrompt from "./prompts/continue.md" with { type: "text" };
import systemPrompt from "./prompts/programbench-system.md" with { type: "text" };
import taskPrompt from "./prompts/programbench-task.md" with { type: "text" };
import resumePrompt from "./prompts/resume.md" with { type: "text" };
import wrapUpPrompt from "./prompts/wrap-up.md" with { type: "text" };
import {
	AGENT_ENV,
	AGENT_HOME,
	AGENT_USER,
	CONTAINER_FLAGS,
	evaluateSubmission,
	packSubmission,
	packCommitted,
	type ProgramBenchTask,
} from "./programbench";
import { type RemoteHost, shq } from "./remote";

const OMP_PATH = "/opt/omp/omp";
/** Read-only bind mount holding prompts, the relay, and omp config. */
const SUPPORT_DIR = "/opt/cbench";
const GATEWAY_SOCKET_DIR = "/run/omp-gw";
const RELAY_PORT = 4000;
/** Session directory inside the task container. */
export const SESSION_DIR = `${AGENT_HOME}/sessions`;
const WRAP_UP_LEAD_MS = 10 * 60_000;
const KILL_GRACE_MS = 60_000;
/** Consecutive segments without a tool call before the run stops resuming. */
const IDLE_SEGMENT_LIMIT = 3;

/**
 * omp settings for a trial: the shared harness config ({@link benchSettingsYaml}
 * included) plus a `compaction:` block.
 * Baseline and the control/fresh arms pass `{ enabled: false }`.
 */
export function agentConfigYaml(compaction: { enabled: false } | { method: string; thresholdTokens: number }): string {
	const block =
		"method" in compaction
			? `compaction:\n  enabled: true\n  methodOrder: [${compaction.method}]\n  thresholdTokens: ${compaction.thresholdTokens}\n`
			: "compaction:\n  enabled: false\n";
	return `${block}contextPromotion:
  enabled: false
extendedContext: true
edit:
  mode: replace
web_search:
  enabled: false
${benchSettingsYaml()}`;
}

/** Inputs for {@link runTrial}. */
export interface TrialConfig {
	/** Run id; names the container, the fork image tag, and artifact directories. */
	runName: string;
	task: ProgramBenchTask;
	/** `provider/model[@upstream]` passed to omp. */
	model: string;
	tools: string[];
	host: RemoteHost;
	/** Absolute bench root on the host (binaries, per-run directories). */
	remoteRoot: string;
	/** Local artifact directory for this run. */
	localDir: string;
	/** Local self-contained omp linux-x64 binary and its package version. */
	binary: { path: string; version: string };
	/** Local auth gateway the container reaches through the forwarded socket. */
	gatewayUrl: string;
	gatewayToken: string;
	/** Image the container starts from: the cleanroom task image or a baseline's fork image. */
	image: string;
	/** omp settings installed as `~/.omp/agent/config.yml` ({@link agentConfigYaml}). */
	configYaml: string;
	/** Session file inside the image to resume; absent starts a new session on the task prompt. */
	resumeSession?: string;
	/** Capture a fork image at the first request this large (baseline only). */
	forkTokens?: number;
	/** No continue prompt is sent once a request reaches this size. */
	stopTokens: number;
	/** Agent wall-clock budget, counted from the original start (`offset` included). */
	wallSec: number;
	maxContinues: number;
	/** Turns and agent seconds already spent before this trial (arms resume a baseline at its fork). */
	offset: { turns: number; elapsedSec: number };
	/** Total-turn cap, read at every turn; null while unknown. */
	turnCap: () => number | null;
	/** Session-rebuild arm: applied at the start and whenever a request reaches its threshold. */
	fresh?: FreshStart;
	log: (line: string) => void;
}

/** One assistant turn. */
export interface TurnRecord {
	/** Turn number counted from the start of the original run (offset included). */
	turn: number;
	segment: number;
	/** Agent seconds since the original run started (offset included). */
	elapsedSec: number;
	/** Request size: input + cache-read + cache-write tokens. */
	promptTokens: number;
	outputTokens: number;
	costUsd: number;
	stopReason: string;
}

/** The fork point captured at the first turn whose request reaches `forkTokens`. */
export interface ForkRecord {
	turn: number;
	promptTokens: number;
	elapsedSec: number;
	image: string;
	commitMs: number;
	/** A tool started while the commit was pending: the image may hold part of the next turn. */
	toolStartedDuringCommit: boolean;
	/** Assistant messages in the image's session file; `turn` when the capture is exact. */
	sessionAssistantMessages: number | null;
}

/** Outcome of a trial, written to `summary.json`. */
export interface TrialSummary {
	runName: string;
	task: string;
	model: string;
	ompVersion: string;
	image: string;
	startedAt: string;
	/** Turn the trial started after (the fork turn for arms, 0 for the baseline). */
	startTurn: number;
	agentWallSec: number;
	/** Total turns including `startTurn`. */
	turns: number;
	segments: number;
	continues: number;
	/** omp auto-compactions completed (`auto_compaction_end` events). */
	compactions: number;
	/** Session rebuilds by the fresh-start arm. */
	resets: number;
	stopReason: string;
	/** Where the agent first ended its turn on its own (baseline only; null when it never did). */
	naturalStop: { turn: number; promptTokens: number; elapsedSec: number } | null;
	fork: ForkRecord | null;
	peakPromptTokens: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	costUsd: number;
	/**
	 * ProgramBench pass fraction of the workspace at the fork (baseline), at the end (working tree), and
	 * of the last commit at the end (`head`: a fresh checkout, unaffected by an edit the cutoff interrupted).
	 */
	scores: { fork: number | null; final: number | null; head: number | null };
	errors: string[];
}

interface AssistantUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: { total?: number };
}

interface OmpEvent {
	type: string;
	code?: number;
	message?: { role?: string; usage?: AssistantUsage; stopReason?: string };
}

interface SegmentOutcome {
	exitCode: number;
	toolCalls: number;
}

type Continuation =
	| { kind: "task" | "resume" | "continue" | "wrap-up"; text: string }
	| { kind: "stop"; reason: string };

/** Run one trial end to end: agent segments, fork capture, artifacts, scoring. */
export async function runTrial(config: TrialConfig): Promise<TrialSummary> {
	const { host, task, log } = config;
	const container = `cbench-${config.runName}`;
	const forkImage = `cbench-fork:${config.runName}`;
	const remoteRun = path.posix.join(config.remoteRoot, "runs", config.runName);
	const supportDir = path.posix.join(remoteRun, "support");
	const socketDir = path.posix.join(remoteRun, "gw");
	const remoteBinary = path.posix.join(config.remoteRoot, "bin", `omp-linux-x64-${config.binary.version}`);
	await fs.mkdir(config.localDir, { recursive: true });

	await host.sh(`mkdir -p ${shq(supportDir)} ${shq(socketDir)} ${shq(path.posix.dirname(remoteBinary))}`);
	if ((await host.sh(`test -x ${shq(remoteBinary)}`, { nothrow: true })).exitCode !== 0) {
		log(`upload omp ${config.binary.version}`);
		await host.upload(config.binary.path, `${remoteBinary}.part`);
		await host.sh(
			`chmod 755 ${shq(`${remoteBinary}.part`)} && mv ${shq(`${remoteBinary}.part`)} ${shq(remoteBinary)}`,
		);
	}
	await host.write(`${supportDir}/system.md`, systemPrompt);
	await host.write(`${supportDir}/gw-relay.py`, await Bun.file(path.join(import.meta.dir, "gw-relay.py")).text());
	await host.write(`${supportDir}/config.yml`, config.configYaml);
	await host.write(`${supportDir}/models.yml`, modelsYaml(config));
	if (!config.resumeSession) {
		log(`pull ${config.image}`);
		await host.sh(`docker pull -q ${shq(config.image)}`);
	}

	const summary: TrialSummary = {
		runName: config.runName,
		task: task.id,
		model: config.model,
		ompVersion: config.binary.version,
		image: config.image,
		startedAt: new Date().toISOString(),
		startTurn: config.offset.turns,
		agentWallSec: 0,
		turns: config.offset.turns,
		segments: 0,
		continues: 0,
		compactions: 0,
		resets: 0,
		stopReason: "",
		naturalStop: null,
		fork: null,
		peakPromptTokens: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		costUsd: 0,
		scores: { fork: null, final: null, head: null },
		errors: [],
	};
	const turns: TurnRecord[] = [];
	const tunnel = startGatewayTunnel(host, `${socketDir}/gw.sock`, config.gatewayUrl, log);
	const timers: Timer[] = [];
	try {
		await startContainer(config, container, { supportDir, socketDir, remoteBinary });
		log(`container ${container} up from ${config.image}; gateway reachable`);
		let session = config.resumeSession ?? null;
		if (config.fresh && session) {
			session = await applyFresh(config, container, remoteRun, session, summary.resets + 1);
			summary.resets++;
		}

		// ── agent segments ──────────────────────────────────────────────
		const startedAt = Date.now();
		const deadline = startedAt + (config.wallSec - config.offset.elapsedSec) * 1_000;
		let segment = 0;
		let running = false;
		let wrapUpDue = false;
		let resetDue = false;
		let capReached = false;
		let lastPromptTokens = 0;
		let forkPending: Promise<void> | null = null;
		let toolStartedDuringCommit = false;

		const signalSegment = (signal: "INT" | "KILL"): void => {
			if (!running) return;
			const pidFile = `/logs/segment-${segment}.pid`;
			void host.sh(`docker exec ${shq(container)} sh -c ${shq(`kill -${signal} "$(cat ${pidFile})"`)}`, {
				nothrow: true,
			});
		};
		timers.push(
			setTimeout(
				() => {
					wrapUpDue = true;
					log("wrap-up due; interrupting the running segment");
					signalSegment("INT");
				},
				Math.max(0, deadline - WRAP_UP_LEAD_MS - Date.now()),
			),
			setTimeout(() => signalSegment("INT"), Math.max(0, deadline - Date.now())),
			setTimeout(() => signalSegment("KILL"), Math.max(0, deadline + KILL_GRACE_MS - Date.now())),
		);

		const onEvent = (event: OmpEvent, outcome: SegmentOutcome): void => {
			if (event.type === "tool_execution_start") {
				outcome.toolCalls++;
				if (forkPending) toolStartedDuringCommit = true;
				return;
			}
			if (event.type === "auto_compaction_start" || event.type === "auto_compaction_end") {
				if (event.type === "auto_compaction_end") summary.compactions++;
				log(
					`${event.type} after turn ${config.offset.turns + turns.length}: ${JSON.stringify(event).slice(0, 300)}`,
				);
				return;
			}
			if (event.type !== "turn_end" || event.message?.role !== "assistant") return;
			const usage = event.message.usage;
			const promptTokens = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
			const record: TurnRecord = {
				turn: config.offset.turns + turns.length + 1,
				segment,
				elapsedSec: config.offset.elapsedSec + Math.round((Date.now() - startedAt) / 1_000),
				promptTokens,
				outputTokens: usage?.output ?? 0,
				costUsd: usage?.cost?.total ?? 0,
				stopReason: event.message.stopReason ?? "",
			};
			turns.push(record);
			summary.turns = record.turn;
			if (usage) {
				summary.tokens.input += usage.input;
				summary.tokens.output += usage.output;
				summary.tokens.cacheRead += usage.cacheRead;
				summary.tokens.cacheWrite += usage.cacheWrite;
			}
			summary.costUsd += record.costUsd;
			// Aborted/errored turns report no usage; keep the last real request size.
			if (promptTokens > 0) lastPromptTokens = promptTokens;
			summary.peakPromptTokens = Math.max(summary.peakPromptTokens, promptTokens);
			if (record.turn % 10 === 0) {
				log(
					`turn ${record.turn} seg ${segment} prompt ${(promptTokens / 1_000).toFixed(0)}k elapsed ${formatDuration(record.elapsedSec)} $${summary.costUsd.toFixed(2)}`,
				);
			}
			const cap = config.turnCap();
			if (cap !== null && record.turn >= cap && !capReached) {
				capReached = true;
				log(`turn cap ${cap} reached`);
				signalSegment("INT");
			}
			if (config.fresh && promptTokens >= config.fresh.threshold && !resetDue && !capReached) {
				resetDue = true;
				log(`fresh reset due: turn ${record.turn} prompt ${promptTokens}`);
				signalSegment("INT");
			}
			if (config.forkTokens && !summary.fork && !forkPending && promptTokens >= config.forkTokens) {
				const commitStart = performance.now();
				log(`fork: turn ${record.turn} prompt ${promptTokens} → docker commit ${forkImage}`);
				forkPending = host
					.sh(
						`docker commit -m ${shq(`${config.runName} fork at turn ${record.turn} (${promptTokens} prompt tokens)`)} ${shq(container)} ${shq(forkImage)}`,
					)
					.then(
						() => {
							summary.fork = {
								turn: record.turn,
								promptTokens,
								elapsedSec: record.elapsedSec,
								image: forkImage,
								commitMs: Math.round(performance.now() - commitStart),
								toolStartedDuringCommit,
								sessionAssistantMessages: null,
							};
							log(`fork captured in ${summary.fork.commitMs}ms`);
						},
						(error: unknown) => {
							summary.errors.push(`fork commit failed: ${errorMessage(error)}`);
							log(`fork commit failed: ${errorMessage(error)}`);
						},
					)
					.finally(() => {
						forkPending = null;
					});
			}
		};

		let idleSegments = 0;
		let next: Continuation = session ? { kind: "resume", text: resumePrompt } : { kind: "task", text: taskPrompt };
		while (next.kind !== "stop") {
			segment++;
			summary.segments = segment;
			running = true;
			const outcome = await runSegment(config, container, supportDir, segment, next.text, session, onEvent).finally(
				() => {
					running = false;
				},
			);
			const last = turns.at(-1);
			log(
				`segment ${segment} exited ${outcome.exitCode} after turn ${summary.turns} (${outcome.toolCalls} tool calls, prompt ${lastPromptTokens})`,
			);
			if (next.kind === "task" && outcome.exitCode === 0 && last?.stopReason === "stop" && !wrapUpDue) {
				summary.naturalStop = { turn: last.turn, promptTokens: last.promptTokens, elapsedSec: last.elapsedSec };
			}
			session = (
				await host.sh(`docker exec ${shq(container)} sh -c ${shq(`ls -t ${SESSION_DIR}/*.jsonl | head -1`)}`)
			).stdout.trim();
			idleSegments = outcome.toolCalls === 0 ? idleSegments + 1 : 0;
			const previous = next.kind;
			if (capReached) {
				next = { kind: "stop", reason: "turn cap" };
			} else if (resetDue && config.fresh && Date.now() < deadline) {
				resetDue = false;
				summary.resets++;
				session = await applyFresh(config, container, remoteRun, session, summary.resets);
				next = wrapUpDue
					? { kind: "wrap-up", text: prompt.render(wrapUpPrompt, { remainingMinutes: minutesLeft(deadline) }) }
					: { kind: "resume", text: resumePrompt };
			} else {
				next = decideContinuation({
					config,
					deadline,
					wrapUpDue,
					previous,
					promptTokens: lastPromptTokens,
					continues: summary.continues,
					idleSegments,
				});
			}
			if (next.kind === "continue") summary.continues++;
			if (next.kind === "stop") summary.stopReason = next.reason;
			await Bun.write(path.join(config.localDir, "turns.json"), JSON.stringify(turns, null, "\t"));
		}
		await forkPending;
		summary.agentWallSec = config.offset.elapsedSec + Math.round((Date.now() - startedAt) / 1_000);

		// ── artifacts ───────────────────────────────────────────────────
		log("collect artifacts");
		await host.sh(
			`rm -rf ${shq(`${remoteRun}/logs`)} ${shq(`${remoteRun}/sessions`)} && docker cp ${shq(`${container}:/logs`)} ${shq(`${remoteRun}/logs`)} && docker cp ${shq(`${container}:${SESSION_DIR}`)} ${shq(`${remoteRun}/sessions`)}`,
		);
		await packSubmission(host, { container }, `${remoteRun}/eval-final`, task);
		await packCommitted(host, container, `${remoteRun}/eval-head`, task);
		if (summary.fork) {
			const probe = `${container}-forkprobe`;
			await host.sh(
				`docker rm -f ${shq(probe)} >/dev/null 2>&1; rm -rf ${shq(`${remoteRun}/fork-sessions`)} && docker create --name ${shq(probe)} ${shq(forkImage)} >/dev/null && docker cp ${shq(`${probe}:${SESSION_DIR}`)} ${shq(`${remoteRun}/fork-sessions`)}; docker rm -f ${shq(probe)} >/dev/null`,
			);
			await packSubmission(host, { image: forkImage }, `${remoteRun}/eval-fork`, task);
		}
		await host.sh(`docker rm -f ${shq(container)} >/dev/null`);
		for (const dir of ["logs", "sessions", ...(summary.fork ? ["fork-sessions"] : [])]) {
			await fs.rm(path.join(config.localDir, dir), { recursive: true, force: true });
			await host.download(`${remoteRun}/${dir}`, path.join(config.localDir, dir));
		}
		if (summary.fork) {
			summary.fork.sessionAssistantMessages = await countAssistantMessages(
				path.join(config.localDir, "fork-sessions"),
			);
		}

		// ── scoring ─────────────────────────────────────────────────────
		for (const [key, dir] of [
			["final", "eval-final"],
			["head", "eval-head"],
			["fork", "eval-fork"],
		] as const) {
			if (key === "fork" && !summary.fork) continue;
			log(`programbench eval (${key})`);
			try {
				summary.scores[key] = await evaluateSubmission(host, `${remoteRun}/${dir}`, task);
				log(`score ${key}: ${summary.scores[key]}`);
			} catch (error) {
				summary.errors.push(`eval ${key}: ${errorMessage(error)}`);
			}
		}
	} catch (error) {
		// Stop (not remove) the container: no unsupervised agent keeps running, the workspace stays inspectable.
		await host.sh(`docker stop ${shq(container)} >/dev/null 2>&1`, { nothrow: true });
		summary.errors.push(errorMessage(error));
		throw error;
	} finally {
		for (const timer of timers) clearTimeout(timer);
		tunnel.stop();
		await Bun.write(path.join(config.localDir, "turns.json"), JSON.stringify(turns, null, "\t"));
		await Bun.write(path.join(config.localDir, "summary.json"), JSON.stringify(summary, null, "\t"));
		await Bun.write(path.join(config.localDir, "report.md"), formatReport(summary, turns, config.forkTokens));
	}
	return summary;
}

function minutesLeft(deadline: number): number {
	return Math.max(0, Math.floor((deadline - Date.now()) / 60_000));
}

/** Decide what follows a finished segment. */
function decideContinuation(state: {
	config: TrialConfig;
	deadline: number;
	wrapUpDue: boolean;
	previous: Continuation["kind"];
	promptTokens: number;
	continues: number;
	idleSegments: number;
}): Continuation {
	const remainingMinutes = minutesLeft(state.deadline);
	if (state.previous === "wrap-up") return { kind: "stop", reason: "wrapped up" };
	if (Date.now() >= state.deadline) return { kind: "stop", reason: "wall clock" };
	if (state.promptTokens >= state.config.stopTokens) return { kind: "stop", reason: "context limit" };
	if (state.wrapUpDue) return { kind: "wrap-up", text: prompt.render(wrapUpPrompt, { remainingMinutes }) };
	if (state.continues >= state.config.maxContinues) return { kind: "stop", reason: "continue limit" };
	if (state.idleSegments >= IDLE_SEGMENT_LIMIT) return { kind: "stop", reason: "agent idle" };
	return { kind: "continue", text: prompt.render(continuePrompt, { remainingMinutes }) };
}

/**
 * Rebuild the container's current session with the fresh-start method: copy it
 * out, archive all but the recent tail as transcript + files, install both, and
 * return the new session's path inside the container.
 */
async function applyFresh(
	config: TrialConfig,
	container: string,
	remoteRun: string,
	session: string,
	reset: number,
): Promise<string> {
	const { host, log } = config;
	const fresh = config.fresh!;
	const remoteStage = `${remoteRun}/fresh/${reset}`;
	const localStage = path.join(config.localDir, "fresh", String(reset));
	await host.sh(
		`rm -rf ${shq(remoteStage)} && mkdir -p ${shq(remoteStage)} && docker cp ${shq(`${container}:${session}`)} ${shq(`${remoteStage}/source.jsonl`)}`,
	);
	await fs.rm(localStage, { recursive: true, force: true });
	await fs.mkdir(localStage, { recursive: true });
	await host.download(`${remoteStage}/source.jsonl`, path.join(localStage, "source.jsonl"));
	const build = await fresh.rebuild(await Bun.file(path.join(localStage, "source.jsonl")).text());
	for (const [relative, content] of build.files) await Bun.write(path.join(localStage, "history", relative), content);
	await Bun.write(path.join(localStage, build.sessionFile), build.sessionJsonl);
	await host.upload(path.join(localStage, "history"), `${remoteStage}/history`);
	await host.upload(path.join(localStage, build.sessionFile), `${remoteStage}/${build.sessionFile}`);
	const target = `${SESSION_DIR}/${build.sessionFile}`;
	await host.sh(
		[
			`docker exec -u root ${shq(container)} rm -rf ${HISTORY_DIR}`,
			`docker cp -a ${shq(`${remoteStage}/history`)} ${shq(`${container}:${HISTORY_DIR}`)}`,
			`docker cp -a ${shq(`${remoteStage}/${build.sessionFile}`)} ${shq(`${container}:${target}`)}`,
			`docker exec -u root ${shq(container)} chown -R ${AGENT_USER}: ${HISTORY_DIR} ${target}`,
		].join(" && "),
	);
	log(
		`fresh reset ${reset}: archived ${build.archivedItems} entries, kept ${build.selectedTurns} selected turns + ${build.tailItems} tail entries → ${target}`,
	);
	return target;
}

/** Launch one detached omp process for a segment and follow its event log until it exits. */
async function runSegment(
	config: TrialConfig,
	container: string,
	supportDir: string,
	index: number,
	text: string,
	session: string | null,
	onEvent: (event: OmpEvent, outcome: SegmentOutcome) => void,
): Promise<SegmentOutcome> {
	const { host } = config;
	await host.write(`${supportDir}/prompt-${index}.md`, text);
	const argv = [
		OMP_PATH,
		"--mode",
		"json",
		"-p",
		"--auto-approve",
		"--model",
		config.model,
		"--tools",
		config.tools.join(","),
		"--session-dir",
		SESSION_DIR,
		"--append-system-prompt",
		`${SUPPORT_DIR}/system.md`,
		...(session ? ["--resume", session] : []),
	];
	const logFile = `/logs/segment-${index}.jsonl`;
	// The trailing record marks the exit so the follower knows when to stop.
	const script = `${argv.map(shq).join(" ")} "$(cat ${SUPPORT_DIR}/prompt-${index}.md)" > ${logFile} 2> /logs/segment-${index}.err & echo $! > /logs/segment-${index}.pid; wait $!; echo "{\\"type\\":\\"segment_exit\\",\\"code\\":$?}" >> ${logFile}`;
	await host.sh(`docker exec -d -w /workspace ${shq(container)} sh -c ${shq(script)}`);
	const outcome: SegmentOutcome = { exitCode: -1, toolCalls: 0 };
	await host.followJsonl(container, logFile, record => {
		const event = record as OmpEvent;
		if (event.type === "segment_exit") {
			outcome.exitCode = event.code ?? -1;
			return true;
		}
		onEvent(event, outcome);
		return false;
	});
	return outcome;
}

/** Start the offline task container, install omp config, and wait for the gateway relay. */
async function startContainer(
	config: TrialConfig,
	container: string,
	dirs: { supportDir: string; socketDir: string; remoteBinary: string },
): Promise<void> {
	const { host } = config;
	const env = Object.entries({ ...AGENT_ENV, HOME: AGENT_HOME }).flatMap(([key, value]) => [
		"-e",
		shq(`${key}=${value}`),
	]);
	await host.sh(`docker rm -f ${shq(container)} >/dev/null 2>&1 || true`);
	await host.sh(
		[
			"docker run -d --name",
			shq(container),
			...CONTAINER_FLAGS,
			"--user",
			AGENT_USER,
			"-w /workspace",
			...env,
			"-v",
			shq(`${dirs.supportDir}:${SUPPORT_DIR}:ro`),
			"-v",
			shq(`${dirs.socketDir}:${GATEWAY_SOCKET_DIR}`),
			"-v",
			shq(`${dirs.remoteBinary}:${OMP_PATH}:ro`),
			shq(config.image),
			"sleep infinity",
		].join(" "),
	);
	// A fork image carries the baseline's /logs (its segment logs would be re-read as ours)
	// and the stale single-writer lock of the session it captured mid-run.
	await host.sh(
		`docker exec -u root ${shq(container)} sh -c ${shq(`rm -rf /logs ${SESSION_DIR}/.*.lock*; mkdir -p /logs ${AGENT_HOME}/.omp/agent && chown -R ${AGENT_USER}: /logs ${AGENT_HOME}`)}`,
	);
	await host.sh(
		`docker exec ${shq(container)} cp ${SUPPORT_DIR}/config.yml ${SUPPORT_DIR}/models.yml ${AGENT_HOME}/.omp/agent/`,
	);
	await host.sh(
		`docker exec -d ${shq(container)} python3 ${SUPPORT_DIR}/gw-relay.py ${GATEWAY_SOCKET_DIR}/gw.sock ${RELAY_PORT}`,
	);
	const probe = `import urllib.request; urllib.request.urlopen('http://127.0.0.1:${RELAY_PORT}/healthz', timeout=5)`;
	for (let attempt = 0; ; attempt++) {
		const result = await host.sh(`docker exec ${shq(container)} python3 -c ${shq(probe)}`, { nothrow: true });
		if (result.exitCode === 0) return;
		if (attempt >= 30) throw new Error(`gateway unreachable from ${container}: ${result.stderr.trim().slice(-500)}`);
		await Bun.sleep(1_000);
	}
}

/** Keep an SSH remote forward from a host unix socket to the local gateway alive until stopped. */
function startGatewayTunnel(
	host: RemoteHost,
	socket: string,
	gatewayUrl: string,
	log: (line: string) => void,
): { stop(): void } {
	const target = new URL(gatewayUrl);
	const port = target.port || (target.protocol === "https:" ? "443" : "80");
	let stopped = false;
	let child: Subprocess<"ignore", "pipe", "pipe"> | null = null;
	void (async () => {
		while (!stopped) {
			// sshd does not unlink stale sockets for -R by default.
			await host.sh(`rm -f ${shq(socket)}`, { nothrow: true });
			// A dedicated connection: under ControlMaster the client hands the forward to the
			// shared master and exits at once, and the next `rm -f` would delete the live socket.
			child = host.spawn([
				"-N",
				"-o",
				"ControlMaster=no",
				"-o",
				"ControlPath=none",
				"-o",
				"ExitOnForwardFailure=yes",
				"-R",
				`${socket}:${target.hostname}:${port}`,
			]);
			const code = await child.exited;
			if (stopped) return;
			log(`gateway tunnel exited (${code}); restarting`);
			await Bun.sleep(2_000);
		}
	})();
	return {
		stop() {
			stopped = true;
			child?.kill();
		},
	};
}

/** Route the model's provider through the in-container relay to the host gateway. */
function modelsYaml(config: TrialConfig): string {
	const provider = config.model.slice(0, config.model.indexOf("/"));
	return `providers:
  ${provider}:
    baseUrl: http://127.0.0.1:${RELAY_PORT}
    auth: oauth
    transport: pi-native
    apiKey: ${config.gatewayToken}
`;
}

/** Count assistant messages across the session JSONL files in a directory tree. */
async function countAssistantMessages(dir: string): Promise<number> {
	let count = 0;
	for (const file of await fs.readdir(dir, { recursive: true })) {
		if (!file.endsWith(".jsonl")) continue;
		for (const line of (await Bun.file(path.join(dir, file)).text()).split("\n")) {
			if (!line) continue;
			const entry = JSON.parse(line) as { type?: string; message?: { role?: string } };
			if (entry.type === "message" && entry.message?.role === "assistant") count++;
		}
	}
	return count;
}

function formatReport(summary: TrialSummary, turns: TurnRecord[], forkTokens: number | undefined): string {
	const crossings: string[] = [];
	for (let mark = 100_000; mark <= 1_000_000; mark += 100_000) {
		const turn = turns.find(record => record.promptTokens >= mark);
		if (turn)
			crossings.push(`| ${mark / 1_000}k | ${turn.turn} | ${turn.segment} | ${formatDuration(turn.elapsedSec)} |`);
	}
	const fork = summary.fork;
	return `# Compaction trial: ${summary.runName}

- Task: \`${summary.task}\` · model \`${summary.model}\` · omp ${summary.ompVersion} · image \`${summary.image}\`
- Turns ${summary.startTurn}→${summary.turns} over ${summary.segments} segments (${summary.continues} continues, ${summary.compactions} compactions, ${summary.resets} resets), stopped: ${summary.stopReason}
- Agent wall time ${formatDuration(summary.agentWallSec)} · cost $${summary.costUsd.toFixed(2)} · peak request ${summary.peakPromptTokens} tokens
- First natural stop: ${summary.naturalStop ? `turn ${summary.naturalStop.turn} at ${summary.naturalStop.promptTokens} tokens (${formatDuration(summary.naturalStop.elapsedSec)})` : "none"}
${forkTokens ? `- Fork (≥${forkTokens}): ${fork ? `turn ${fork.turn} at ${fork.promptTokens} tokens, image \`${fork.image}\`, session holds ${fork.sessionAssistantMessages ?? "?"} assistant messages${fork.toolStartedDuringCommit ? ", tool started during commit" : ""}` : "not reached"}\n` : ""}- ProgramBench score: ${forkTokens ? `fork ${summary.scores.fork?.toFixed(4) ?? "—"} · ` : ""}final ${summary.scores.final?.toFixed(4) ?? "—"} · last commit ${summary.scores.head?.toFixed(4) ?? "—"}
${summary.errors.length > 0 ? `- Errors: ${summary.errors.join("; ")}\n` : ""}
| Request size | First turn | Segment | Elapsed |
|---|---|---|---|
${crossings.join("\n")}
`;
}

function formatDuration(seconds: number): string {
	const hours = Math.floor(seconds / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	return hours > 0
		? `${hours}h${minutes.toString().padStart(2, "0")}m`
		: `${minutes}m${(seconds % 60).toString().padStart(2, "0")}s`;
}
