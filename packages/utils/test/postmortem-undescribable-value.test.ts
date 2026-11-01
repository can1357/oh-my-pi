import { describe, expect, it } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";

// The global fatal handlers the CLI installs turn what they caught into an Error
// before anything else. A value whose conversion to text throws must not make
// that step throw: the handler would then reject on its own, and the interceptors
// would see the conversion's TypeError instead of the value a caller registered
// to consume.

const rejectFlag = "--undescribable-reject-child";
const throwFlag = "--undescribable-throw-child";

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
	{ kind: "hostile-proxy", described: "a thrown object that cannot be converted to text" },
	{ kind: "revoked-proxy", described: "a thrown object that cannot be converted to text" },
];

if (!process.argv.includes(rejectFlag) && !process.argv.includes(throwFlag)) {
	describe("postmortem with a value whose conversion to text throws", () => {
		for (const { kind, described } of KINDS) {
			it(`hands an unhandled rejection with a ${kind} value to the interceptors`, async () => {
				const { exitCode, stdout, stderr } = await runChild(rejectFlag, kind);
				expect(stdout).toBe("intercepted the value itself\n");
				expect(stderr).not.toContain("[Unhandled Rejection]");
				expect(exitCode).toBe(0);
			});

			it(`reports an uncaught ${kind} exception as itself`, async () => {
				const { exitCode, stderr } = await runChild(throwFlag, kind);
				expect(stderr).toContain("[Uncaught Exception]");
				expect(stderr).toContain(described);
				expect(stderr).not.toContain("[Unhandled Rejection]");
				expect(exitCode).toBe(1);
			});
		}
	});
}
