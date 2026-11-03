/**
 * What a stdio MCP server's exit report carries, and to which connection it goes.
 * When a server's stdout ends, the transport rejects the pending requests with the
 * exit code and the end of stderr. These tests drive real subprocesses and pipes:
 * pipe chunking, process reaping and the transport's close deadline are the subject,
 * so fake timers cannot stand in for them.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { connectToServer } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { formatMCPToolFailure, MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { StdioTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/stdio";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { $which, removeWithRetries } from "@oh-my-pi/pi-utils";

const PYTHON = Bun.env.PYTHON ?? $which("python3");
/** Each test spawns real children; on a loaded host their startup alone can take seconds. */
const TEST_TIMEOUT_MS = 60_000;

/**
 * Arguments for a python3 stand-in server. It answers `warm` with `{}`; for any
 * other request it runs `onRequest`, python statements with the request bound to `r`.
 */
function server(onRequest: string): string[] {
	const body = onRequest
		.split("\n")
		.map(line => ` ${line}`)
		.join("\n");
	return [
		"-u",
		"-c",
		[
			"import json,os,subprocess,sys,time",
			"for line in sys.stdin:",
			" r=json.loads(line)",
			" if r['method']=='warm':",
			"  print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':{}}),flush=True)",
			"  continue",
			body,
		].join("\n"),
	];
}

/** Python statements that write each string to stderr as its own write, pausing between them. */
function stderrWrites(writes: readonly string[]): string {
	return writes.map(text => `os.write(2,${JSON.stringify(text)}.encode());time.sleep(.05)`).join("\n");
}

async function transportRejection(promise: Promise<unknown>): Promise<MCPTransportError> {
	const outcome = await promise.then(
		value => new Error(`Expected a rejection, got ${JSON.stringify(value)}`),
		(error: unknown) => error,
	);
	if (!(outcome instanceof MCPTransportError)) throw outcome;
	return outcome;
}

/** Waits for a file a child writes; the child's own progress is the only signal. */
async function waitForFile(file: string): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (!(await Bun.file(file).exists())) {
		if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
		await Bun.sleep(5);
	}
}

async function killPidFrom(file: string): Promise<void> {
	try {
		process.kill(Number(await Bun.file(file).text()), "SIGKILL");
	} catch {
		// Never written, or already gone.
	}
}

async function withTransport<T>(
	config: Omit<MCPStdioServerConfig, "type">,
	body: (transport: StdioTransport) => Promise<T>,
): Promise<T> {
	const transport = new StdioTransport({ type: "stdio", timeout: 0, ...config });
	try {
		await transport.connect();
		await transport.request("warm");
		return await body(transport);
	} finally {
		await transport.close();
	}
}

