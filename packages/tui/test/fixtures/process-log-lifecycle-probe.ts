import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getLogsDir,
	isTerminalOutputSuppressed,
	logger,
	setTerminalHeadless,
	setTerminalOutputRedirectTarget,
} from "@oh-my-pi/pi-utils";
import { getProcessLogSink, onProcessLogTargetChanged } from "@oh-my-pi/pi-utils/logger/process-log";
import { ProcessTerminal } from "../../src/terminal";

const root = process.argv[2]!;
const mode = process.argv[3]!;
process.umask(0o022);
const defaultDirectory = getLogsDir();
const customDirectory = path.join(root, "custom");
let directory = mode === "cold" || mode === "warm" ? customDirectory : defaultDirectory;
logger.setTransports({ file: mode === "disabled" ? false : mode === "default" ? true : directory });
if (mode === "warm") {
	logger.info("warm structured record");
	logger.flush();
}
setTerminalHeadless(false);
const terminal = new ProcessTerminal({ conpty: false });
const target = () => fs.readlinkSync("/proc/self/fd/1");
const assertDestination = (expectedDirectory: string) => {
	assert.equal(isTerminalOutputSuppressed(), true);
	const current = target();
	assert.equal(path.dirname(current), expectedDirectory);
	assert.equal(fs.readlinkSync("/proc/self/fd/2"), current);
	assert.equal(current.includes("(deleted)"), false);
	assert.equal(fs.statSync(current).mode & 0o777, 0o600);
	return current;
};
const overflow = Buffer.alloc(10 * 1024 * 1024 + 1, "x");
async function rotate(expectedDirectory: string) {
	const previous = assertDestination(expectedDirectory);
	fs.writeSync(1, overflow);
	const deadline = Date.now() + 4_000;
	while (target() === previous && Date.now() < deadline) await Bun.sleep(25);
	const current = assertDestination(expectedDirectory);
	assert.notEqual(current, previous);
	fs.writeSync(1, "raw-stdout-marker\n");
	fs.writeSync(2, "raw-stderr-marker\n");
	assert.match(fs.readFileSync(current, "utf8"), /raw-stdout-marker\nraw-stderr-marker/);
	return previous;
}

try {
	terminal.start(
		() => {},
		() => {},
		undefined,
		{ deferInput: true },
	);
	assertDestination(directory);
	if (mode === "guard-retry") {
		const previous = target();
		const successor = `${previous}.1`;
		const openSync = fs.openSync;
		let rejected = false;
		const guardOpen = spyOn(fs, "openSync").mockImplementation((file, flags, permissions) => {
			if (file === successor && flags === "a") {
				rejected = true;
				throw new Error("guard handoff temporarily unavailable");
			}
			return openSync(file, flags, permissions);
		});
		try {
			fs.writeSync(1, overflow);
			await Bun.sleep(1_100);
			assert.equal(rejected, true, "the sink opens successfully before the guard open fails");
			assert.equal(target(), previous);
			assert.equal(
				getProcessLogSink().openForExternalWrites(),
				previous,
				"failed handoff must retain canonical selection",
			);
			fs.writeSync(1, "raw during rejected guard handoff\n");
			logger.info("structured during rejected guard handoff");
			logger.flush();
			assert.match(fs.readFileSync(previous, "utf8"), /raw during rejected guard handoff/);
			assert.match(fs.readFileSync(previous, "utf8"), /structured during rejected guard handoff/);
		} finally {
			guardOpen.mockRestore();
		}
		getProcessLogSink().checkExternalGrowth();
		assert.equal(target(), successor, "a recovered guard handoff must retry without a structured record");
		fs.writeSync(1, "raw after recovered guard handoff\n");
		assert.match(fs.readFileSync(successor, "utf8"), /raw after recovered guard handoff/);
	}
	if (mode === "recovery" || mode === "retired") {
		const previous = target();
		// A directory at the successor path makes the real rollover open fail.
		fs.mkdirSync(`${previous}.1`);
		fs.writeSync(1, overflow);
		await Bun.sleep(1_100);
		getProcessLogSink().openForExternalWrites();
		assert.equal(target(), previous);
		const rejected = path.join(root, "rejected-replacement");
		onProcessLogTargetChanged(filePath => {
			if (path.dirname(filePath) === rejected) throw new Error("reject replacement");
		});
		assert.throws(() => logger.setTransports({ file: rejected }), /reject replacement/);
		assert.equal(target(), previous);
		if (mode === "retired") {
			logger.info("buffered before healthy handoff");
			fs.rmdirSync(`${previous}.1`);
		}
		directory = path.join(root, "recovered");
		logger.setTransports({ file: directory });
		assertDestination(directory);
		if (mode === "retired") {
			const previousDirectory = path.dirname(previous);
			const preserved = fs.readdirSync(previousDirectory).some(name => {
				const file = path.join(previousDirectory, name);
				return (
					fs.statSync(file).isFile() && fs.readFileSync(file, "utf8").includes("buffered before healthy handoff")
				);
			});
			assert.equal(preserved, true, "handoff must preserve the buffered record in the previous destination");
		}
	}
	if (mode === "rejected") {
		const before = target();
		setTerminalOutputRedirectTarget(path.join(root, "missing", "unopenable.log"));
		assert.equal(target(), before);
	}
	const initial = await rotate(directory);
	if (mode === "cold") {
		const replacement = path.join(root, "replacement");
		logger.setTransports({ file: replacement });
		assertDestination(replacement);
		await rotate(replacement);
	}
	if (mode === "disabled") {
		for (let i = 0; i < 5; i++) await rotate(directory);
		const files = fs
			.readdirSync(directory)
			.filter(name => name.startsWith("omp.") && name.includes(`.${process.pid}.log`));
		assert.equal(files.length, 5);
		assert.equal(fs.existsSync(initial), false);
	}
	const beforeStop = target();
	const nested = new ProcessTerminal({ conpty: false });
	nested.start(
		() => {},
		() => {},
		undefined,
		{ deferInput: true },
	);
	terminal.stop();
	assert.equal(isTerminalOutputSuppressed(), true);
	assert.equal(target(), beforeStop);
	nested.stop();
	assert.equal(isTerminalOutputSuppressed(), false);
	terminal.start(
		() => {},
		() => {},
		undefined,
		{ deferInput: true },
	);
	assertDestination(path.dirname(beforeStop));
	if (mode === "disabled") {
		await rotate(directory);
		const files = fs
			.readdirSync(directory)
			.filter(name => name.startsWith("omp.") && name.includes(`.${process.pid}.log`));
		assert.equal(files.length, 5);
	}
	terminal.stop();
	assert.equal(isTerminalOutputSuppressed(), false);
	fs.writeFileSync(path.join(root, "result.txt"), "passed\n");
} finally {
	terminal.stop();
}
process.exit(0);
