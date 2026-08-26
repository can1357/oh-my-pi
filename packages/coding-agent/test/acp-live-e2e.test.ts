/**
 * Real-subprocess ACP end-to-end test: spawns `omp acp` as an actual child
 * process and drives it through `acp-probe` over the real JSON-RPC/ndjson
 * stdio transport -- the process/wire fidelity
 * `acp-deterministic-phase-gate.test.ts`'s fake in-process connection cannot
 * exercise (real serialization, real framing, the actual built CLI
 * entrypoint). This is not a shallow "does it start" check: every row
 * asserts byte-exact delivery (or, for `kill-mid-tool`, a genuine crash
 * recovery) through the real stack. This exists alongside (not instead of)
 * the deterministic in-process fake because that fake can never catch a wire
 * framing bug, a JSON-RPC serialization mismatch, or a defect in the actual
 * built CLI entrypoint -- only a real subprocess speaking the real transport
 * exercises those.
 *
 * `acp-probe` (github.com/marton78/acp-probe) is a separate, unpinned repo
 * cloned as a sibling of this checkout, not a dependency of this monorepo --
 * so this whole suite skips cleanly wherever that checkout is absent
 * (a fresh clone, CI). Override its location with `ACP_PROBE_DIR`, and the
 * spawned agent binary with `ACP_OMP_CMD` (defaults to the dev launcher, not
 * an installed binary, so this always exercises the current checkout's
 * source).
 *
 * Drives every row through the deterministic, zero-cost `stress-mock` model
 * (./acp-stress-mock-model.ts) by default: a real model can silently rewrite
 * the exact requested command (observed empirically -- a fast/cheap model
 * appended `> /dev/null` to a stress command "to just report the exit
 * code"), which would otherwise be indistinguishable from a real regression.
 * Set `ACP_STRESS_LIVE_PROVIDER=1` for genuine live-provider conformance
 * checking instead -- `acp-live-smoke-classifier.ts`'s HARNESS_INVALID class
 * demotes "the provider didn't call the requested tool" so nondeterministic
 * provider failures under that mode don't fail this suite.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import { classifyLiveSmoke } from "../../../scripts/acp-live-smoke-classifier";

const codingAgentDir = path.resolve(import.meta.dir, "..");
const probeDir = process.env.ACP_PROBE_DIR ?? path.join(codingAgentDir, "..", "..", "..", "acp-probe");
const ompCmd = process.env.ACP_OMP_CMD ?? path.join(codingAgentDir, "scripts", "omp");
const mockModelPath = path.join(codingAgentDir, "scripts", "acp-stress-mock-model.ts");

const probeAvailable = existsSync(path.join(probeDir, "src", "acp-probe.ts")) && existsSync(ompCmd);
const useMock = !process.env.ACP_STRESS_LIVE_PROVIDER;
const modelArgs = useMock
	? ["--arg", "--extension", "--arg", mockModelPath, "--arg", "--model", "--arg", "stress-mock/stress-mock"]
	: [];

const PROBE_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 100_000;

async function spawnProbe(args: string[], logPath: string): Promise<number> {
	const proc = Bun.spawn(
		[
			"bun",
			"run",
			"src/acp-probe.ts",
			...args,
			...modelArgs,
			"--timeout-ms",
			String(PROBE_TIMEOUT_MS),
			"--log",
			logPath,
		],
		{
			cwd: probeDir,
			env: { ...process.env, ACP_PROBE_CMD: ompCmd },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return await proc.exited;
}

// Only the fields this suite reads, from a JSON-RPC frame log written by an
// external tool (acp-probe) -- untrusted input, so it's parsed through a
// schema rather than cast, and a line that doesn't match is skipped exactly
// like a non-JSON log line (frame logs interleave plain-text `[HH:MM:SS] ...`
// entries with raw JSON-RPC frames).
const FrameUpdate = z
	.object({
		sessionUpdate: z.string(),
		rawInput: z
			.object({ command: z.string().optional(), language: z.string().optional(), code: z.string().optional() })
			.optional(),
		_meta: z.object({ terminal_output: z.object({ data: z.string().optional() }).optional() }).optional(),
		content: z
			.array(
				z.object({ content: z.object({ type: z.string().optional(), text: z.string().optional() }).optional() }),
			)
			.optional(),
	})
	.passthrough();
const FrameEnvelope = z.object({ params: z.object({ update: FrameUpdate.optional() }).optional() }).passthrough();

interface Frame {
	rawInput?: z.infer<typeof FrameUpdate>["rawInput"];
	terminalOutputData?: string;
	contentText?: string;
}

function parseFrames(logPath: string): Frame[] {
	const text = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
	const frames: Frame[] = [];
	for (const line of text.split("\n")) {
		const brace = line.indexOf("{");
		if (brace < 0) continue;
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(line.slice(brace));
		} catch {
			continue;
		}
		const envelope = FrameEnvelope.safeParse(parsedJson);
		const update = envelope.success ? envelope.data.params?.update : undefined;
		if (!update || (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")) continue;
		const frame: Frame = { rawInput: update.rawInput };
		const terminalData = update._meta?.terminal_output?.data;
		if (typeof terminalData === "string") frame.terminalOutputData = terminalData;
		for (const item of update.content ?? []) {
			if (item.content?.type === "text" && typeof item.content.text === "string") {
				frame.contentText = item.content.text;
			}
		}
		frames.push(frame);
	}
	return frames;
}

// The closed set of notice lines `renderFact`/`renderExitNotice` can emit. A tail
// line outside this set is a real regression (or a new fact that has to be added
// here on purpose), not something to be pattern-guessed away.
const NOTICE =
	/^(?:Wall time: \d+\.\d\d seconds|Command exited with code -?\d+|\[Showing lines \d+-\d+ of \d+\]|\[Showing (?:first|last) [^\]]+\]|\[Elided [^\]]+\]|\[Lines wider than \d+ bytes were truncated\]|\[Inline output capped at [^\]]+\]|\[raw output: artifact:\/\/[^\]]+\]|\[Command timed out[^\]]*\]|\[Command (?:cancelled|aborted)\]|\[terminal output discontinuity: \d+ bytes dropped before delivery\]|Timeout clamped to [^\n]+|pty requested but unavailable[^\n]*)$/;

/**
 * Drives a fixed-width *unique*-line command/code through a real `omp acp`
 * subprocess and asserts the delivered stream equals the full output exactly
 * -- strictly stronger than a floor, and immune to the false-positive
 * self-similar-filler hazard the old `stress-output` grid had (repeated
 * characters make every later chunk trivially "repeat" an earlier one on the
 * append-only check even on a legitimate delivery; see docs/acp-development.md
 * rule 7).
 *
 * `channel`: "meta" streams incrementally via `_meta.terminal_output.data`
 * (requires advertising `terminal_output`); "fenced" is the plain/
 * no-capability channel, which publishes the whole body once at settlement
 * as a fenced `content` text block -- the one gap neither this suite's meta
 * rows nor the deterministic gate's in-process test cover, since bash/eval's
 * presentation route dropped the old `ACP_TEXT_LIMIT` bound.
 */