describe.skipIf(process.platform === "win32" || !PYTHON)("StdioTransport exit report", () => {
	const python = PYTHON ?? "python3";

	for (const { shape, secret, writes } of [
		{
			shape: "a key whose value follows 1,200 spaces",
			secret: "SYNTHETIC_WHOLE_SECRET",
			writes: [`api_key=${" ".repeat(1_200)}SYNTHETIC_WHOLE_SECRET; context=${"x".repeat(100)}\n`],
		},
		{
			shape: "a key whose value follows more spaces than the report keeps",
			secret: "SYNTHETIC_WHOLE_SECRET",
			writes: [`api_key=${" ".repeat(2_300)}SYNTHETIC_WHOLE_SECRET; context=${"x".repeat(100)}\n`],
		},
		{
			shape: "a bearer token longer than the report",
			secret: "SYNTHETIC_CREDENTIAL_CANARY",
			writes: [`Authorization: Bearer ${"SYNTHETIC_CREDENTIAL_CANARY.".repeat(100)}\n`],
		},
		{
			shape: "a key and its value written separately",
			secret: "SYNTHETIC_SPLIT_SECRET",
			writes: [`api_key=${" ".repeat(3_000)}`, `SYNTHETIC_SPLIT_SECRET; context=${"x".repeat(100)}\n`],
		},
		// Round 3: a key that starts after a long word, so any per-word cut would split its label.
		{
			shape: "a key whose label starts 250 characters into a word",
			secret: "SYNTHETIC_PRIVATE_CANARY",
			writes: [`${"x".repeat(250)}api_key= SYNTHETIC_PRIVATE_CANARY\n`],
		},
		{
			shape: "a key whose `=` is the 257th character of a word",
			secret: "SYNTHETIC_PRIVATE_CANARY",
			writes: [`${"x".repeat(249)}api_key= SYNTHETIC_PRIVATE_CANARY\n`],
		},
		{
			shape: "a credential query parameter after a long URL",
			secret: "SYNTHETIC_PRIVATE_CANARY",
			writes: [`GET https://example.invalid/${"a".repeat(400)}?api_key=SYNTHETIC_PRIVATE_CANARY failed\n`],
		},
	]) {
		it(
			`redacts ${shape} before cutting stderr`,
			async () => {
				const args = server(`${stderrWrites(writes)}\nsys.exit(77)`);
				const error = await withTransport({ command: python, args }, transport =>
					transportRejection(transport.request("tools/call")),
				);

				expect(formatMCPToolFailure(error, "wrapper", "tool")).not.toContain(secret);
				expect(error.code).toBe(77);
				// Redacted in place, or the whole word omitted for its length.
				expect(error.message).toMatch(/\[redacted\]|word omitted\]/);
			},
			TEST_TIMEOUT_MS,
		);
	}

	for (const { shape, secret, writes } of [
		{
			shape: "a key whose value follows more spaces than one kept line",
			secret: "SYNTHETIC_OMITTED_SECRET",
			writes: [`api_key=${" ".repeat(20_000)}SYNTHETIC_OMITTED_SECRET\n`, "REFUSED\n"],
		},
		{
			shape: "a key ending a line too long to keep, its value on the next line",
			secret: "SYNTHETIC_NEXT_LINE_SECRET",
			writes: [`${"x".repeat(20_000)} api_key=${" ".repeat(20_000)}\n`, "SYNTHETIC_NEXT_LINE_SECRET\n", "REFUSED\n"],
		},
		{
			shape: "a bearer label ending a line too long to keep, its token on the next line",
			secret: "SYNTHETIC_NEXT_LINE_TOKEN",
			writes: [`${"x".repeat(20_000)} Authorization: Bearer\n`, "SYNTHETIC_NEXT_LINE_TOKEN\n", "REFUSED\n"],
		},
		// Round 4: the redactor finds a value across whitespace-only lines too.
		{
			shape: "a bearer label ending a line too long to keep, a blank line, then its token",
			secret: "SYNTHETIC_CHAINED_TOKEN",
			writes: [`${"x".repeat(20_000)} Authorization: Bearer\n`, "   \n", "SYNTHETIC_CHAINED_TOKEN\n", "REFUSED\n"],
		},
		{
			shape: "a key ending a line too long to keep, two blank lines, then its value",
			secret: "SYNTHETIC_CHAINED_SECRET",
			writes: [`${"x".repeat(20_000)} api_key=\n`, "\n", "  \n", "SYNTHETIC_CHAINED_SECRET\n", "REFUSED\n"],
		},
		{
			shape: "a bearer label on a line dropped for room, a blank line, then its token",
			secret: "SYNTHETIC_CHAINED_TOKEN",
			writes: [
				"Authorization: Bearer\n",
				" \n",
				"SYNTHETIC_CHAINED_TOKEN\n",
				...Array.from({ length: 20 }, (_, index) => `filler ${index} ${"y".repeat(1_000)}\n`),
				"REFUSED\n",
			],
		},
		// Round 4 (second arm): an incomplete label, an omission between label and
		// value, CR-only line ends, CRLF split across writes, Unicode whitespace.
		{
			shape: "a key name ending a line too long to keep, `=` and its value on the next line",
			secret: "SYNTHETIC_R4_CANARY",
			writes: [`${"x".repeat(17_000)} api_key\n`, "= SYNTHETIC_R4_CANARY\n", "REFUSED\n"],
		},
		{
			shape: "a key, more blank space than one line holds, then its value",
			secret: "SYNTHETIC_R4_CANARY",
			writes: ["api_key=\n", `${" ".repeat(17_000)}\n`, "SYNTHETIC_R4_CANARY\n", "REFUSED\n"],
		},
		{
			shape: "a bearer label and its token split by a CRLF across writes",
			secret: "SYNTHETIC_R4_CANARY",
			writes: [`${"x".repeat(17_000)} Authorization: Bearer\r`, "\nSYNTHETIC_R4_CANARY\r\n", "REFUSED\r\n"],
		},
		{
			shape: "a key and its value separated by Unicode spaces",
			secret: "SYNTHETIC_R4_CANARY",
			writes: [`${"x".repeat(17_000)} api_key=\u00a0\u2003\n`, "\u3000SYNTHETIC_R4_CANARY\n", "REFUSED\n"],
		},
		{
			shape: "a bearer label on a line dropped for room, its token on the next line",
			secret: "SYNTHETIC_NEXT_LINE_TOKEN",
			writes: [
				"Authorization: Bearer\n",
				"SYNTHETIC_NEXT_LINE_TOKEN\n",
				...Array.from({ length: 20 }, (_, index) => `filler ${index} ${"y".repeat(1_000)}\n`),
				"REFUSED\n",
			],
		},
	]) {
		it(
			`never shows a credential whose label it no longer holds: ${shape}`,
			async () => {
				const args = server(`${stderrWrites(writes)}\nsys.exit(77)`);
				const error = await withTransport({ command: python, args }, transport =>
					transportRejection(transport.request("tools/call")),
				);

				expect(formatMCPToolFailure(error, "wrapper", "tool")).not.toContain(secret);
				expect(error.code).toBe(77);
				expect(error.message).toEndWith("REFUSED");
			},
			TEST_TIMEOUT_MS,
		);
	}

	// Round 5: the advice took the report's room and the error then removed it,
	// leaving no reason at all.
	// Round 6: two or more hints left one to take the room, and the error then removed it.
	// Round 7: hints enough to pass the internal buffer pushed the reason out of it.
	for (const hints of [1, 2, 3, 420, 1_000]) {
		it(
			`keeps a long reason that ${hints} runtime-only fetch hint${hints === 1 ? "" : "s"} follow`,
			async () => {
				const reason = `REFUSED: ${"word ".repeat(175)}FINAL_REASON`;
				const advice = "For more information, pass `verbose: true` in the second argument to fetch().";
				const args = server(`${stderrWrites([`${reason}\n${`${advice}\n`.repeat(hints)}`])}\nsys.exit(77)`);
				const error = await withTransport({ command: python, args }, transport =>
					transportRejection(transport.request("tools/call")),
				);

				expect(error.code).toBe(77);
				expect(error.message).toEndWith("FINAL_REASON");
				expect(error.message).not.toContain("verbose: true");
			},
			TEST_TIMEOUT_MS,
		);
	}

	// Round 8: dropping each hint as it completed also dropped hints that more
	// text followed, and hints joined without whitespace slipped past it.
	it(
		"keeps text that follows a fetch hint",
		async () => {
			const advice = "For more information, pass `verbose: true` in the second argument to fetch().";
			const args = server(`${stderrWrites([`${advice} THIS_IS_NOT_TRAILING_ADVICE\n`])}\nsys.exit(77)`);
			const error = await withTransport({ command: python, args }, transport =>
				transportRejection(transport.request("tools/call")),
			);

			expect(error.message).toContain(`${advice} THIS_IS_NOT_TRAILING_ADVICE`);
		},
		TEST_TIMEOUT_MS,
	);

	for (const joiner of ["", "."]) {
		it(
			`keeps the reason before 1000 fetch hints joined by ${joiner ? "periods" : "nothing"}`,
			async () => {
				const advice = "For more information, pass `verbose: true` in the second argument to fetch()";
				const hints = `${advice}${joiner}`.repeat(1_000);
				const args = server(`${stderrWrites([`REFUSAL_REASON_CANARY\n${hints}\n`])}\nsys.exit(77)`);
				const error = await withTransport({ command: python, args }, transport =>
					transportRejection(transport.request("tools/call")),
				);

				expect(error.message).toEndWith("REFUSAL_REASON_CANARY");
			},
			TEST_TIMEOUT_MS,
		);
	}

	// Round 9: a hint cut off at the end (a process stopped while writing it)
	// kept the complete hints before it from being dropped.
	for (const hints of [3, 520]) {
		it(
			`keeps the reason before ${hints} fetch hints and one cut off at the end`,
			async () => {
				const advice = "For more information, pass `verbose: true` in the second argument to fetch().";
				const args = server(
					`${stderrWrites([`REFUSAL_REASON_CANARY\n${`${advice}\n`.repeat(hints)}${advice.slice(0, 30)}`])}\nsys.exit(77)`,
				);
				const error = await withTransport({ command: python, args }, transport =>
					transportRejection(transport.request("tools/call")),
				);

				expect(error.message).toEndWith("REFUSAL_REASON_CANARY");
			},
			TEST_TIMEOUT_MS,
		);
	}

	// Round 11: a cut-off hint between complete ones (`H + "F" + H`) survived
	// the report's pass and took the reason's room; the error then removed it.
	for (const [name, between] of [
		["F", "F"],
		["For", "For"],
		["F on its own line", "\nF\n"],
		["a 30-character piece", "\nFor more information, pass `ver\n"],
	] as const) {
		it(
			`keeps the reason before a hint, ${name} and a hint`,
			async () => {
				const advice = "For more information, pass `verbose: true` in the second argument to fetch()";
				const reason = `REFUSED: ${"word ".repeat(175)}FINAL_REASON_CANARY`;
				const args = server(`${stderrWrites([`${reason}\n${advice}${between}${advice}`])}\nsys.exit(77)`);
				const error = await withTransport({ command: python, args }, transport =>
					transportRejection(transport.request("tools/call")),
				);

				expect(error.code).toBe(77);
				expect(error.message).toEndWith("FINAL_REASON_CANARY");
			},
			TEST_TIMEOUT_MS,
		);
	}

	// Round 12: past the 32 KiB buffer, the kept text ended in a hint, a cut-off
	// piece and a hint still being written; the trim saw no hint run there and cut
	// the reason away.
	for (const [count, between] of [
		[420, "F"],
		[1_100, "F"],
		[520, "\nF\n"],
		[420, "\nFor more information, pass `ver\n"],
	] as const) {
		it(
			`keeps the reason before ${count} hints each followed by ${JSON.stringify(between)}`,
			async () => {
				const advice = "For more information, pass `verbose: true` in the second argument to fetch()";
				const reason = `REFUSED: ${"word ".repeat(175)}FINAL_REASON_CANARY`;
				const args = server(
					`${stderrWrites([`${reason}\n${`${advice}${between}`.repeat(count)}${advice}`])}\nsys.exit(77)`,
				);
				const error = await withTransport({ command: python, args }, transport =>
					transportRejection(transport.request("tools/call")),
				);

				expect(error.code).toBe(77);
				expect(error.message).toEndWith("FINAL_REASON_CANARY");
			},
			TEST_TIMEOUT_MS,
		);
	}

	// Round 11: 1 MiB of "ff " on stderr cost a healthy server's request about
	// 3 s of this process's CPU (each word searched for a hint), past a 1 s deadline.
	for (const word of ["noise", "ff", "ffff)", "F", "For"]) {
		it(
			`spends little CPU on a MiB of stderr words like ${JSON.stringify(word)}`,
			async () => {
				const chunk = `${word} `.repeat(Math.floor(8192 / (word.length + 1)));
				const count = Math.ceil((1024 * 1024) / chunk.length);
				const args = server(`for _ in range(${count}): os.write(2,${JSON.stringify(chunk)}.encode())
print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':{'ok':True}}),flush=True)`);
				await withTransport({ command: python, args }, async transport => {
					const started = process.cpuUsage();
					const result = await transport.request<{ ok: boolean }>("logs");
					expect(result).toEqual({ ok: true });
					const used = process.cpuUsage(started);
					expect((used.user + used.system) / 1000).toBeLessThan(1_500);
				});
			},
			TEST_TIMEOUT_MS,
		);
	}

	it(
		"keeps text that only looks like the start of a hint",
		async () => {
			const args = server(`${stderrWrites(["REFUSED for"])}\nsys.exit(77)`);
			const error = await withTransport({ command: python, args }, transport =>
				transportRejection(transport.request("tools/call")),
			);

			expect(error.message).toEndWith("REFUSED for");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps the final refusal after many carriage-return-only lines",
		async () => {
			const args = server(`${stderrWrites([`${"noise\r".repeat(3_000)}FINAL_REFUSAL_CANARY\r`])}\nsys.exit(77)`);
			const error = await withTransport({ command: python, args }, transport =>
				transportRejection(transport.request("tools/call")),
			);

			expect(error.code).toBe(77);
			expect(error.message).toEndWith("FINAL_REFUSAL_CANARY");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"shows no long value of a form the redactor does not know (a JSON-quoted key)",
		async () => {
			const value = `SYNTHETIC_JSON_${"v".repeat(512)}`;
			const args = server(`${stderrWrites([`{"api_key":"${value}"}\n`, "REFUSED\n"])}\nsys.exit(77)`);
			const error = await withTransport({ command: python, args }, transport =>
				transportRejection(transport.request("tools/call")),
			);

			expect(formatMCPToolFailure(error, "wrapper", "tool")).not.toContain(value.slice(0, 300));
			expect(error.message).toEndWith("REFUSED");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps the final refusal after a stderr line longer than the report",
		async () => {
			const args = server(`${stderrWrites([`${"x".repeat(1_500)} FINAL_REFUSAL_CANARY\n`])}\nsys.exit(77)`);
			const error = await withTransport({ command: python, args }, transport =>
				transportRejection(transport.request("tools/call")),
			);

			expect(error.code).toBe(77);
			expect(error.message).toEndWith("FINAL_REFUSAL_CANARY");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps the whole last line of many stderr lines",
		async () => {
			const lines = Array.from({ length: 50 }, (_, index) => `line ${index}: ${"x".repeat(30)}\n`).join("");
			const args = server(`${stderrWrites([lines])}\nsys.exit(77)`);
			const error = await withTransport({ command: python, args }, transport =>
				transportRejection(transport.request("tools/call")),
			);

			expect(error.code).toBe(77);
			expect(error.message).toEndWith(`line 49: ${"x".repeat(30)}`);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"reports an incomplete UTF-8 sequence at the end of stderr as a replacement character",
		async () => {
			const args = server("os.write(2,b'partial: \\xe2\\x82');sys.exit(77)");
			const error = await withTransport({ command: python, args }, transport =>
				transportRejection(transport.request("tools/call")),
			);

			expect(error.code).toBe(77);
			expect(error.message).toEndWith("partial: \uFFFD");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"does not let an old process's report close the connection opened after close()",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stdio-generation-"));
			const holderPid = path.join(root, "holder.pid");
			// The old server leaves a descendant holding its stderr open, so its report
			// waits out the close deadline while the transport is closed and reconnected.
			const config: MCPStdioServerConfig = {
				type: "stdio",
				command: python,
				args: server(
					[
						"holder=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,start_new_session=True)",
						`open(${JSON.stringify(holderPid)},'w').write(str(holder.pid))`,
						"os.write(2,b'OLD_PROCESS_REFUSAL\\n');sys.exit(77)",
					].join("\n"),
				),
				timeout: 0,
			};
			const transport = new StdioTransport(config);
			let closes = 0;
			transport.onClose = () => {
				closes++;
			};
			try {
				await transport.connect();
				await transport.request("warm");
				const first = transportRejection(transport.request("fail"));
				await waitForFile(holderPid);
				// The old server exits right after writing the pid; let its stdout end so
				// the report is being collected when close() runs.
				await Bun.sleep(300);
				await transport.close();
				await first;

				config.args = server(
					"time.sleep(2) if r['method']=='slow' else None\nprint(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':'NEW_OK'}),flush=True)",
				);
				await transport.connect();
				await transport.request("warm");
				expect(await transport.request<string>("slow")).toBe("NEW_OK");
				expect(transport.connected).toBe(true);
				expect(closes).toBe(1);
			} finally {
				await transport.close();
				await killPidFrom(holderPid);
				await removeWithRetries(root);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"does not put an old process's stderr into the report of the connection opened after close()",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stdio-old-stderr-"));
			const holderPid = path.join(root, "holder.pid");
			const trigger = path.join(root, "trigger");
			const written = path.join(root, "written");
			// A descendant of the old server keeps its stderr and writes there on cue,
			// after the transport has reconnected to a new server. Once the transport
			// stops reading that pipe, the write fails; the cue is answered either way.
			const holder = [
				"import os,time",
				`while not os.path.exists(${JSON.stringify(trigger)}): time.sleep(.01)`,
				"try: os.write(2,b'OLD_DESCENDANT_LINE\\n')",
				"except OSError: pass",
				`open(${JSON.stringify(written)},'w').close()`,
				"time.sleep(10)",
			].join("\n");
			const config: MCPStdioServerConfig = {
				type: "stdio",
				command: python,
				args: server(
					[
						`holder=subprocess.Popen([sys.executable,'-c',${JSON.stringify(holder)}],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,start_new_session=True)`,
						`open(${JSON.stringify(holderPid)},'w').write(str(holder.pid))`,
						"print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':'STARTED'}),flush=True)",
					].join("\n"),
				),
				timeout: 0,
			};
			const transport = new StdioTransport(config);
			try {
				await transport.connect();
				await transport.request("warm");
				expect(await transport.request<string>("start-holder")).toBe("STARTED");
				await transport.close();

				config.args = server(`${stderrWrites(["NEW_REFUSAL\n"])}\nsys.exit(77)`);
				await transport.connect();
				await transport.request("warm");
				await Bun.write(trigger, "");
				await waitForFile(written);
				const error = await transportRejection(transport.request("tools/call"));

				expect(error.code).toBe(77);
				expect(error.message).toEndWith("NEW_REFUSAL");
				expect(error.message).not.toContain("OLD_DESCENDANT_LINE");
			} finally {
				await transport.close();
				await killPidFrom(holderPid);
				await removeWithRetries(root);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"reports an exit the client handshake deadline finds already being collected",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stdio-handshake-"));
			const trigger = path.join(root, "trigger");
			const deadlineMs = 5_000;
			try {
				// On cue, a second before the handshake deadline, the server closes stdout,
				// prints its refusal and exits 1.2 s later: the deadline passes while the
				// transport waits for that exit, inside its 1.5 s close deadline.
				const pending = connectToServer("wrapper", {
					type: "stdio",
					command: python,
					args: [
						"-u",
						"-c",
						`import os,sys,time\nsys.stdin.readline()\nwhile not os.path.exists(${JSON.stringify(trigger)}): time.sleep(.01)\nos.close(1);os.write(2,b'CLIENT_REFUSAL\\n');time.sleep(1.2);sys.exit(77)`,
					],
					timeout: deadlineMs,
				}).then(
					() => new Error("Expected the handshake to fail"),
					(error: unknown) => error,
				);
				// The cue must follow the real handshake clock, which fake timers cannot drive.
				await Bun.sleep(deadlineMs - 1_000);
				await Bun.write(trigger, "");
				const outcome = await pending;
				if (!(outcome instanceof MCPTransportError)) throw outcome;

				expect(outcome.code).toBe(77);
				expect(outcome.message).toEndWith("CLIENT_REFUSAL");
			} finally {
				await removeWithRetries(root);
			}
		},
		TEST_TIMEOUT_MS,
	);

	// Round 12: a failed handshake write had started the wait for the exit report, but
	// the client's handshake deadline waited only once stdout had ended, so it
	// replaced the report with a bare timeout.
	it(
		"reports the exit of a server whose stdin closed before the handshake was written",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stdio-epipe-"));
			const ready = path.join(root, "stdin-closed");
			// The server must close stdin before omp writes `initialize`, an order a real
			// spawn cannot guarantee: start it here, wait for it, and hand it to the transport.
			const child = Bun.spawn(
				[
					python,
					"-u",
					"-c",
					`import os,sys,time\nos.close(0);open(${JSON.stringify(ready)},'w').close();os.write(2,b'FAILED_WRITE_REFUSAL\\n');time.sleep(1.0);sys.exit(77)`,
				],
				{ stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true },
			);
			try {
				await waitForFile(ready);
				const spawn = vi.spyOn(Bun, "spawn").mockReturnValueOnce(child);
				try {
					const outcome = await connectToServer("wrapper", { type: "stdio", command: python, timeout: 200 }).then(
						() => new Error("Expected the handshake to fail"),
						(error: unknown) => error,
					);
					if (!(outcome instanceof MCPTransportError)) throw outcome;

					expect(outcome.code).toBe(77);
					expect(outcome.message).toEndWith("FAILED_WRITE_REFUSAL");
				} finally {
					spawn.mockRestore();
				}
			} finally {
				if (child.exitCode === null) child.kill("SIGKILL");
				await child.exited;
				await removeWithRetries(root);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"bounds a failed write and the following end of stdout by one close deadline",
		async () => {
			// The server stops reading at once, so a large request fails to write; its
			// stdout ends 1.4 s later and it exits 1.4 s after that. One 1.5 s deadline
			// from the failed write ends the wait long before the exit.
			const config: MCPStdioServerConfig = {
				type: "stdio",
				command: python,
				args: [
					"-u",
					"-c",
					"import json,os,sys,time\nr=json.loads(sys.stdin.readline());os.close(0);print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':{}}),flush=True);time.sleep(1.4);os.close(1);os.write(2,b'AFTER_EOF\\n');time.sleep(1.4);sys.exit(77)",
				],
				timeout: 0,
			};
			await withTransport(config, async transport => {
				const started = performance.now();
				const error = await transportRejection(transport.request("later", { bulk: "x".repeat(2_000_000) }));
				const elapsed = performance.now() - started;

				expect(error.message).toEndWith("AFTER_EOF");
				expect(elapsed).toBeLessThan(2_300);
			});
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"lets an explicit abort win while the exit report is being collected",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stdio-abort-"));
			const closed = path.join(root, "closed");
			const args = server(
				`os.close(1);open(${JSON.stringify(closed)},'w').close();os.write(2,b'TOO_LATE\\n');time.sleep(10)`,
			);
			try {
				await withTransport({ command: python, args }, async transport => {
					const caller = new AbortController();
					const reason = new Error("USER_CANCELLED");
					const pending = transport.request("tools/call", {}, { signal: caller.signal }).then(
						() => undefined,
						(error: unknown) => error,
					);
					await waitForFile(closed);
					caller.abort(reason);

					expect(await pending).toBe(reason);
				});
			} finally {
				await removeWithRetries(root);
			}
		},
		TEST_TIMEOUT_MS,
	);
});
