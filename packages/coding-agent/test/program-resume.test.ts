import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import {
	clearProgramResume,
	disposeProgramResume,
	formatResumeClear,
	formatResumeReport,
	initProgramResume,
	reportProgramResume,
	resendProgramResume,
	resetProgramResumeForTests,
} from "@oh-my-pi/pi-coding-agent/utils/program-resume";
import { getProgramResumeToken, OSC_7577_TOKEN_ENV } from "@oh-my-pi/pi-coding-agent/utils/program-resume-token";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

const SPEC_TOKEN = "dummy-token-replace-me";
const SPEC_TIME = 1_795_543_200;

function parseOsc7577(seq: string, token: string): Record<string, string> {
	expect(seq.startsWith("\x1b]7577;")).toBe(true);
	expect(seq.endsWith("\x1b\\")).toBe(true);
	const body = seq.slice("\x1b]7577;".length, -"\x1b\\".length);
	const idx = body.lastIndexOf(":mac=");
	expect(idx).toBeGreaterThan(0);
	const prefix = body.slice(0, idx);
	const mac = body.slice(idx + ":mac=".length);
	const expected = crypto.createHash("sha256").update(`${prefix}:${token}`).digest("hex");
	expect(mac).toBe(expected);

	const map: Record<string, string> = {};
	for (const pair of prefix.split(":")) {
		const eq = pair.indexOf("=");
		expect(eq).toBeGreaterThan(0);
		map[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	return map;
}

function decodeArgv(raw: string): string[] {
	return raw.split(",").map(part => (part.length > 0 ? Buffer.from(part, "base64").toString("utf8") : ""));
}

describe("OSC 7577 program resume reporting", () => {
	let writes: string[] = [];
	let prevHeadless = false;
	let ttyDescriptor: PropertyDescriptor | undefined;
	let prevToken: string | undefined;

	beforeEach(() => {
		resetProgramResumeForTests();
		prevToken = process.env[OSC_7577_TOKEN_ENV];
		prevHeadless = setTerminalHeadless(false);
		ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		writes = [];
		spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array));
			return true;
		});
	});

	afterEach(() => {
		resetProgramResumeForTests();
		if (prevToken === undefined) delete process.env[OSC_7577_TOKEN_ENV];
		else process.env[OSC_7577_TOKEN_ENV] = prevToken;
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		setTerminalHeadless(prevHeadless);
	});

	it("matches the OSC 7577 specification test vectors byte for byte", () => {
		const nvim = formatResumeReport(
			["nvim", "-S", "/home/user/.local/state/nvim/sessions/8f2c1d.vim"],
			"/home/user/src/project",
			SPEC_TOKEN,
			{ pid: 74877, time: SPEC_TIME },
		);
		expect(nvim).toBeDefined();
		const fields = parseOsc7577(nvim!, SPEC_TOKEN);
		expect(fields.pid).toBe("74877");
		expect(fields.time).toBe(String(SPEC_TIME));
		expect(decodeArgv(fields.argv)).toEqual(["nvim", "-S", "/home/user/.local/state/nvim/sessions/8f2c1d.vim"]);
		expect(Buffer.from(fields.cwd, "base64").toString("utf8")).toBe("/home/user/src/project");

		const clear = formatResumeClear(SPEC_TOKEN, { pid: 74877, time: SPEC_TIME });
		expect(clear).toBe(
			"\x1b]7577;pid=74877:time=1795543200:clear=1:mac=c30603369f98fef581a4098be889175b0c74f0641e49f8b25f4326cb38f97c93\x1b\\",
		);
	});

	it("captures and removes OSC7577_TOKEN from process.env and reports --restore as session materializes", () => {
		process.env[OSC_7577_TOKEN_ENV] = SPEC_TOKEN;
		const state: { sessionFile: string | undefined; cwd: string; now: number } = {
			sessionFile: undefined,
			cwd: "/tmp/work-a",
			now: SPEC_TIME,
		};

		initProgramResume({
			sessionFile: () => state.sessionFile,
			cwd: () => state.cwd,
			baseCmd: () => ["/usr/local/bin/omp"],
			launchArgs: () => ["--model", "opus", "initial prompt"],
			nowSeconds: () => state.now,
		});

		// Token must be removed from process.env so child processes never inherit it.
		expect(process.env[OSC_7577_TOKEN_ENV]).toBeUndefined();
		expect(getProgramResumeToken()).toBe(SPEC_TOKEN);
		expect(writes).toHaveLength(1);
		const first = parseOsc7577(writes[0], SPEC_TOKEN);
		expect(decodeArgv(first.argv)).toEqual(["/usr/local/bin/omp", "--model", "opus"]);
		expect(Buffer.from(first.cwd, "base64").toString("utf8")).toBe("/tmp/work-a");

		// Calling again with unchanged state emits nothing.
		reportProgramResume();
		expect(writes).toHaveLength(1);

		// Once materialized on disk, reports with --restore <sessionFile>.
		state.sessionFile = "/tmp/sessions/abc.jsonl";
		state.now += 5;
		reportProgramResume();
		expect(writes).toHaveLength(2);
		const second = parseOsc7577(writes[1], SPEC_TOKEN);
		expect(decodeArgv(second.argv)).toEqual([
			"/usr/local/bin/omp",
			"--model",
			"opus",
			"--restore",
			"/tmp/sessions/abc.jsonl",
		]);

		// Moving cwd re-reports with the updated cwd.
		state.cwd = "/tmp/work-b";
		state.now += 5;
		reportProgramResume();
		expect(writes).toHaveLength(3);
		const third = parseOsc7577(writes[2], SPEC_TOKEN);
		expect(Buffer.from(third.cwd, "base64").toString("utf8")).toBe("/tmp/work-b");

		// Resending after SIGCONT emits a fresh timestamp even when command and cwd are unchanged.
		state.now += 10;
		resendProgramResume();
		expect(writes).toHaveLength(4);
		const fourth = parseOsc7577(writes[3], SPEC_TOKEN);
		expect(fourth.time).toBe(String(SPEC_TIME + 20));

		// User quit clears the record; subsequent reports are latched off.
		state.now += 1;
		clearProgramResume();
		expect(writes).toHaveLength(5);
		const cleared = parseOsc7577(writes[4], SPEC_TOKEN);
		expect(cleared.clear).toBe("1");

		state.cwd = "/tmp/work-c";
		reportProgramResume();
		expect(writes).toHaveLength(5);
	});

	it("does not clear on disposeProgramResume (/restart or non-user teardown) and clears when a command cannot be reported", () => {
		process.env[OSC_7577_TOKEN_ENV] = SPEC_TOKEN;
		let sessionFile: string | undefined = "/tmp/sessions/ok.jsonl";
		let cwd = "/tmp/work";

		initProgramResume({
			sessionFile: () => sessionFile,
			cwd: () => cwd,
			baseCmd: () => ["/usr/local/bin/omp"],
			launchArgs: () => [],
			nowSeconds: () => SPEC_TIME,
		});
		expect(writes).toHaveLength(1);

		// Unreportable command (oversized path > 2048 bytes) clears the earlier record.
		sessionFile = `/tmp/${"a".repeat(2000)}.jsonl`;
		reportProgramResume();
		expect(writes).toHaveLength(2);
		expect(parseOsc7577(writes[1], SPEC_TOKEN).clear).toBe("1");

		// Valid command reports again; disposeProgramResume latches without clearing.
		sessionFile = "/tmp/sessions/ok2.jsonl";
		reportProgramResume();
		expect(writes).toHaveLength(3);
		disposeProgramResume();
		expect(writes).toHaveLength(3);
		cwd = "/tmp/other";
		reportProgramResume();
		expect(writes).toHaveLength(3);
	});

	it("writes nothing when OSC7577_TOKEN is absent or malformed", () => {
		process.env[OSC_7577_TOKEN_ENV] = "too-short";
		initProgramResume({
			sessionFile: () => "/tmp/s.jsonl",
			cwd: () => "/tmp",
			baseCmd: () => ["/usr/local/bin/omp"],
			launchArgs: () => [],
			nowSeconds: () => SPEC_TIME,
		});
		expect(process.env[OSC_7577_TOKEN_ENV]).toBeUndefined();
		expect(writes).toHaveLength(0);
	});
});