async function runUniqueStream(
	tool: "bash" | "eval",
	channel: "meta" | "fenced",
	lines: number,
	width: number,
): Promise<void> {
	const logPath = path.join(
		os.tmpdir(),
		`acp-live-e2e-${tool}-${channel}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
	);
	const expected = Array.from({ length: lines }, (_, i) => `${String(i).padStart(width, "0")}\n`).join("");
	let prompt: string;
	let evalCode = "";
	if (tool === "eval") {
		evalCode = `for (let i = 0; i < ${lines}; i++) { print(String(i).padStart(${width}, '0')); }`;
		prompt = `Run this exact code with the eval tool (language js): ${evalCode}`;
	} else {
		const awkBody = `BEGIN{for(i=0;i<${lines};i++) printf "%0${width}d\\n", i}`;
		prompt = `Run this exact command with the bash tool, pty false: awk '${awkBody}'`;
	}
	const args = ["prompt", prompt];
	if (channel === "meta") args.push("--meta", '{"terminal_output":true}');
	const code = await spawnProbe(args, logPath);

	const frames = parseFrames(logPath);
	let toolSeen: "bash" | "eval" | undefined;
	let announcedEvalCode: string | undefined;
	const metaChunks: string[] = [];
	let lastContentText: string | undefined;
	for (const frame of frames) {
		if (toolSeen === undefined && frame.rawInput) {
			if (frame.rawInput.command !== undefined) toolSeen = "bash";
			else if (frame.rawInput.language !== undefined && frame.rawInput.code !== undefined) {
				toolSeen = "eval";
				announcedEvalCode = frame.rawInput.code;
			}
		}
		if (channel === "meta" && frame.terminalOutputData !== undefined) metaChunks.push(frame.terminalOutputData);
		if (channel === "fenced" && frame.contentText !== undefined) lastContentText = frame.contentText;
	}

	// A verdict string in `acp-live-smoke-classifier.ts`'s expected shape: it
	// exists to tell a real regression apart from a live model simply not
	// calling the requested tool (only reachable under
	// ACP_STRESS_LIVE_PROVIDER=1 -- the default deterministic mock always
	// calls the exact requested tool, so a mismatch there is a real bug, not
	// harness noise).
	let verdict: string;
	if (toolSeen !== tool) {
		verdict = `tool=${toolSeen ?? "None"} expected=${tool} exact=False tool_mismatch=True`;
	} else if (tool === "eval" && announcedEvalCode !== evalCode) {
		verdict = "tool=eval exact=False raw_input_mismatch=True";
	} else {
		let got: string;
		let bodyExpected: string;
		let sourceEchoOk = true;
		if (channel === "meta") {
			got = metaChunks.join("");
			if (tool === "eval") {
				// Eval's source echo and separator are protocol-owned data, not
				// process bytes, on the meta-terminal path specifically.
				const prefix = `${announcedEvalCode}\n${"─".repeat(48)}\n`;
				sourceEchoOk = got.startsWith(prefix);
				if (sourceEchoOk) got = got.slice(prefix.length);
			}
			bodyExpected = expected;
		} else {
			got = lastContentText ?? "";
			if (tool === "eval") {
				// The plain/fenced channel echoes the source as its own section
				// (no separator line, no fence) ahead of the fenced body -- a
				// different render path than the meta-terminal one above,
				// confirmed empirically against a real settled frame rather than
				// assumed from source.
				const prefix = `${announcedEvalCode}\n\n`;
				sourceEchoOk = got.startsWith(prefix);
				if (sourceEchoOk) got = got.slice(prefix.length);
			}
			bodyExpected = `\`\`\`\n${expected}\n\`\`\``;
		}
		const prefixOk = sourceEchoOk && got.startsWith(bodyExpected);
		const tail = prefixOk ? got.slice(bodyExpected.length) : "";
		const tailLines = tail.split("\n").filter(line => line !== "");
		const unexpected = tailLines.filter(line => !NOTICE.test(line));
		const exact = prefixOk && unexpected.length === 0;
		verdict =
			`bytes=${Buffer.byteLength(got)} want=${Buffer.byteLength(bodyExpected)} exact=${exact ? "True" : "False"}` +
			(unexpected.length > 0 ? ` unexpected=${JSON.stringify(unexpected.slice(0, 2))}` : "") +
			(sourceEchoOk ? "" : " source_echo_mismatch=True") +
			(prefixOk ? "" : " prefix=MISMATCH");
	}

	const classification = classifyLiveSmoke(code, verdict);
	if (classification === "HARNESS_INVALID") {
		console.warn(`acp live e2e (${tool}/${channel}): harness-invalid, not a regression -- ${verdict}`);
		return;
	}
	expect(classification, verdict).toBe("OK");
}

