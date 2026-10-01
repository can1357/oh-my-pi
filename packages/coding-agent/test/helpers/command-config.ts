import * as fs from "node:fs";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

/**
 * Synthetic `!command` credential helpers for registry tests. Each command
 * embeds the caller's temp paths, so process-global command state never
 * leaks between tests.
 */

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function nodeScript(script: string): string {
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

/** Command that always prints `value`. */
export function stdoutCommand(value: string): string {
	if (process.platform !== "win32") return `printf %s ${shellQuote(value)}`;
	return nodeScript(`process.stdout.write(${JSON.stringify(value)})`);
}

/** Command that records each run in `counterFile`, then prints `tokenFile` (exit 1 when it reads `FAIL`). */
export function trackedTokenCommand(tokenFile: string, counterFile: string): string {
	if (process.platform !== "win32") {
		return `IFS= read -r token < ${shellQuote(tokenFile)}; printf 1 >> ${shellQuote(counterFile)}; [ "$token" = FAIL ] && exit 1; printf %s "$token"`;
	}
	return nodeScript(
		`const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(counterFile)}, "1");const token=fs.readFileSync(${JSON.stringify(tokenFile)}, "utf8").trim();if(token==="FAIL")process.exit(1);process.stdout.write(token);`,
	);
}

/** Command that records every run, exits nonzero, and never prints stdout. */
export function failedTrackingCommand(counterFile: string): string {
	if (process.platform !== "win32") return `printf 1 >> ${shellQuote(counterFile)}; exit 1`;
	return nodeScript(
		`const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(counterFile)}, "1");process.exit(1);`,
	);
}

/** Command whose first run exits 1 with no output; later runs print `<key>-<run number>`. */
export function failOnceCommand(counterFile: string, key: string): string {
	if (process.platform !== "win32") {
		return `printf 1 >> ${shellQuote(counterFile)}; n=$(wc -c < ${shellQuote(counterFile)}); [ $n -le 1 ] && exit 1; printf %s ${shellQuote(key)}-$n`;
	}
	return nodeScript(
		`const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(counterFile)}, "1");const n=fs.readFileSync(${JSON.stringify(counterFile)}, "utf8").length;if(n<=1)process.exit(1);process.stdout.write(${JSON.stringify(key)}+"-"+n);`,
	);
}

/** Credential helper that mints a new value on every run: `<prefix>-<run number>`. */
export function mintingCommand(counterFile: string, prefix: string): string {
	if (process.platform !== "win32") {
		return `printf 1 >> ${shellQuote(counterFile)}; n=$(wc -c < ${shellQuote(counterFile)}); printf %s ${shellQuote(prefix)}-$n`;
	}
	return nodeScript(
		`const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(counterFile)}, "1");const n=fs.readFileSync(${JSON.stringify(counterFile)}, "utf8").length;process.stdout.write(${JSON.stringify(prefix)}+"-"+n);`,
	);
}

/** Command that prints the *current* trimmed contents of `file` on each run. */
export function stdoutFileCommand(file: string): string {
	if (process.platform !== "win32") return `IFS= read -r t < ${shellQuote(file)}; printf %s "$t"`;
	return nodeScript(
		`const fs=require("node:fs");process.stdout.write(fs.readFileSync(${JSON.stringify(file)}, "utf8").trim());`,
	);
}

/** How many times a tracking command recorded a run in `counterFile`. */
export function runCount(counterFile: string): number {
	return fs.readFileSync(counterFile, "utf8").length;
}

/**
 * POSIX command that records its run, touches `startedFile`, waits for
 * `releaseFile`, then prints `tokenFile`; run number `failingRun` exits 1
 * instead. The test opens the gate, so no elapsed-time assumption.
 */
export function gatedTokenCommand(
	tokenFile: string,
	counterFile: string,
	startedFile: string,
	releaseFile: string,
	failingRun: number,
): string {
	return `printf 1 >> ${shellQuote(counterFile)}; n=$(wc -c < ${shellQuote(counterFile)}); : > ${shellQuote(startedFile)}; until [ -f ${shellQuote(releaseFile)} ]; do sleep 0.01; done; [ $n -eq ${failingRun} ] && exit 1; IFS= read -r token < ${shellQuote(tokenFile)}; printf %s "$token"`;
}

/** Resolve once `file` exists. */
export async function waitForFile(file: string): Promise<void> {
	const done = Promise.withResolvers<void>();
	const watcher = fs.watch(path.dirname(file), (_event, name) => {
		if (name === path.basename(file)) done.resolve();
	});
	try {
		if (!(await Bun.file(file).exists())) await done.promise;
	} finally {
		watcher.close();
	}
}

/** Minimal successful chat-completions SSE stream for the openai-completions provider. */
export function okChatCompletionStream(): Response {
	const chunks = [
		JSON.stringify({
			id: "cmpl",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
		}),
		JSON.stringify({
			id: "cmpl",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		}),
		"[DONE]",
	];
	return new Response(chunks.map(c => `data: ${c}\n\n`).join(""), {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

/** The 401 body an OpenAI-compatible server returns for a bad credential. */
export function unauthorizedResponse(): Response {
	return new Response(JSON.stringify({ error: { message: "invalid api key", type: "authentication_error" } }), {
		status: 401,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Fetch that records each request's credential headers, 401s until BOTH the
 * bearer and the tenant header carry their refreshed values, then streams a
 * successful completion.
 */
export function refreshGateFetch(seen: Array<{ auth?: string; tenant?: string }>): FetchImpl {
	return async (_url, init) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const auth = headers.Authorization;
		const tenant = headers["x-tenant-token"];
		seen.push({ auth, tenant });
		if (auth !== "Bearer fresh-bearer" || tenant !== "fresh-tenant") return unauthorizedResponse();
		return okChatCompletionStream();
	};
}
