import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import * as libcModule from "@oh-my-pi/pi-coding-agent/session/libc";
import * as holders from "@oh-my-pi/pi-coding-agent/session/open-file-holders";
import { getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { getXattr } from "./helpers/xattr";

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
	"a reclaim leases every file it moves and every copy it frees, and with nothing holding them goes ahead",
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

		// The transcript and the artifact it moves, then the artifact's archived copy it frees.
		expect(answers).toEqual(["held", "held", "held"]);
		expect(result.reclaim?.freedCopies?.length).toBeGreaterThan(0);
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
			expect(said).toContain(`whether anything else holds ${sessionFile} open could not be proved`);
			expect(said).toMatch(/fcntl\(F_SETLEASE, F_WRLCK\) failed with E[A-Z]+/);
			expect(said).toContain(advice);
		}
		expect(preview.reclaim?.wouldReclaim).toBeUndefined();
		expect(result.reclaim?.reclaimed).toBe(0);
		expect(result.reclaim?.moved).toBeUndefined();
		expect(await Bun.file(artifact).text()).toBe("FIRST");
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		expect(await leftAside()).toEqual([]);
	});
}

// A lease asked about again and not answered is a failure to check, not an
// open by another process: a review made `fcntl(F_GETLEASE)` fail with `EIO`
// at each point a reclaim asks, and every report blamed a process that did
// not exist. Each point now says it could not check, and does what not
// knowing calls for: move the session back, keep the copy, or write the copy
// back.
for (const point of ["after the moves", "while judging a copy", "after a copy's unlink"] as const) {
	test.skipIf(!leasesGranted)(`a lease query that fails ${point} is reported as a failure to check`, async () => {
		const real = libcModule.libc();
		let failGetLease = false;
		let failed = false;
		spyOn(libcModule, "libc").mockReturnValue({
			...real,
			fcntl: (fd, cmd, arg) => {
				if (cmd === 1025 && failGetLease) {
					failed = true;
					return -1;
				}
				return real.fcntl?.(fd, cmd, arg) ?? -1;
			},
			errno: () => {
				if (!failed) return real.errno();
				failed = false;
				return os.constants.errno.EIO;
			},
		});
		const liveArtifacts = path.dirname(artifact);
		const copyDir = archiveFile.slice(0, -".jsonl.gz".length);
		const realRename = libcModule.renameNoReplace;
		spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
			const moved = await realRename(from, to);
			if (point === "after the moves" && from === liveArtifacts) failGetLease = true;
			if (point === "while judging a copy" && path.dirname(from) === copyDir && to.endsWith(".leaving")) {
				failGetLease = true;
			}
			return moved;
		});
		const realUnlink = fs.unlink;
		spyOn(fs, "unlink").mockImplementation(async file => {
			const name = String(file);
			if (point === "after a copy's unlink" && path.dirname(name) === copyDir && name.endsWith(".leaving")) {
				failGetLease = true;
			}
			return await realUnlink(file);
		});

		const result = await reclaim(true);
		mock.restore();

		const said = result.reclaim?.errors.join("\n") ?? "";
		expect(said).not.toContain("was opened by another process");
		expect(said).not.toContain("another process opened");
		expect(said).not.toMatch(/another process holds \S+ open \(/);
		if (point === "after the moves") {
			expect(result.reclaim?.reclaimed).toBe(0);
			expect(said).toContain("could not be checked");
			expect(said).toContain("whether its lease still stands could not be read (EIO)");
			expect(await Bun.file(sessionFile).exists()).toBe(true);
			expect(await Bun.file(artifact).text()).toBe("FIRST");
		} else {
			expect(result.reclaim?.reclaimed).toBe(1);
			const kept = result.reclaim?.keptCopies?.join("\n") ?? "";
			if (point === "while judging a copy") {
				expect(kept).toContain("could not be told");
				expect(kept).toContain("F_GETLEASE");
				expect(kept).toContain("EIO");
			} else {
				expect(kept).toContain("whether its lease still stands could not be read (EIO)");
				expect(kept).toContain("written back");
			}
			expect(await Bun.file(path.join(copyDir, "a.log")).text()).toBe("FIRST");
		}
	});
}

// The kernel refuses a lease while any other open of the file exists, this
// process's own included. A review held a read-only descriptor on a live
// artifact, and in turn on its archived copy, in the omp process itself, and
// each report named an invisible "another process". The report now names
// this process when it is the holder.
for (const held of ["the live artifact", "its archived copy"] as const) {
	test.skipIf(!leasesGranted || process.platform !== "linux")(
		`a reclaim says this process holds ${held} when it does, not another process`,
		async () => {
			const target =
				held === "the live artifact" ? artifact : path.join(archiveFile.slice(0, -".jsonl.gz".length), "a.log");
			const own = await fs.open(target, "r");
			try {
				const result = await reclaim(true);
				const said = result.reclaim?.errors.join("\n") ?? "";

				expect(said).toContain(`this omp process (${process.pid}) itself holds`);
				expect(said).toContain("1 other descriptor");
				expect(said).not.toContain("is open elsewhere");
				expect(said).not.toMatch(/another open of \S+ exists/);
				if (held === "the live artifact") {
					expect(result.reclaim?.reclaimed).toBe(0);
					expect(await Bun.file(artifact).text()).toBe("FIRST");
				} else {
					expect(result.reclaim?.reclaimed).toBe(1);
					expect(result.reclaim?.keptCopies?.join("\n")).toContain(target);
					expect(await Bun.file(target).text()).toBe("FIRST");
				}
			} finally {
				await own.close();
			}
		},
	);
}

