import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

type DataListener = (data: string) => void;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(target, key, descriptor);
	else Reflect.deleteProperty(target, key);
}

function dataListeners(): DataListener[] {
	return process.stdin.listeners("data") as DataListener[];
}

// Ctrl-Z suspends with stop() and SIGCONT resumes with start() (#19372). A
// stdin `data` emission that snapshotted the listener list before stop() still
// calls the retired callback; it must neither crash nor feed the next parser.
describe("ProcessTerminal stdin handler across stop/start", () => {
	let savedEnv: Record<string, string | undefined>;
	let savedStdinTty: PropertyDescriptor | undefined;
	let savedStdoutTty: PropertyDescriptor | undefined;
	let savedRawMode: PropertyDescriptor | undefined;
	let previousHeadless: boolean;

	beforeEach(() => {
		savedEnv = {};
		for (const key of TERMINAL_MULTIPLEXER_ENV_KEYS) {
			savedEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
		savedStdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		savedStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		savedRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		previousHeadless = setTerminalHeadless(false);
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		restoreProperty(process.stdin, "isTTY", savedStdinTty);
		restoreProperty(process.stdout, "isTTY", savedStdoutTty);
		restoreProperty(process.stdin, "setRawMode", savedRawMode);
		for (const key of TERMINAL_MULTIPLEXER_ENV_KEYS) {
			if (savedEnv[key] === undefined) delete Bun.env[key];
			else Bun.env[key] = savedEnv[key];
		}
	});

	it("drops a retired callback after stop and after a restart", () => {
		const terminal = new ProcessTerminal();
		const received: string[] = [];
		const before = new Set(dataListeners());
		terminal.start(
			data => received.push(data),
			() => {},
		);
		const retired = dataListeners().filter(listener => !before.has(listener));
		expect(retired).toHaveLength(1);
		const [oldCallback] = retired;

		try {
			terminal.stop();
			expect(() => oldCallback("x")).not.toThrow();

			terminal.start(
				data => received.push(data),
				() => {},
			);
			oldCallback("y");
			expect(received).toEqual([]);

			process.stdin.emit("data", "z");
			expect(received).toEqual(["z"]);
			expect(dataListeners().filter(listener => !before.has(listener))).toHaveLength(1);
		} finally {
			terminal.stop();
		}
	});

	it("survives an in-flight emission whose earlier listener stops the terminal", () => {
		const terminal = new ProcessTerminal();
		const before = new Set(dataListeners());
		terminal.start(
			() => {},
			() => {},
		);
		// Runs ahead of the terminal's handler within the same emission, the way
		// a Ctrl-Z suspend tears the TUI down while stdin is still dispatching.
		const stopper = () => terminal.stop();
		process.stdin.prependListener("data", stopper);
		try {
			expect(() => process.stdin.emit("data", "\x1a")).not.toThrow();
			expect(dataListeners().filter(listener => !before.has(listener))).toEqual([stopper]);
		} finally {
			process.stdin.removeListener("data", stopper);
			terminal.stop();
		}
	});
});
