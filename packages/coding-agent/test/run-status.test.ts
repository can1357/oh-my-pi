import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import {
	disposeProgramStatus,
	initProgramStatus,
	resendProgramStatus,
	setProgramStatusEnabled,
	setRunStatus,
} from "@oh-my-pi/pi-coding-agent/utils/run-status";
import * as titleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

// OSC 7501 Program Status Protocol reports, as the terminal parses them:
// https://mitchellh.com/writing/program-status-osc7501
const report = (body: string) => `\x1b]7501;${body}\x1b\\`;
const CLEAR = report("state=clear");

/** Decode the `msg` value of a report back into the text a terminal would show. */
function decodedMsg(sequence: string): Uint8Array {
	const value = /:msg=([A-Za-z0-9+/=]+)\x1b\\$/.exec(sequence)?.[1];
	if (!value) throw new Error(`no msg in ${JSON.stringify(sequence)}`);
	return Buffer.from(value, "base64");
}

describe("run status OSC 7501 reporting", () => {
	let writes: string[] = [];
	let prevHeadless = false;
	let ttyDescriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		// The title is a separate surface with its own suite; keep its writes and spinner out of these.
		vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
		prevHeadless = setTerminalHeadless(false);
		ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		writes = [];
		spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array));
			return true;
		});
		// Order-independent baseline: the UI owns the terminal, reporting on, idle reported.
		initProgramStatus();
		setProgramStatusEnabled(true);
		setRunStatus({ state: "idle" });
		writes.length = 0;
	});

	afterEach(() => {
		disposeProgramStatus();
		vi.restoreAllMocks();
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		setTerminalHeadless(prevHeadless);
	});

	it("writes each transition as a whole root record, once, with kind only when blocked and msg as one clean line", () => {
		setRunStatus({ state: "working" });
		setRunStatus({ state: "working" });
		setRunStatus({ state: "blocked", kind: "question", msg: "\x1b[1mWhich branch?\x1b[0m\n\tmain or dev?" });
		setRunStatus({ state: "done" });
		setRunStatus({ state: "error", msg: "boom" });
		setRunStatus({ state: "error", msg: " \n " });

		expect(writes).toEqual([
			report("state=working:app=omp"),
			report(
				`state=blocked:kind=question:app=omp:msg=${Buffer.from("Which branch? main or dev?").toString("base64")}`,
			),
			report("state=done:app=omp"),
			report(`state=error:app=omp:msg=${Buffer.from("boom").toString("base64")}`),
			report("state=error:app=omp"),
		]);
	});

	it("cuts a long msg on a character boundary within the protocol's 2048-byte decoded limit", () => {
		setRunStatus({ state: "error", msg: `a${"😀".repeat(1000)}` });

		expect(writes).toHaveLength(1);
		const text = decodedMsg(writes[0]!);
		expect(text.length).toBeLessThanOrEqual(2048);
		expect(new TextDecoder("utf-8", { fatal: true }).decode(text)).toMatch(/^a😀+…$/u);
		expect(Buffer.byteLength(writes[0]!)).toBeLessThanOrEqual(4096);
	});

	it("clears the record at teardown and writes nothing more until the UI claims the terminal again", () => {
		setRunStatus({ state: "done" });
		writes.length = 0;

		disposeProgramStatus();
		setRunStatus({ state: "working" });
		resendProgramStatus();
		expect(writes).toEqual([CLEAR]);

		writes.length = 0;
		initProgramStatus();
		setRunStatus({ state: "idle" });
		expect(writes).toEqual([report("state=idle:app=omp")]);
	});

	it("clears the record when turned off and reports the current status when turned back on", () => {
		setRunStatus({ state: "working" });
		writes.length = 0;

		setProgramStatusEnabled(false);
		setRunStatus({ state: "blocked", kind: "permission" });
		setProgramStatusEnabled(true);

		expect(writes).toEqual([CLEAR, report("state=blocked:kind=permission:app=omp")]);
	});

	it("re-sends a working record after a suspend but never repeats a done result", () => {
		setRunStatus({ state: "working" });
		resendProgramStatus();
		setRunStatus({ state: "done" });
		resendProgramStatus();

		expect(writes).toEqual([
			report("state=working:app=omp"),
			report("state=working:app=omp"),
			report("state=done:app=omp"),
		]);
	});
});
