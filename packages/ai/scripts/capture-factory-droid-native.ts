#!/usr/bin/env bun
/**
 * Capture the native Droid CLI's inference requests for every parity case.
 *
 *   bun packages/ai/scripts/capture-factory-droid-native.ts --droid <path-to-droid-binary>
 *
 * Runs the CLI for real, using its own login (`droid` → `/login`), through an
 * in-process pass-through proxy set as `FACTORY_API_BASE_URL`. Every call is
 * forwarded to Factory unchanged except the feature-flags response, whose
 * `configs.provider_routing` pins the case's upstream. Each case is a real tool
 * round trip (read a file, answer with its contents), so the recording covers
 * both the opening request and the follow-up that carries the tool result.
 * Only the dialect projection is written, to
 * `test/fixtures/factory-droid-native-requests.json`; credentials and
 * conversation content never leave the process. Every case spends Factory
 * credits and creates a session on the account.
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

const { values } = parseArgs({
	options: {
		droid: { type: "string" },
		origin: { type: "string", default: "https://api.factory.ai" },
		out: {
			type: "string",
			default: path.join(import.meta.dir, "../test/fixtures/factory-droid-native-requests.json"),
		},
	},
});
if (!values.droid) throw new Error("--droid <path-to-droid-binary> is required");
const droid = path.resolve(values.droid);

const NONCE = "nonce-7f3a91";
const PROMPT = "Use the Read tool to read probe.txt in the current directory, then reply with exactly its contents.";
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

let current: NativeCase | undefined;
let requests: NativeRequest[] = [];

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
			requests.push(projectNativeRequest(url.pathname, Object.fromEntries(request.headers), json));
		}
		const upstream = await fetch(`${values.origin}${url.pathname}${url.search}`, {
			method: request.method,
			headers: forwardableHeaders(request.headers),
			body,
		});
		let text = await upstream.text();
		if (url.pathname === "/api/feature-flags" && upstream.ok && current) {
			const flags = JSON.parse(text);
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

const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "droid-native-capture-"));
await Bun.write(path.join(workdir, "probe.txt"), `${NONCE}\n`);
const captures: NativeCapture[] = [];
try {
	for (const testCase of NATIVE_CASES) {
		current = testCase;
		requests = [];
		const child = Bun.spawn([droid, "exec", "-m", testCase.model, "-r", testCase.effort, PROMPT], {
			cwd: workdir,
			env: {
				...process.env,
				FACTORY_API_BASE_URL: server.url.origin,
				FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
				FACTORY_OTEL_ENABLED: "false",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		await child.exited;
		const label = `${testCase.model}@${testCase.upstream} ${testCase.effort}`;
		const [opening, followUp] = requests;
		if (!stdout.includes(NONCE) || !opening || !followUp) {
			console.error(`skipped ${label}: ${(stderr || stdout).trim() || `${requests.length} inference requests`}`);
			continue;
		}
		captures.push({ ...testCase, requests: [opening, followUp] });
		console.error(`captured ${label}`);
	}
} finally {
	server.stop(true);
	await fs.rm(workdir, { recursive: true, force: true });
}

await Bun.write(values.out, `${JSON.stringify(captures, null, "\t")}\n`);
console.error(`wrote ${captures.length}/${NATIVE_CASES.length} cases to ${values.out}`);