// A descriptor count cannot see a mapping, and a lookup that fails leaves
// it incomplete. A review mapped the archived copy in the omp process, and
// in turn failed one `/proc/self/fd` lookup with `EIO` while it held the copy
// open, and each report said the other open was "not in this process".
for (const how of ["mapped by this process", "held by this process, one descriptor lookup failing"] as const) {
	test.skipIf(!leasesGranted || process.platform !== "linux")(
		`a reclaim never says an archived copy ${how} is held only outside this process`,
		async () => {
			const copy = path.join(archiveFile.slice(0, -".jsonl.gz".length), "a.log");
			// Held to the end of the reclaim, so the mapping stands while it runs.
			const mapping = how === "mapped by this process" ? Bun.mmap(copy, { shared: true }) : undefined;
			let own: fs.FileHandle | undefined;
			const realStat = fs.stat;
			let failed = false;
			if (how !== "mapped by this process") {
				own = await fs.open(copy, "r");
				const fd = own.fd;
				spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
					if (String(args[0]) === `/proc/self/fd/${fd}`) {
						failed = true;
						throw Object.assign(new Error("EIO: injected descriptor lookup"), { code: "EIO" });
					}
					return await Reflect.apply(realStat, fs, args);
				}) as typeof fs.stat);
			}
			try {
				const result = await reclaim(true);
				mock.restore();
				const said = result.reclaim?.errors.join("\n") ?? "";

				if (own) expect(failed).toBe(true);
				expect(result.reclaim?.reclaimed).toBe(1);
				expect(result.reclaim?.keptCopies?.join("\n")).toContain(copy);
				expect(said).toContain(`${copy} is open or mapped elsewhere`);
				expect(said).toContain("this one not excluded");
				expect(said).not.toContain("not in this process");
				expect(await Bun.file(copy).text()).toBe("FIRST");
				if (mapping) expect(Buffer.from(mapping).toString()).toBe("FIRST");
			} finally {
				mock.restore();
				await own?.close();
			}
		},
	);
}

test.skipIf(process.platform !== "linux")(
	"ownDescriptorCount is unknown, not smaller, when a descriptor lookup fails",
	async () => {
		const held = await fs.open(artifact, "r");
		const realStat = fs.stat;
		try {
			const identity = await held.stat();
			expect(await holders.ownDescriptorCount(identity)).toBe(1);
			spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
				if (String(args[0]) === `/proc/self/fd/${held.fd}`) {
					throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
				}
				return await Reflect.apply(realStat, fs, args);
			}) as typeof fs.stat);
			expect(await holders.ownDescriptorCount(identity)).toBeUndefined();
		} finally {
			mock.restore();
			await held.close();
		}
	},
);

// A lease refused with a permission error says what the error says: a
// review saw "this user does not own it" said of a file this user owned.
test.skipIf(!leasesGranted)("a lease refused with EACCES never claims another user owns the file", async () => {
	const real = libcModule.libc();
	let refused = false;
	spyOn(libcModule, "libc").mockReturnValue({
		...real,
		fcntl: (fd, cmd, arg) => {
			if (cmd === 1024 && arg !== 2) {
				refused = true;
				return -1;
			}
			return real.fcntl?.(fd, cmd, arg) ?? -1;
		},
		errno: () => (refused ? os.constants.errno.EACCES : real.errno()),
	});
	const result = await reclaim(true);
	mock.restore();

	const said = result.reclaim?.errors.join("\n") ?? "";
	expect(refused).toBe(true);
	expect(result.reclaim?.reclaimed).toBe(0);
	expect(said).toContain("EACCES");
	expect(said).not.toContain("does not own");
	expect((await fs.stat(sessionFile)).uid).toBe(process.getuid?.() ?? -1);
});

/** Whether this user may run a command as root without a password: setting a `security.*` attribute needs root. */
const sudoWorks = Bun.spawnSync(["sudo", "-n", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

// The archive carries none of a file's extended attributes: a file capability
// only a privileged process can set again, and a security label, which a new
// file gets from the policy instead. A reclaim moves the file itself, so a
// restore gives back the very file, attribute and all — set here for real,
// as root, on the file this user's gc then moves.
for (const [name, set] of [
	["security.capability", ["/usr/sbin/setcap", "cap_net_raw+ep"]],
	[
		"security.selinux",
		["/usr/bin/python3", "-c", "import os,sys; os.setxattr(sys.argv[1], 'security.selinux', b'LABEL')"],
	],
	[
		"security.SMACK64",
		["/usr/bin/python3", "-c", "import os,sys; os.setxattr(sys.argv[1], 'security.SMACK64', b'LABEL')"],
	],
] as const) {
	test.skipIf(!leasesGranted || !sudoWorks)(
		`(needs sudo -n) a file carrying ${name} comes back with it, the very file a reclaim moved`,
		async () => {
			const setting = Bun.spawnSync(["sudo", "-n", ...set, artifact], { stdout: "pipe", stderr: "pipe" });
			if (setting.exitCode !== 0) throw new Error(`setting ${name}: ${setting.stderr.toString()}`);
			const value = getXattr(artifact, name);
			expect(value).toBeDefined();
			const before = await fs.stat(artifact);

			const result = await reclaim(true);
			const restored = await runGcCommand({
				flags: { agentDir: root, restore: sessionId, apply: true, json: true },
			});

			expect(result.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
			expect(restored.restore?.errors).toEqual([]);
			const after = await fs.stat(artifact);
			expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
			expect(getXattr(artifact, name)).toBe(value);
			expect(await Bun.file(artifact).text()).toBe("FIRST");
		},
		60_000,
	);
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
