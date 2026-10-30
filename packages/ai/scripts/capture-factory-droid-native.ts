#!/usr/bin/env bun
/**
 * Capture the native Droid CLI's inference requests for every parity case.
 *
 *   bun packages/ai/scripts/capture-factory-droid-native.ts --droid <path-to-droid-binary> [--only <model>]
 *
 * Runs the CLI for real, using its own login (`droid` → `/login`), through an
 * in-process pass-through proxy set as `FACTORY_API_BASE_URL`. Every call is
 * forwarded to Factory unchanged except two responses: whoami drops
 * `premBaseHostV2`, which would send inference straight to that direct host
 * and around the proxy, and feature flags, whose `configs.provider_routing`
 * pins the case's upstream (and whose `flags` force on a case's `flag` when the
 * account is not yet entitled). Each case is a real
 * tool round trip (read a file, answer with its contents), so the recording
 * covers both the opening request and the follow-up that carries the tool
 * result. A `prime` case runs that round trip at the priming effort, then
 * resumes the session at the case's effort and records the resumed request,
 * whose history the round trip made thinking-led. Only the dialect projection
 * is written, to `test/fixtures/factory-droid-native-requests.json`;
 * credentials and conversation content never leave the process. Every case
 * spends Factory credits and creates a session on the account. With `--only`,
 * the selected model's cases are recaptured and merged into the existing file.
 * Any case that cannot be captured aborts the run before the corpus is written.
 * Side effect: droid caches the rewritten feature-flag and routing response in
 * its own config, so a forced `flag` or pinned upstream can outlive the run
 * until droid next refreshes flags; run `droid` once afterwards to refetch.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
	NATIVE_CASES,
	type NativeCapture,
	type NativeCase,
	type NativeRequest,
	projectNativeRequest,
} from "../test/helpers/factory-droid-native";
import capturePrompt from "./prompts/factory-droid-capture.md" with { type: "text" };
import resumePrompt from "./prompts/factory-droid-capture-resume.md" with { type: "text" };

const { values } = parseArgs({
	options: {
		droid: { type: "string" },
		origin: { type: "string", default: "https://api.factory.ai" },
		only: { type: "string", multiple: true },
		out: {
			type: "string",
			default: path.join(import.meta.dir, "../test/fixtures/factory-droid-native-requests.json"),
		},
	},
});
if (!values.droid) throw new Error("--droid <path-to-droid-binary> is required");
const droid = path.resolve(values.droid);

const NONCE = "nonce-7f3a91";
const PROMPT = capturePrompt.trim();
const RESUME_PROMPT = resumePrompt.trim();
/** Hop-by-hop and encoding headers the proxy must not copy across. */
const HOP_HEADERS = new Set([
	"host",
	"connection",
	"content-length",
	"accept-encoding",
	"content-encoding",
	"transfer-encoding",
]);

function forwardableHeaders(headers: Headers): Headers {
	const out = new Headers();
	for (const [key, value] of headers) if (!HOP_HEADERS.has(key)) out.set(key, value);
	return out;
}

interface Recorded {
	request: NativeRequest;
	/** Whether a replayed assistant turn carried thinking (raw, before projection). */
	historyThinking: boolean;
}

let current: NativeCase | undefined;
let projectHistory = false;
let requests: Recorded[] = [];

const server = Bun.serve({
	port: 0,
	idleTimeout: 255,
	async fetch(request) {
		const url = new URL(request.url);
		// The Responses WebSocket cannot upgrade through this proxy; refusing it
		// sends the CLI down its HTTP path, the transport OMP uses.
		if (url.pathname.endsWith("/ws")) return new Response(null, { status: 400 });
		const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
		if (body && url.pathname.startsWith("/api/llm/") && requests.length < 2) {
			const json = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
			const projected = projectNativeRequest(url.pathname, Object.fromEntries(request.headers), json, {
				history: true,
			});
			const historyThinking = projected.body["<history-thinking>"] === true;
			if (!projectHistory) delete projected.body["<history-thinking>"];
			requests.push({ request: projected, historyThinking });
		}
		const upstream = await fetch(`${values.origin}${url.pathname}${url.search}`, {
			method: request.method,
			headers: forwardableHeaders(request.headers),
			body,
		});
		let text = await upstream.text();
		if (url.pathname === "/api/cli/whoami" && upstream.ok) {
			const whoami = JSON.parse(text);
			delete whoami.premBaseHostV2;
			text = JSON.stringify(whoami);
		}
		if (url.pathname === "/api/feature-flags" && upstream.ok && current) {
			const flags = JSON.parse(text);
			if (current.flag) {
				flags.flags ??= {};
				flags.flags[current.flag] = true;
			}
			flags.configs ??= {};
			flags.configs.provider_routing ??= {};
			flags.configs.provider_routing.models = {
				...flags.configs.provider_routing.models,
				[current.model]: [current.upstream],
			};
			text = JSON.stringify(flags);
		}
		return new Response(text, { status: upstream.status, headers: forwardableHeaders(upstream.headers) });
	},
});