describe.skipIf(!probeAvailable)("acp live e2e (real omp subprocess, real ACP wire)", () => {
	it(
		"bash-meta: exact requested tool, raw input, and full pre-retention bytes",
		() => runUniqueStream("bash", "meta", 3000, 63),
		TEST_TIMEOUT_MS,
	);

	it(
		"eval-meta: exact requested tool, raw input, and full pre-retention bytes",
		() => runUniqueStream("eval", "meta", 3000, 63),
		TEST_TIMEOUT_MS,
	);

	it(
		"bash-fenced: same byte-equality bar, no client terminal capability advertised",
		() => runUniqueStream("bash", "fenced", 3000, 63),
		TEST_TIMEOUT_MS,
	);

	it(
		"eval-fenced: same byte-equality bar, no client terminal capability advertised",
		() => runUniqueStream("eval", "fenced", 3000, 63),
		TEST_TIMEOUT_MS,
	);

	// `kill-mid-tool`'s dangling-replay status across capability combos, with a
	// real SIGKILL -- the crash-recovery race `acp-deterministic-phase-gate
	// .test.ts`'s in-process capture (blocks on a lock file, never actually
	// kills a process) cannot reproduce.
	const combos: Record<string, string[]> = {
		none: [],
		terminal: ["--terminal"],
		meta: ["--meta", '{"terminal_output":true}'],
		both: ["--terminal", "--meta", '{"terminal_output":true}'],
	};
	for (const [combo, caps] of Object.entries(combos)) {
		it(
			`kill-mid-tool (${combo}): dangling replay reaches a terminal status after a real kill + respawn + session/load`,
			async () => {
				const logPath = path.join(os.tmpdir(), `acp-live-e2e-kill-${combo}-${Date.now()}.log`);
				const code = await spawnProbe(["kill-mid-tool", "Use the bash tool to run: sleep 20", ...caps], logPath);
				expect(code, "acp-probe exit code").toBe(0);
			},
			TEST_TIMEOUT_MS,
		);
	}
});
