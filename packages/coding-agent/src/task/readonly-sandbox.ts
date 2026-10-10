import { realpathSync, lstatSync, existsSync, mkdtempSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { readonlySeccompPolicy } from "./readonly-seccomp";
import { type } from "@oh-my-pi/omptype";
import type { Subprocess } from "bun";
import type { Tool } from "../tools";
import { resolveWorkerSpawnCmd } from "../subprocess/worker-client";
import pythonRunner from "../eval/py/runner.py" with { type: "text" };
import type { BoundReadonlySubagent, ReadonlySubagentBinding, ReadonlySubagentGrant } from "./readonly-authority";

const OUTPUT_LIMIT = 1024 * 1024;
const schemas = {
	bash: type({ command: "string", "timeout?": "number" }),
	eval: type({
		language: "'js' | 'py'",
		code: "string",
		"timeout?": "number",
		"title?": "string",
	}),
};

/** No shell snapshot, direnv, environment inheritance, network, or host tool bridge. */
export class ReadonlySandbox implements BoundReadonlySubagent {
	readonly binding: ReadonlySubagentBinding;
	#grant: ReadonlySubagentGrant;
	#processes = new Set<Subprocess>();
	#invalid = false;
	#disposed = false;
	#poll?: Timer;
	#filterDirectory?: string;
	#checking = false;
	#bwrap: string;
	#runtimeRoot: string;

	constructor(grant: ReadonlySubagentGrant, childSessionId: string, cwd: string) {
		if (process.platform !== "linux") throw new Error("READONLY_SANDBOX_REQUIRES_LINUX");
		this.#bwrap = Bun.which("bwrap") ?? "";
		if (!this.#bwrap) throw new Error("READONLY_SANDBOX_BWRAP_UNAVAILABLE");
		const scopeRoot = realpathSync(grant.scopeRoot);
		if (
			realpathSync(cwd) !== scopeRoot ||
			!grant.parentSessionId ||
			!childSessionId ||
			childSessionId === grant.parentSessionId
		) {
			throw new Error("READONLY_CHILD_BINDING_INVALID");
		}
		this.#grant = grant;
		this.binding = Object.freeze({ parentSessionId: grant.parentSessionId, childSessionId, scopeRoot });
		this.#runtimeRoot = path.resolve(import.meta.dir, "../../../..");
	}

	#track(proc: Subprocess): void {
		this.#processes.add(proc);
		void proc.exited.then(() => {
			this.#processes.delete(proc);
			if (this.#processes.size === 0 && this.#poll) {
				clearInterval(this.#poll);
				this.#poll = undefined;
			}
		});
		if (this.#poll) return;
		this.#poll = setInterval(() => {
			if (this.#checking) return;
			this.#checking = true;
			void this.validate().finally(() => {
				this.#checking = false;
			});
		}, 250);
		this.#poll.unref();
	}

	#spawn(args: string[], stdin: "pipe"): Subprocess<"pipe", "pipe", "pipe">;
	#spawn(args: string[], stdin: "ignore"): Subprocess<"ignore", "pipe", "pipe">;
	#spawn(args: string[], stdin: "pipe" | "ignore"): Subprocess<"pipe" | "ignore", "pipe", "pipe"> {
		if (!this.#filterDirectory) {
			this.#filterDirectory = mkdtempSync(path.join(tmpdir(), "omp-readonly-seccomp-"));
			writeFileSync(path.join(this.#filterDirectory, "policy.bpf"), readonlySeccompPolicy(), { mode: 0o600 });
		}
		const fd = openSync(path.join(this.#filterDirectory, "policy.bpf"), "r");
		try {
			return Bun.spawn({ cmd: args, env: {}, stdio: [stdin, "pipe", "pipe", Bun.file(fd)] });
		} finally {
			closeSync(fd);
		}
	}

	async validate(): Promise<boolean> {
		if (this.#disposed || this.#invalid) return false;
		try {
			let timer: Timer | undefined;
			try {
				const authorized = await Promise.race([
					this.#grant.authorize(this.binding),
					new Promise<boolean>(resolve => {
						timer = setTimeout(() => resolve(false), 2_000);
					}),
				]);
				if (authorized && !this.#disposed && !this.#invalid) return true;
			} finally {
				if (timer) clearTimeout(timer);
			}
		} catch {
			/* A failed central check never becomes an allow decision. */
		}
		this.#invalid = true;
		if (this.#poll) clearInterval(this.#poll);
		this.#poll = undefined;
		for (const proc of this.#processes) proc.kill("SIGKILL");
		return false;
	}

	#command(argv: string[], runtime?: string): string[] {
		const args = [
			this.#bwrap,
			"--unshare-all",
			"--unshare-user",
			"--disable-userns",
			"--assert-userns-disabled",
			"--die-with-parent",
			"--new-session",
			"--cap-drop",
			"ALL",
			"--seccomp",
			"3",
			"--clearenv",
			"--ro-bind",
			"/usr",
			"/usr",
			"--ro-bind",
			"/lib",
			"/lib",
			"--ro-bind",
			"/lib64",
			"/lib64",
			"--symlink",
			"usr/bin",
			"/bin",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--tmpfs",
			"/tmp",
			"--ro-bind",
			this.binding.scopeRoot,
			this.binding.scopeRoot,
			"--setenv",
			"PATH",
			"/usr/bin:/bin",
			"--setenv",
			"HOME",
			"/tmp",
			"--setenv",
			"TMPDIR",
			"/tmp",
			"--setenv",
			"PYTHONDONTWRITEBYTECODE",
			"1",
			"--chdir",
			this.binding.scopeRoot,
		];
		if (runtime) args.push("--ro-bind", realpathSync(runtime), "/readonly-runtime");
		for (const name of [".git", ".omp"]) {
			const target = path.join(this.binding.scopeRoot, name);
			if (!existsSync(target)) continue;
			if (lstatSync(target).isDirectory()) args.push("--tmpfs", target, "--remount-ro", target);
			else args.push("--ro-bind", "/dev/null", target);
		}
		return [...args, "--", ...argv];
	}

	async bash(command: string, timeout = 60, signal?: AbortSignal): Promise<{ text: string; error: boolean }> {
		const timeoutMs = this.#timeout(timeout);
		if (!(await this.validate())) throw new Error("READONLY_PARENT_AUTHORITY_LOST");
		if (signal?.aborted) throw new Error("READONLY_CELL_ABORTED");
		const proc = this.#spawn(this.#command(["/bin/sh", "-c", command]), "ignore");
		this.#track(proc);
		const kill = () => proc.kill("SIGKILL");
		signal?.addEventListener("abort", kill, { once: true });
		if (signal?.aborted) kill();
		const timer = setTimeout(kill, timeoutMs);
		const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
			let text = "";
			let bytes = 0;
			const decoder = new TextDecoder();
			for await (const chunk of stream) {
				bytes += chunk.length;
				if (bytes > OUTPUT_LIMIT) {
					kill();
					throw new Error("READONLY_OUTPUT_LIMIT");
				}
				text += decoder.decode(chunk, { stream: true });
			}
			return text;
		};
		try {
			const [stdout, stderr, exit] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
			if (!(await this.validate())) throw new Error("READONLY_PARENT_AUTHORITY_LOST");
			return { text: `${stdout}${stderr}\nExit: ${exit}`, error: exit !== 0 };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
			if (proc.exitCode === null) proc.kill("SIGKILL");
			await proc.exited;
			this.#processes.delete(proc);
		}
	}

	#timeout(seconds: number): number {
		if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300)
			throw new Error("READONLY_TIMEOUT_MUST_BE_1_TO_300_SECONDS");
		return seconds * 1000;
	}

	async *#lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
		const decoder = new TextDecoder();
		let buffered = "";
		let bufferedBytes = 0;
		for await (const chunk of stream) {
			const text = decoder.decode(chunk, { stream: true });
			let offset = 0;
			while (offset < text.length) {
				const newline = text.indexOf("\n", offset);
				const part = text.slice(offset, newline < 0 ? text.length : newline);
				bufferedBytes += Buffer.byteLength(part);
				if (bufferedBytes > OUTPUT_LIMIT) throw new Error("READONLY_OUTPUT_LIMIT");
				buffered += part;
				if (newline < 0) break;
				yield buffered;
				buffered = "";
				bufferedBytes = 0;
				offset = newline + 1;
			}
		}
	}
	async eval(
		language: "js" | "py",
		code: string,
		timeout = 60,
		signal?: AbortSignal,
	): Promise<{ text: string; error: boolean }> {
		const timeoutMs = this.#timeout(timeout);
		if (!(await this.validate())) throw new Error("READONLY_PARENT_AUTHORITY_LOST");
		if (signal?.aborted) throw new Error("READONLY_CELL_ABORTED");
		let args: string[];
		if (language === "js") {
			const worker = resolveWorkerSpawnCmd("__omp_worker_readonly_js");
			const argv = ["/readonly-runtime", ...worker.cmd.slice(1)];
			if (worker.cwd && argv.length > 2) argv[1] = path.resolve(worker.cwd, argv[1]);
			args = this.#command(argv, worker.cmd[0]);
			if (argv.length > 2) {
				args.splice(args.length - argv.length - 1, 0, "--ro-bind", this.#runtimeRoot, this.#runtimeRoot);
				for (const name of [".git", ".omp"]) {
					const target = path.join(this.#runtimeRoot, name);
					if (existsSync(target))
						args.splice(
							args.length - argv.length - 1,
							0,
							...(lstatSync(target).isDirectory()
								? ["--tmpfs", target, "--remount-ro", target]
								: ["--ro-bind", "/dev/null", target]),
						);
				}
			}
		} else {
			// Reuse the native runner's serial dispatcher: EOF must follow completed
			// execution, not cancel its POSIX concurrent request tasks.
			args = this.#command([
				"/usr/bin/python3",
				"-u",
				"-c",
				"import sys,json;s={'__name__':'readonly_guest','__file__':'<readonly-runner>'};exec(compile(json.loads(sys.stdin.readline()),'<readonly-runner>','exec'),s);s['_serve_posix']=s['_serve_windows'];s['main']()",
			]);
		}
		const proc = this.#spawn(args, "pipe");
		this.#track(proc);
		let stopped = false;
		const kill = () => {
			stopped = true;
			proc.kill("SIGKILL");
		};
		const timer = setTimeout(kill, timeoutMs);
		signal?.addEventListener("abort", kill, { once: true });
		let text = "";
		let error = false;
		const id = crypto.randomUUID();
		let outputBytes = 0;
		const output = async () => {
			for await (const line of this.#lines(proc.stdout)) {
				let frame: Record<string, unknown>;
				try {
					frame = JSON.parse(line);
				} catch {
					continue;
				}
				if (frame.id !== id) continue;
				if (frame.type === "tool") throw new Error("READONLY_HOST_BRIDGE_DENIED");
				// A guest controls these frames. They are output, never completion authority.
				if (frame.type === "done") {
					error ||= frame.status !== "ok";
					continue;
				}
				if (frame.type === "error") error = true;
				const part = typeof frame.data === "string" ? frame.data : JSON.stringify(frame) + "\n";
				outputBytes += Buffer.byteLength(part);
				if (outputBytes > OUTPUT_LIMIT) throw new Error("READONLY_OUTPUT_LIMIT");
				text += part;
			}
		};
		const stderr = async () => {
			let count = 0;
			for await (const chunk of proc.stderr) {
				count += chunk.length;
				if (count > OUTPUT_LIMIT) throw new Error("READONLY_OUTPUT_LIMIT");
			}
		};
		try {
			if (signal?.aborted) kill();
			if (language === "py") proc.stdin.write(JSON.stringify(pythonRunner) + "\n");
			proc.stdin.write(JSON.stringify({ id, code, cwd: this.binding.scopeRoot, filename: "readonly-" + id }) + "\n");
			proc.stdin.flush();
			proc.stdin.end();
			const [, , exit] = await Promise.all([output(), stderr(), proc.exited]);
			if (!(await this.validate())) throw new Error("READONLY_PARENT_AUTHORITY_LOST");
			if (stopped) throw new Error("READONLY_CELL_ABORTED");
			return { text, error: error || exit !== 0 };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
			if (proc.exitCode === null) proc.kill("SIGKILL");
			await proc.exited;
		}
	}

	async createTools(names: readonly string[]): Promise<Tool[]> {
		if (!(await this.validate())) throw new Error("READONLY_PARENT_AUTHORITY_LOST");
		const result: Tool[] = [];
		for (const name of names) {
			if (name !== "bash" && name !== "eval") continue;
			result.push({
				name,
				label: `Readonly ${name}`,
				description:
					name === "bash"
						? "Run shell computation in a readonly scoped Linux sandbox. No network or host environment; timeout 1–300 seconds."
						: "Stateless Python/JavaScript computation in a fresh readonly scoped Linux sandbox; no host bridge or retained state. Waits for real process exit. Timeout >0–300 seconds.",
				parameters: schemas[name],
				async execute(_id, input, signal) {
					const args = input as {
						command: string;
						language: "js" | "py";
						code: string;
						timeout?: number;
					};
					const output =
						name === "bash"
							? await thisSandbox.bash(args.command, args.timeout, signal)
							: await thisSandbox.eval(args.language, args.code, args.timeout, signal);
					return {
						content: [{ type: "text", text: output.text }],
						isError: output.error,
						details: { readonly: true },
					};
				},
			});
		}
		const thisSandbox = this;
		return result;
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		if (this.#poll) clearInterval(this.#poll);
		for (const proc of this.#processes) proc.kill("SIGKILL");
		await Promise.all([...this.#processes].map(proc => proc.exited));
		this.#processes.clear();
		if (this.#filterDirectory) rmSync(this.#filterDirectory, { recursive: true, force: true });
	}
}
