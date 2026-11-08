import { describe, expect, it } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";

// The global fatal handlers the CLI installs turn what they caught into an Error
// before anything else, then read its code, syscall, name, message and stack to
// classify and report it. A value whose conversion to text throws, or an error
// whose properties throw or are not text when read, must not make those steps
// throw: the handler would then reject on its own, and the interceptors would
// see that TypeError instead of the value a caller registered to consume.

const rejectFlag = "--undescribable-reject-child";
const throwFlag = "--undescribable-throw-child";
const cleanupFlag = "--undescribable-cleanup-child";

/** Builds, in the child, the value named on its command line. */
function undescribable(kind: string): unknown {
	switch (kind) {
		case "null-prototype":
			return Object.create(null);
		case "hostile-proxy": {
			const refuse = (): never => {
				throw new Error("the proxy refuses every operation");
			};
			return new Proxy({}, new Proxy({}, { get: () => refuse }));
		}
		case "error-proxy": {
			const refuse = (): never => {
				throw new Error("the error proxy refuses every read");
			};
			return new Proxy(new Error("unused"), { get: refuse, has: refuse });
		}
		case "throwing-code-getter":
			return Object.defineProperty(new Error("the code is unreadable"), "code", {
				get() {
					throw new Error("the code getter failed");
				},
			});
		case "non-text-stack":
			return Object.defineProperty(new Error("the stack is not text"), "stack", { value: { frames: [] } });
		default: {
			const revocable = Proxy.revocable({}, {});
			revocable.revoke();
			return revocable.proxy;
		}
	}
}

const childKind = process.argv[process.argv.length - 1] ?? "";

// Each child is a CLI-owned process, so it installs the handlers the CLI installs.
if (process.argv.includes(rejectFlag) || process.argv.includes(throwFlag)) postmortem.installProcessHandlers();

if (process.argv.includes(rejectFlag)) {
	const value = undescribable(childKind);
	postmortem.interceptUnhandledRejections(reason => {
		if (reason !== value) return false;
		process.stdout.write("intercepted the value itself\n");
		process.exit(0);
	});
	void Promise.reject(value);
	await Promise.withResolvers<never>().promise;
} else if (process.argv.includes(throwFlag)) {
	const value = undescribable(childKind);
	setTimeout(() => {
		throw value;
	}, 0);
	await Promise.withResolvers<never>().promise;
} else if (process.argv.includes(cleanupFlag)) {
	// A cleanup callback fails with an error whose `stack` getter throws, in the pass itself or
	// registered while the pass runs. Reporting the failure must not throw that getter's error.
	const failure = (): Error =>
		Object.defineProperty(new Error("the cleanup failed"), "stack", {
			get() {
				throw new Error("the stack getter escaped");
			},
		});
	const fail = childKind.endsWith("async")
		? async () => {
				throw failure();
			}
		: () => {
				throw failure();
			};
	let registerThrew = false;
	if (childKind.startsWith("late")) {
		postmortem.register("outer", () => {
			try {
				postmortem.register("late", fail);
			} catch {
				registerThrew = true;
			}
		});
	} else {
		postmortem.register("failing", fail);
	}
	try {
		await postmortem.cleanup();
		process.stdout.write(registerThrew ? "register threw\n" : "cleanup finished\n");
	} catch (error) {
		process.stdout.write(`cleanup rejected: ${error instanceof Error ? error.message : "?"}\n`);
	}
	process.exit(0);
}

async function runChild(flag: string, kind: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([process.execPath, "run", import.meta.path, flag, kind], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		child.kill();
		await child.exited;
	}
}

const KINDS: ReadonlyArray<{ kind: string; described: string }> = [
	{ kind: "null-prototype", described: "[object Object]" },
	{ kind: "hostile-proxy", described: "[object Object]" },
	{ kind: "revoked-proxy", described: "a thrown object that cannot be converted to text" },
	{ kind: "error-proxy", described: "[object Error]" },
	{ kind: "throwing-code-getter", described: "the code is unreadable" },
	{ kind: "non-text-stack", described: "the stack is not text" },
];

/** Where a cleanup callback fails: in the pass, or registered while the pass runs; by throwing, or by rejecting. */
const CLEANUP_FAILURES = ["sync", "async", "late-sync", "late-async"] as const;

if (!process.argv.includes(rejectFlag) && !process.argv.includes(throwFlag) && !process.argv.includes(cleanupFlag)) {
	describe("postmortem with a value whose conversion to text throws", () => {
		// Each row starts a child process; under load that alone can outlast the 5-second default.
		for (const { kind, described } of KINDS) {
			it(`hands an unhandled rejection with a ${kind} value to the interceptors`, async () => {
				const { exitCode, stdout, stderr } = await runChild(rejectFlag, kind);
				expect(stdout).toBe("intercepted the value itself\n");
				expect(stderr).not.toContain("[Unhandled Rejection]");
				expect(exitCode).toBe(0);
			}, 30_000);

			it(`reports an uncaught ${kind} exception as itself`, async () => {
				const { exitCode, stderr } = await runChild(throwFlag, kind);
				expect(stderr).toContain("[Uncaught Exception]");
				expect(stderr).toContain(described);
				expect(stderr).not.toContain("[Unhandled Rejection]");
				expect(exitCode).toBe(1);
			}, 30_000);
		}

		for (const kind of CLEANUP_FAILURES) {
			it(`reports a ${kind} cleanup failure whose stack getter throws, and the cleanup pass still finishes`, async () => {
				const { exitCode, stdout } = await runChild(cleanupFlag, kind);
				expect(stdout).toBe("cleanup finished\n");
				expect(exitCode).toBe(0);
			}, 30_000);
		}
	});
}