async function run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	const child = Bun.spawn([droid, "exec", ...args], {
		cwd,
		env: {
			...process.env,
			FACTORY_API_BASE_URL: server.url.origin,
			FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
			FACTORY_OTEL_ENABLED: "false",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	await child.exited;
	return { stdout, stderr };
}

/** Returns the case's recorded requests, or the reason it could not be captured. */
async function capture(testCase: NativeCase, workdir: string): Promise<NativeRequest[] | string> {
	current = testCase;
	requests = [];
	projectHistory = false;
	if (!testCase.prime) {
		const { stdout, stderr } = await run(["-m", testCase.model, "-r", testCase.effort, PROMPT], workdir);
		const [opening, followUp] = requests;
		if (!stdout.includes(NONCE) || !opening || !followUp)
			return (stderr || stdout).trim() || `${requests.length} inference requests`;
		return [opening.request, followUp.request];
	}
	const primed = await run(["-m", testCase.model, "-r", testCase.prime, "-o", "json", PROMPT], workdir);
	const followUp = requests[1];
	if (!primed.stdout.includes(NONCE) || !followUp)
		return (primed.stderr || primed.stdout).trim() || `${requests.length} priming requests`;
	if (!followUp.historyThinking) return `the ${testCase.prime} priming turn replayed no thinking`;
	const result: unknown = JSON.parse(primed.stdout);
	const sessionId =
		result && typeof result === "object" && "session_id" in result && typeof result.session_id === "string"
			? result.session_id
			: undefined;
	if (!sessionId) return "the priming run reported no session id";
	requests = [];
	projectHistory = true;
	const resumed = await run(
		["-s", sessionId, "-m", testCase.model, "-r", testCase.effort, "-o", "json", RESUME_PROMPT],
		workdir,
	);
	const [request] = requests;
	if (!resumed.stdout.includes("done") || !request)
		return (resumed.stderr || resumed.stdout).trim() || "no resumed request";
	return [request.request];
}

const label = (testCase: NativeCase) =>
	`${testCase.model}@${testCase.upstream} ${testCase.effort}${testCase.prime ? ` after ${testCase.prime}` : ""}`;

const previous: NativeCapture[] = values.only ? await Bun.file(values.out).json() : [];
const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "droid-native-capture-"));
await Bun.write(path.join(workdir, "probe.txt"), `${NONCE}\n`);
const captures: NativeCapture[] = [];
const failed: string[] = [];
try {
	for (const testCase of NATIVE_CASES) {
		if (values.only && !values.only.includes(testCase.model)) {
			const kept = previous.find(
				capture =>
					capture.model === testCase.model &&
					capture.upstream === testCase.upstream &&
					capture.effort === testCase.effort &&
					capture.prime === testCase.prime,
			);
			if (kept) captures.push(kept);
			continue;
		}
		const result = await capture(testCase, workdir);
		if (typeof result === "string") {
			console.error(`skipped ${label(testCase)}: ${result}`);
			failed.push(label(testCase));
			continue;
		}
		captures.push({ ...testCase, requests: result });
		console.error(`captured ${label(testCase)}`);
	}
} finally {
	server.stop(true);
	await fs.rm(workdir, { recursive: true, force: true });
}

if (failed.length > 0) {
	console.error(`not writing ${values.out}: ${failed.length} case(s) failed: ${failed.join(", ")}`);
	process.exit(1);
}
await Bun.write(values.out, `${JSON.stringify(captures, null, "\t")}\n`);
console.error(`wrote ${captures.length}/${NATIVE_CASES.length} cases to ${values.out}`);
