import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	mkdtempSync,
	openSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import * as libcModule from "@oh-my-pi/pi-coding-agent/session/libc";
import * as holders from "@oh-my-pi/pi-coding-agent/session/open-file-holders";
import { getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

// What `gc --reclaim` does with the kernel's answer when it asks for a lease
// on each file it is about to give up: proceed only when every lease is
// granted, and keep the session, saying why, for any other answer.

/** Whether this kernel and the test directory's filesystem grant leases at all; the tests that need one skip otherwise. */
const leasesGranted = ((): boolean => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "omp-lease-probe-"));
	try {
		const file = path.join(dir, "probe");
		writeFileSync(file, "probe");
		const fd = openSync(file, "r");
		try {
			return holders.takeSoleOpenLease(fd).outcome === "held";
		} finally {
			closeSync(fd);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
})();

let root: string;
let originalAgentDir: string;
let sessionId: string;
let sessionFile: string;
let archiveFile: string;
let artifact: string;

beforeEach(async () => {
	originalAgentDir = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reclaim-lease-"));
	setAgentDir(root);
	sessionId = `${randomBytes(4).toString("hex")}-42ae-7117-ba7c-029b1eee0f4b`;
	const bucket = path.join(getSessionsDir(root), "--work--");
	sessionFile = path.join(bucket, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
	archiveFile = path.join(root, "archive", "sessions", "--work--", `${path.basename(sessionFile)}.gz`);
	artifact = path.join(sessionFile.slice(0, -".jsonl".length), "a.log");
	await Bun.write(
		sessionFile,
		`${[
			{ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
			{ type: "message", id: "m1", message: { role: "user", content: "fixture" } },
			{ type: "message", id: "m2", message: { role: "assistant", content: [] } },
		]
			.map(entry => JSON.stringify(entry))
			.join("\n")}\n`,
	);
	await Bun.write(artifact, "FIRST");
	const old = new Date(Date.now() - 30 * 86_400_000);
	for (const entry of await fs.readdir(bucket, { recursive: true }))
		await fs.utimes(path.join(bucket, entry), old, old);
	const archived = await runGcCommand({
		flags: {
			agentDir: root,
			archive: true,
			apply: true,
			json: true,
			coldArchiveAfterDays: 0,
			retainNewestGlobal: 0,
			retainNewestPerCwd: 0,
		},
	});
	expect(archived.archive).toMatchObject({ archived: 1, errors: [] });
});

afterEach(async () => {
	mock.restore();
	setAgentDir(originalAgentDir);
	await fs.rm(root, { recursive: true, force: true });
});

const reclaim = (apply: boolean) =>
	runGcCommand({ flags: { agentDir: root, reclaim: archiveFile, apply, forwardOnly: true, json: true } });

/** Every `.leaving` name a move aside left in the session's tree. */
async function leftAside(): Promise<string[]> {
	const names = [
		...(await fs.readdir(path.dirname(sessionFile))),
		...(await fs.readdir(path.dirname(artifact)).catch(() => [])),
	];
	return names.filter(name => name.endsWith(".leaving"));
}

test.skipIf(!leasesGranted)(
	"a reclaim leases every file it gives up, and with nothing holding them goes ahead",
	async () => {
		const realLease = holders.takeSoleOpenLease;
		const answers: string[] = [];
		spyOn(holders, "takeSoleOpenLease").mockImplementation(fd => {
			const answer = realLease(fd);
			answers.push(answer.outcome);
			return answer;
		});

		const result = await reclaim(true);
		mock.restore();
		const restored = await runGcCommand({ flags: { agentDir: root, restore: sessionId, apply: true, json: true } });

		expect(answers).toEqual(["held", "held"]);
		expect(result.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
		expect(restored.restore?.errors).toEqual([]);
		expect(await Bun.file(artifact).text()).toBe("FIRST");
	},
);

// A lease refused for any reason but another holder is no proof either:
// the session is kept, the file and the kernel's answer are named, and so is
// what the user can do. The preview says the same before anything moves.
for (const [code, advice] of [
	["ENOLCK", "Reclaim again later"],
	["EOPNOTSUPP", "Here `gc --reclaim` keeps the live copy"],
] as const) {
	test(`a reclaim the kernel will not grant a lease for (${code}) keeps the session and says why`, async () => {
		const real = libcModule.libc();
		const errno = os.constants.errno[code];
		let refused = false;
		spyOn(libcModule, "libc").mockReturnValue({
			...real,
			// F_SETLEASE asking for a write lease: refused, as that kernel would.
			fcntl: (fd, cmd, arg) => {
				if (cmd === 1024 && arg === 1) {
					refused = true;
					return -1;
				}
				return real.fcntl?.(fd, cmd, arg) ?? -1;
			},
			errno: () => {
				if (!refused) return real.errno();
				refused = false;
				return errno;
			},
		});

		const preview = await reclaim(false);
		const result = await reclaim(true);
		mock.restore();

		for (const said of [preview.reclaim?.errors.join("\n") ?? "", result.reclaim?.errors.join("\n") ?? ""]) {
			expect(said).toContain(`whether another process holds ${sessionFile} open could not be proved`);
			expect(said).toMatch(/fcntl\(F_SETLEASE, F_WRLCK\) failed with E[A-Z]+/);
			expect(said).toContain(advice);
		}
		expect(preview.reclaim?.wouldReclaim).toBeUndefined();
		expect(result.reclaim?.reclaimed).toBe(0);
		expect(result.reclaim?.partiallyRemoved ?? []).toEqual([]);
		expect(await Bun.file(artifact).text()).toBe("FIRST");
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		expect(await leftAside()).toEqual([]);
	});
}

// The archive carries none of a file's extended attributes, and a restore
// gives back none: a file capability only a privileged process can set
// again, and a security label `chcon` set, which a restore replaces with the
// one the policy gives a new file. A reclaim keeps a file carrying either, and
// for a label it says what that costs on a host that labels every file.
for (const [name, says] of [
	["security.capability", "Giving it up would lose that for good"],
	["security.selinux", "keeps every session"],
	["security.SMACK64", "keeps every session"],
] as const) {
	test.skipIf(!leasesGranted)(`a reclaim keeps a file carrying ${name}`, async () => {
		const real = libcModule.libc();
		const listed = Buffer.from(`${name}\0`);
		const isArtifact = (fd: number): boolean => {
			const at = path.basename(readlinkSync(`/proc/self/fd/${fd}`));
			return at === "a.log" || (at.startsWith(".a.log.") && at.endsWith(".leaving"));
		};
		spyOn(libcModule, "libc").mockReturnValue({
			...real,
			flistxattr: (fd, into, size) => {
				if (!isArtifact(fd)) return real.flistxattr(fd, into, size);
				if (into) listed.copy(into);
				return listed.length;
			},
		});

		const result = await reclaim(true);
		mock.restore();

		expect(result.reclaim?.reclaimed).toBe(0);
		expect(result.reclaim?.partiallyRemoved ?? []).toEqual([]);
		const said = result.reclaim?.errors.join("\n") ?? "";
		expect(said).toContain(`${artifact} carries extended attributes (${name})`);
		expect(said).toContain(says);
		expect(await Bun.file(artifact).text()).toBe("FIRST");
	});
}

/** A process of its own that leases `file` the way a reclaim does, and holds it until it is ended. */
function leaseHolder(file: string): { child: Bun.Subprocess<"ignore", "pipe", "pipe">; answer: Promise<string> } {
	const module = JSON.stringify(path.join(import.meta.dir, "../src/session/open-file-holders.ts"));
	const code =
		`import { takeSoleOpenLease } from ${module};\n` +
		`import { openSync } from "node:fs";\n` +
		// A raw descriptor, not a FileHandle: nothing finalizes it, so the lease
		// it carries stands until this process is ended, which is what the test
		// about ending it proves.
		`const fd = openSync(process.env.LEASE_FILE ?? "", "r");\n` +
		`console.log(JSON.stringify(takeSoleOpenLease(fd)));\n` +
		`setInterval(() => void fd, 1000);\n`;
	const child = Bun.spawn([process.execPath, "-e", code], {
		env: { ...process.env, LEASE_FILE: file },
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = child.stdout.getReader();
	const answer = (async () => {
		let said = "";
		while (!said.includes("\n")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error(`the lease holder exited: ${await new Response(child.stderr).text()}`);
			said += new TextDecoder().decode(chunk.value);
		}
		reader.releaseLock();
		return said.trim();
	})();
	return { child, answer };
}

// A lease is held by a descriptor, and the kernel closes every descriptor of
// a process that ends, however it ends: no signal leaves a file wedged.
for (const signal of ["SIGTERM", "SIGKILL"] as const) {
	test.skipIf(!leasesGranted)(
		`a lease goes with the process holding it when ${signal} ends it`,
		async () => {
			const { child, answer } = leaseHolder(artifact);
			expect(JSON.parse(await answer)).toEqual({ outcome: "held" });
			// Opened from this process, not through `python3`: that is mise's
			// shim in an agent session, whose start-up alone can outlast the
			// bound below. While the lease stands, an open that may not wait is
			// refused.
			const refused = await fs
				.open(artifact, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)
				.then(async handle => {
					await handle.close();
					return "OPENED";
				})
				.catch((error: NodeJS.ErrnoException) => error.code);
			expect(refused).toBe("EAGAIN");

			child.kill(signal);
			await child.exited;
			const started = performance.now();
			const after = await fs.open(artifact, fsConstants.O_WRONLY);
			await after.close();
			const waited = performance.now() - started;

			expect(waited).toBeLessThan(10_000);
		},
		60_000,
	);
}
