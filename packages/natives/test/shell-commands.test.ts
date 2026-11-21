import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	Shell,
	type ShellCommandRequest,
	type ShellCommandResult,
	type ShellRunOptions,
	shellReservedCommandNames,
} from "../native/index.js";

type Handler = (request: ShellCommandRequest) => Promise<ShellCommandResult>;

async function run(
	shell: Shell,
	command: string,
	commands?: { names: string[]; handler: Handler },
	options: Omit<ShellRunOptions, "command" | "commands"> = {},
) {
	let output = "";
	const result = await shell.run({ command, commands, ...options }, (error, chunk) => {
		if (error) throw error;
		output += chunk;
	});
	return { result, output };
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-shell-commands-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("Shell session commands", () => {
	it("passes name, argv, cwd and dash-requested stdin through the handler", async () => {
		await withTempDir(async root => {
			const cwd = path.join(root, "nested");
			await fs.mkdir(cwd);
			const requests: ShellCommandRequest[] = [];
			const { result, output } = await run(
				new Shell(),
				"printf payload | probe read - | tr a-z A-Z; printf 'a\\nb\\n' | while read -r l; do probe \"$l\"; done",
				{
					names: ["probe"],
					handler: async request => {
						requests.push(request);
						await Promise.resolve();
						return { stdout: `${request.stdin}:${request.argv.join(",")}\n`, stderr: "", exitCode: 0 };
					},
				},
				{ cwd },
			);
			expect(result.exitCode).toBe(0);
			expect(output).toBe("PAYLOAD:READ,-\n:a\n:b\n");
			expect(requests.map(request => request.name)).toEqual(["probe", "probe", "probe"]);
			expect(requests.map(request => request.stdin)).toEqual(["payload", "", ""]);
			for (const request of requests) {
				expect(await fs.realpath(request.cwd)).toBe(await fs.realpath(cwd));
			}
		});
	});

	it("routes every command of a pipeline to the handler", async () => {
		const requests: ShellCommandRequest[] = [];
		const { result, output } = await run(new Shell(), "upper hello | wrap -", {
			names: ["upper", "wrap"],
			handler: async request => {
				requests.push(request);
				const stdout =
					request.name === "upper"
						? `${request.argv.join(" ").toUpperCase()}\n`
						: `[${request.stdin.trimEnd()}]\n`;
				return { stdout, stderr: "", exitCode: 0 };
			},
		});
		expect(result.exitCode).toBe(0);
		expect(output).toBe("[HELLO]\n");
		expect(requests.map(request => [request.name, request.argv])).toEqual([
			["upper", ["hello"]],
			["wrap", ["-"]],
		]);
	});

	it("reaches the handler even when an earlier run defined a function of the same name", async () => {
		const shell = new Shell();
		const defined = await run(shell, "github() { echo function; }");
		expect(defined.result.exitCode).toBe(0);
		let calls = 0;
		const { result, output } = await run(shell, "github pr_view", {
			names: ["github"],
			handler: async request => {
				calls++;
				return { stdout: `tool:${request.argv.join(",")}\n`, stderr: "", exitCode: 0 };
			},
		});
		expect(result.exitCode).toBe(0);
		expect(output).toBe("tool:pr_view\n");
		expect(calls).toBe(1);
	});

	it("maps rejections, throws and malformed replies to status 1 with the command name", async () => {
		const shell = new Shell();
		const reply = await run(shell, 'probe 2>&1; echo "s=$?"', {
			names: ["probe"],
			handler: async () => ({ stdout: "partial\n", stderr: "diag\n", exitCode: 300 }),
		});
		expect(reply.output).toBe("partial\ndiag\ns=255\n");

		const rejected = await run(shell, 'probe 2>&1; echo "s=$?"', {
			names: ["probe"],
			handler: async () => {
				await Promise.resolve();
				throw new Error("js handler rejected");
			},
		});
		expect(rejected.output).toBe("probe: js handler rejected\ns=1\n");

		const thrown = await run(shell, 'probe 2>&1; echo "s=$?"', {
			names: ["probe"],
			handler: () => {
				throw new Error("sync throw");
			},
		});
		expect(thrown.output).toEndWith("s=1\n");
		expect(thrown.output).toStartWith("probe: ");

		const malformed = await run(shell, 'probe 2>&1; echo "s=$?"', {
			names: ["probe"],
			handler: async () => JSON.parse('{"stdout":1}'),
		});
		expect(malformed.output).toEndWith("s=1\n");
		expect(malformed.output).toStartWith("probe: ");
	});

	it("never reaches the handler for reserved names", async () => {
		const reserved = shellReservedCommandNames();
		for (const name of ["cd", "echo", "grep", "timeout", "if"]) {
			expect(reserved).toContain(name);
		}
		expect(reserved).not.toContain("omp_unused_command_name");

		let calls = 0;
		const { result, output } = await run(new Shell(), "echo hi; github", {
			names: ["echo", "github"],
			handler: async request => {
				calls++;
				return { stdout: `${request.name}\n`, stderr: "", exitCode: 0 };
			},
		});
		expect(result.exitCode).toBe(0);
		expect(output).toBe("hi\ngithub\n");
		expect(calls).toBe(1);
	});

	it("scopes commands to their run, including background jobs that outlive it", async () => {
		await withTempDir(async root => {
			const shell = new Shell();
			const go = quote(path.join(root, "go"));
			const late = quote(path.join(root, "late"));
			let staleCalls = 0;
			const first = await run(
				shell,
				`{ while [ ! -e ${go} ]; do sleep 0.01; done; omp_probe late 2>/dev/null; echo "status=$?" > ${late}; } & printf done`,
				{
					names: ["omp_probe"],
					handler: async () => {
						staleCalls++;
						return { stdout: "must-not-run", stderr: "", exitCode: 0 };
					},
				},
			);
			expect(first.output).toBe("done");

			const second = await run(shell, `touch ${go}; while [ ! -s ${late} ]; do sleep 0.01; done; cat ${late}`);
			expect(second.result.exitCode).toBe(0);
			expect(second.output).toBe("status=127\n");
			expect(staleCalls).toBe(0);
		});
	});

	it("cancels a pending call on timeout and serves the next run", async () => {
		const shell = new Shell();
		const timedOut = await run(
			shell,
			"probe pending",
			{
				names: ["probe"],
				handler: () => new Promise<ShellCommandResult>(() => {}),
			},
			{ timeoutMs: 50 },
		);
		expect(timedOut.result.timedOut).toBeTrue();
		expect(timedOut.result.exitCode).toBeUndefined();

		const after = await run(shell, "probe after", {
			names: ["probe"],
			handler: async () => ({ stdout: "after", stderr: "", exitCode: 0 }),
		});
		expect(after.result.exitCode).toBe(0);
		expect(after.output).toBe("after");
	});

	it("cancels a pending call when the run's signal aborts", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const active = run(
			new Shell(),
			"probe pending",
			{
				names: ["probe"],
				handler: () => {
					started.resolve();
					return new Promise<ShellCommandResult>(() => {});
				},
			},
			{ signal: controller.signal },
		);
		await started.promise;
		controller.abort();
		const cancelled = await active;
		expect(cancelled.result.cancelled).toBeTrue();
		expect(cancelled.result.exitCode).toBeUndefined();
	});
});
