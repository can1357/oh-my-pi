import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	BUILTIN_SANDBOX_PROBES,
	classifyRootListing,
	createSandboxHost,
	mapLandlockProbeResult,
	nonoProbe,
	readSandboxFacts,
	SandboxDetector,
	type SandboxHost,
	type SandboxLandlock,
	type SandboxLayer,
	type SandboxProbe,
	type SandboxStatus,
	summarizeSandbox,
} from "../src/sandbox";
import { TempDir } from "../src/temp";

const INIT = {
	user: 0xeffffffd,
	pid: 0xeffffffc,
	uts: 0xeffffffe,
	ipc: 0xefffffff,
	cgroup: 0xeffffffb,
	time: 0xeffffffa,
};

const dirs: TempDir[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) dir.removeSync();
});

interface FakeTree {
	files?: Record<string, string>;
	links?: Record<string, string>;
}

/** A host reading a fake /proc tree; `/` is reported unlistable-unknown unless a test overrides it. */
function fakeHost(tree: FakeTree, overrides: Partial<SandboxHost> = {}): SandboxHost {
	const dir = TempDir.createSync("@omp-sandbox-");
	dirs.push(dir);
	const root = dir.path();
	for (const [file, text] of Object.entries(tree.files ?? {})) {
		fs.mkdirSync(path.dirname(root + file), { recursive: true });
		fs.writeFileSync(root + file, text);
	}
	for (const [link, target] of Object.entries(tree.links ?? {})) {
		fs.mkdirSync(path.dirname(root + link), { recursive: true });
		fs.symlinkSync(target, root + link);
	}
	return {
		...createSandboxHost(root),
		platform: "linux",
		env: {},
		cwd: "/home/alice/src/app",
		rootListing: () => undefined,
		sandboxCheck: () => undefined,
		...overrides,
	};
}

function nsLinks(inodes: Partial<Record<keyof typeof INIT, number>>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(inodes).map(([name, ino]) => [`/proc/self/ns/${name}`, `${name}:[${ino}]`]),
	);
}

const PLAIN_STATUS = "Name:\tbun\nNoNewPrivs:\t0\nSeccomp:\t0\nSeccomp_filters:\t0\n";
const CONFINED_STATUS = "Name:\tbun\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t3\n";

/** Detection with the built-in probes (or `probes`) against `host`. */
function detect(host: SandboxHost, probes?: SandboxProbe[], timeoutMs?: number): Promise<SandboxStatus> {
	return new SandboxDetector({ probes, host: () => host, timeoutMs }).detect();
}

describe("sandbox facts", () => {
	it("reads no_new_privs and seccomp from /proc/self/status, and leaves missing fields unknown", () => {
		const facts = readSandboxFacts(fakeHost({ files: { "/proc/self/status": CONFINED_STATUS } }));
		expect(facts.noNewPrivs).toBe(true);
		expect(facts.seccomp).toBe("filter");

		const old = readSandboxFacts(fakeHost({ files: { "/proc/self/status": "Name:\tbun\nSeccomp:\t1\n" } }));
		expect(old.noNewPrivs).toBeUndefined();
		expect(old.seccomp).toBe("strict");

		const unreadable = readSandboxFacts(fakeHost({}));
		expect(unreadable.noNewPrivs).toBeUndefined();
		expect(unreadable.seccomp).toBeUndefined();
	});

	it("compares namespace links with the fixed init inodes; unreadable links stay unknown", () => {
		const facts = readSandboxFacts(fakeHost({ links: nsLinks({ ...INIT, pid: 4026532410 }) }));
		expect(facts.namespaces.user).toBe("initial");
		expect(facts.namespaces.pid).toBe("non-initial");
		expect(facts.namespaces.time).toBe("initial");

		const partial = readSandboxFacts(fakeHost({ links: nsLinks({ user: INIT.user }) }));
		expect(partial.namespaces.user).toBe("initial");
		expect(partial.namespaces.cgroup).toBe("unknown");
	});

	it("reports a refused root listing only for a root-owned, world-readable / on a local filesystem", () => {
		const root = { uid: 0, mode: 0o40755 };
		expect(classifyRootListing({ ...root, listing: "EACCES" }, "ext4")).toBe("refused");
		expect(classifyRootListing({ ...root, listing: "ok" }, "ext4")).toBe("allowed");
		expect(classifyRootListing({ ...root, listing: "EACCES" }, "nfs4")).toBe("unknown");
		expect(classifyRootListing({ ...root, uid: 1000, listing: "EACCES" }, "ext4")).toBe("unknown");
		expect(classifyRootListing({ ...root, mode: 0o40700, listing: "EACCES" }, "ext4")).toBe("unknown");
		expect(classifyRootListing({ ...root, listing: "other" }, "ext4")).toBe("unknown");
	});

	it("judges a refused root listing by the filesystem of the last mount record for /", () => {
		const mountinfo = [
			"22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
			"23 22 0:5 / /proc rw - proc proc rw",
			"40 22 0:31 / / rw - nfs4 server:/export rw",
		];
		const rootListing = (records: string[]) =>
			readSandboxFacts(
				fakeHost(
					{ files: { "/proc/self/mountinfo": records.join("\n") } },
					{ rootListing: () => ({ uid: 0, mode: 0o40755, listing: "EPERM" }) },
				),
			).rootListing;
		expect(rootListing(mountinfo.slice(0, 2))).toBe("refused");
		// An NFS root mounted over the local one: a server can refuse the listing too.
		expect(rootListing(mountinfo)).toBe("unknown");
	});

	it("reads Seatbelt from sandbox_check on macOS and nothing from /proc there", () => {
		const darwin = (check: number | undefined) =>
			readSandboxFacts(
				fakeHost(
					{ files: { "/proc/self/status": CONFINED_STATUS } },
					{ platform: "darwin", sandboxCheck: () => check },
				),
			);
		expect(darwin(1).seatbelt).toBe(true);
		expect(darwin(0).seatbelt).toBe(false);
		expect(darwin(-1).seatbelt).toBeUndefined();
		expect(darwin(undefined).seatbelt).toBeUndefined();
		expect(darwin(1).noNewPrivs).toBeUndefined();
		expect(darwin(1).namespaces.pid).toBe("unknown");
	});

	it("reads optional kernel evidence without inferring access or namespace identity", () => {
		const facts = readSandboxFacts(
			fakeHost({
				files: {
					"/proc/self/status": `${CONFINED_STATUS}CapInh:\t0000000000000000\nCapPrm:\tABCDEF0123456789\nCapEff:\tbad-mask\nCapBnd:\t000000ffffffffff\nCapAmb:\t0\n`,
					"/proc/self/uid_map": "0 100000 65536\n",
					"/proc/self/gid_map": "0 200000 1\n1 300000 65535\n",
					"/sys/kernel/security/lsm": "capability,landlock,yama,apparmor\n",
					"/proc/self/attr/current": "profile-name (enforce)\n",
					"/proc/self/cgroup": "0::/user.slice/session.scope\n",
					"/proc/sys/kernel/yama/ptrace_scope": "1\n",
				},
				links: {
					...nsLinks(INIT),
					"/proc/self/ns/mnt": "mnt:[4026531840]",
					"/proc/self/ns/net": "net:[4026531992]",
				},
			}),
		);
		expect(facts.seccompFilters).toBe(3);
		expect(facts.capabilities).toEqual({
			inheritable: "0000000000000000",
			permitted: "ABCDEF0123456789",
			bounding: "000000ffffffffff",
			ambient: "0",
		});
		expect(facts.namespaceIdMaps).toEqual({
			uid: [{ inside: 0, outside: 100000, length: 65536 }],
			gid: [
				{ inside: 0, outside: 200000, length: 1 },
				{ inside: 1, outside: 300000, length: 65535 },
			],
		});
		expect(facts.namespaceInodes?.mnt).toBe("4026531840");
		expect(facts.namespaceInodes?.net).toBe("4026531992");
		expect(facts.namespaces.mnt).toBe("unknown");
		expect(facts.namespaces.net).toBe("unknown");
		expect(facts.lsm).toEqual(["capability", "landlock", "yama", "apparmor"]);
		expect(facts.lsmLabel).toBe("profile-name (enforce)");
		expect(facts.cgroup).toBe("0::/user.slice/session.scope");
		expect(facts.yamaPtraceScope).toBe(1);
	});

	it("leaves malformed and missing subordinate facts absent or unknown", () => {
		const facts = readSandboxFacts(
			fakeHost({
				files: {
					"/proc/self/status": "Seccomp_filters: 2junk\nCapEff: xyz\n",
					"/proc/self/uid_map": "0 1000 1\nmalformed\n",
					"/proc/self/gid_map": "-1 0 1\n",
					"/sys/kernel/security/lsm": "bad name\n",
					"/proc/self/attr/current": "\0invalid\n",
					"/proc/self/cgroup": "not-a-cgroup\n",
					"/proc/sys/kernel/yama/ptrace_scope": "1junk\n",
				},
				links: { "/proc/self/ns/user": "pid:[4026531837]", "/proc/self/ns/net": "net:[oops]" },
			}),
		);
		for (const name of [
			"seccompFilters",
			"capabilities",
			"namespaceIdMaps",
			"namespaceInodes",
			"lsm",
			"lsmLabel",
			"cgroup",
			"yamaPtraceScope",
		] as const)
			expect(facts[name]).toBeUndefined();
		expect(facts.namespaces.user).toBe("unknown");
	});

	it("isolates Landlock outcomes and never treats ABI support as a process domain", () => {
		const result = (ret: number, errno: number) => ({ exitCode: 0, stdout: JSON.stringify({ ret, errno }) });
		expect(mapLandlockProbeResult(result(4, 0))).toEqual({ state: "supported", abi: 4 });
		expect(mapLandlockProbeResult(result(-1, 38))).toEqual({ state: "unsupported" });
		expect(mapLandlockProbeResult(result(-1, 95))).toEqual({ state: "disabled" });
		expect(mapLandlockProbeResult(result(-1, 1))).toEqual({ state: "blocked" });
		expect(mapLandlockProbeResult({ exitCode: null, signalCode: "SIGSYS" })).toEqual({ state: "blocked" });
		expect(mapLandlockProbeResult({ exitCode: null, signalCode: "SIGKILL", exitedDueToTimeout: true })).toEqual({
			state: "unknown",
		});
		for (const stdout of ["", "not json", '{"ret":4.5,"errno":0}', '{"ret":4,"errno":1}', '{"ret":-1,"errno":"38"}'])
			expect(mapLandlockProbeResult({ exitCode: 0, stdout })).toEqual({ state: "unknown" });
	});

	it("asks the Landlock ABI only for a report: detection starts no child process and leaves the fact absent", async () => {
		const landlockAbi = mock(async (): Promise<SandboxLandlock> => ({ state: "supported", abi: 4 }));
		const detector = new SandboxDetector({ probes: [], host: () => fakeHost({}, { landlockAbi }) });
		expect((await detector.detect()).facts.landlock).toBeUndefined();
		expect(landlockAbi).not.toHaveBeenCalled();
		expect((await detector.inspect()).facts.landlock).toEqual({ state: "supported", abi: 4 });
		expect(detector.status?.facts.landlock).toBeUndefined();

		const spawn = spyOn(Bun, "spawn");
		try {
			const real = await new SandboxDetector().detect();
			expect(real.facts.landlock).toBeUndefined();
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
		}
	});

	it("keeps throwing hosts, malformed ABI data and fake-tree ABI unavailable", async () => {
		const throwing = () => {
			throw new Error("unreadable");
		};
		const facts = readSandboxFacts(fakeHost({}, { readFile: throwing, readLink: throwing, rootListing: throwing }));
		expect(facts.rootListing).toBe("unknown");
		expect(facts.namespaceInodes).toBeUndefined();
		const landlock = async (landlockAbi: SandboxHost["landlockAbi"]) =>
			(await new SandboxDetector({ probes: [], host: () => fakeHost({}, { landlockAbi }) }).inspect()).facts
				.landlock;
		expect(await landlock(throwing)).toEqual({ state: "unknown" });
		for (const value of [
			{ state: "supported" },
			{ state: "supported", abi: -1 },
			{ state: "supported", abi: 4.5 },
			{ state: "enforced", abi: 4 },
		]) {
			expect(await landlock(() => value as SandboxLandlock)).toEqual({ state: "unknown" });
		}
		expect(await fakeHost({}).landlockAbi?.()).toEqual({ state: "unknown" });
	});
});

const NONO_CAPS = JSON.stringify({
	fs: [
		{ path: "/home/alice/src/app", access: "readwrite", is_file: false },
		{ path: "/home/alice/src/app/secrets", access: "read", is_file: false },
		{ path: "/tmp", access: "readwrite", is_file: false },
		{ path: "/home/alice", access: "read", is_file: false },
		{ original: "/srv/data", access: "read", is_file: false },
	],
	deny_paths: ["/home/alice/.ssh"],
	net_blocked: true,
	blocked_commands: ["rm", "dd"],
});

function nonoHost(caps: string, overrides: Partial<SandboxHost> = {}): SandboxHost {
	return fakeHost(
		{ files: { "/tmp/.nono-42.json": caps } },
		{ env: { NONO_CAP_FILE: "/tmp/.nono-42.json", HOME: "/home/alice" }, ...overrides },
	);
}

describe("sandbox layers", () => {
	it("finds no layer on a plain host", async () => {
		const host = fakeHost({ files: { "/proc/self/status": PLAIN_STATUS }, links: nsLinks(INIT) });
		expect((await detect(host)).layers).toEqual([]);
	});

	it("reads nono's capability file into a declared layer on Linux and macOS", async () => {
		for (const platform of ["linux", "darwin"] as const) {
			const [layer] = (await detect(nonoHost(NONO_CAPS, { platform }))).layers;
			expect(layer.id).toBe("nono");
			expect(layer.basis).toBe("declared");
			expect(layer.restrictions.join(" ")).toContain("rm");
			expect(layer.restrictions.join(" ")).toContain("dd");
			expect(layer.network?.access).toBe("blocked");
			// Every grant and denied path is in a markdown detail section, none in a restriction phrase.
			const sections = (layer.details ?? []).flatMap(detail => ("markdown" in detail ? [detail.markdown] : []));
			for (const path of ["/home/alice/src/app", "/tmp", "/home/alice", "/srv/data", "/home/alice/.ssh"]) {
				expect(sections.join("\n")).toContain(path);
				expect(layer.restrictions.join(" ")).not.toContain(path);
			}
			// The capability file and the user profile directory are policy files for `/sandbox` to look up.
			const files = (layer.details ?? []).flatMap(detail => ("files" in detail ? detail.files : []));
			expect(files).toContainEqual(expect.objectContaining({ path: "/tmp/.nono-42.json" }));
			expect(files).toContainEqual({
				label: expect.any(String),
				path: "/home/alice/.config/nono/profiles",
				directory: true,
			});
		}
	});

	it("derives write access to the working directory and home from nono's grants", async () => {
		const files = async (cwd: string) => (await detect(nonoHost(NONO_CAPS, { cwd }))).layers[0].files;
		// A readwrite grant covers everything under it; a read grant on home does not make it writable.
		expect(await files("/home/alice/src/app/lib")).toEqual({ cwd: "writable", home: "read-only" });
		// A path no grant covers, and a path under a denied one, cannot be written.
		expect(await files("/opt/project")).toEqual({ cwd: "read-only", home: "read-only" });
		expect(await files("/home/alice/.ssh/keys")).toMatchObject({ cwd: "read-only" });
		// `/home/alice/src/application` is not under the `/home/alice/src/app` grant.
		expect(await files("/home/alice/src/application")).toMatchObject({ cwd: "read-only" });
		const noHome = await detect(nonoHost(NONO_CAPS, { env: { NONO_CAP_FILE: "/tmp/.nono-42.json" } }));
		expect(noHome.layers[0].files?.home).toBe("unknown");
	});

	it("reports nono's network as filtered through its proxy, open when the file says so, and absent otherwise", async () => {
		const network = async (caps: object, env: Record<string, string> = {}) => {
			const host = fakeHost(
				{ files: { "/tmp/caps.json": JSON.stringify({ fs: [], ...caps }) } },
				{ env: { NONO_CAP_FILE: "/tmp/caps.json", ...env } },
			);
			return (await detect(host)).layers[0].network;
		};
		expect(
			(await network({ net_blocked: false }, { HTTPS_PROXY: "http://nono:token@127.0.0.1:41000" }))?.access,
		).toBe("filtered");
		expect((await network({ net_blocked: false, allowed_domains: ["example.com"] }))?.access).toBe("filtered");
		expect((await network({ net_blocked: false }, { NONO_PROXY_TOKEN: "token" }))?.access).toBe("filtered");
		expect((await network({ net_blocked: true, allowed_domains: ["example.com"] }))?.access).toBe("blocked");
		expect((await network({ net_blocked: false }))?.access).toBe("open");
		expect(await network({})).toBeUndefined();
	});

	it("finds no nono layer when NONO_CAP_FILE names a missing or malformed file", async () => {
		const missing = fakeHost({}, { env: { NONO_CAP_FILE: "/tmp/gone.json" } });
		expect((await detect(missing)).layers).toEqual([]);
		const malformed = fakeHost({ files: { "/tmp/c.json": "{not json" } }, { env: { NONO_CAP_FILE: "/tmp/c.json" } });
		expect((await detect(malformed)).layers).toEqual([]);
	});

	it("reads NONO_CAP_FILE from the launch environment, never from a dotenv file", async () => {
		const dir = TempDir.createSync("@omp-sandbox-dotenv-");
		dirs.push(dir);
		const root = dir.path();
		const launch = path.join(root, "launch");
		const repo = path.join(root, "repo");
		fs.mkdirSync(launch);
		fs.mkdirSync(repo);
		fs.writeFileSync(path.join(root, "caps.json"), JSON.stringify({ fs: [{ path: repo, access: "readwrite" }] }));
		// The environment after startup holds NONO_CAP_FILE; the question is only where it came from.
		const env = { HOME: "/home/alice", NONO_CAP_FILE: "/caps.json" };
		const layers = async (launchDir: string) => {
			const host: SandboxHost = {
				...createSandboxHost(root, { env, cwd: repo, launchDir }),
				platform: "linux",
				rootListing: () => undefined,
				sandboxCheck: () => undefined,
			};
			return (await detect(host, [nonoProbe])).layers.map(layer => layer.id);
		};
		// No dotenv file defines it, so the launcher set it.
		expect(await layers(repo)).toEqual(["nono"]);
		// The launch directory's .env, loaded at startup, defined it; omp has since moved to `repo` (`--cwd`).
		fs.writeFileSync(path.join(launch, ".env"), "NONO_CAP_FILE=/caps.json\n");
		expect(await layers(launch)).toEqual([]);
		// The working directory's .env defines it.
		fs.writeFileSync(path.join(repo, ".env"), "NONO_CAP_FILE=/caps.json\n");
		expect(await layers(repo)).toEqual([]);
	});

	it("keeps the launcher's NONO_CAP_FILE in a real process whose launch directory's .env sets another", async () => {
		const dir = TempDir.createSync("@omp-sandbox-launch-env-");
		dirs.push(dir);
		const launch = path.join(dir.path(), "launch");
		const other = path.join(dir.path(), "other");
		fs.mkdirSync(launch);
		fs.mkdirSync(other);
		fs.writeFileSync(path.join(launch, ".env"), "NONO_CAP_FILE=/tmp/from-dotenv.json\n");
		const script = [
			`import { setProjectDir } from ${JSON.stringify(path.join(import.meta.dir, "../src/dirs.ts"))};`,
			`import { createSandboxHost } from ${JSON.stringify(path.join(import.meta.dir, "../src/sandbox.ts"))};`,
			`setProjectDir(${JSON.stringify(other)});`,
			"process.stdout.write(JSON.stringify(createSandboxHost().env.NONO_CAP_FILE ?? null));",
		].join("\n");
		const run = async (launcherValue: string | undefined): Promise<unknown> => {
			// Bun and omp load `launch/.env` at startup; the script then moves to `other`, as `--cwd` does.
			const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
				cwd: launch,
				env: { ...process.env, NONO_CAP_FILE: launcherValue },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			return JSON.parse(stdout);
		};
		expect(await run(undefined)).toBeNull();
		expect(await run("/tmp/from-launcher.json")).toBe("/tmp/from-launcher.json");
	});

	it("reports container markers as declared layers, outermost first, and does not call containerd docker", async () => {
		const host = fakeHost(
			{ files: { "/.dockerenv": "", "/var/run/secrets/kubernetes.io/serviceaccount/token": "x" } },
			{ env: { KUBERNETES_SERVICE_HOST: "10.0.0.1" } },
		);
		expect((await detect(host)).layers.map(l => [l.id, l.basis])).toEqual([
			["k8s", "declared"],
			["docker", "declared"],
		]);
		const podman = fakeHost({ files: { "/run/.containerenv": 'engine="podman-5.0.0"\n' } });
		expect((await detect(podman)).layers.map(l => l.id)).toEqual(["podman"]);
		const envOnly = fakeHost({}, { env: { KUBERNETES_SERVICE_HOST: "10.0.0.1" } });
		expect((await detect(envOnly)).layers).toEqual([]);

		const cgroup = (text: string) => fakeHost({ files: { "/proc/1/cgroup": text } });
		expect((await detect(cgroup("0::/system.slice/docker-4f2a.scope\n"))).layers.map(l => l.id)).toEqual(["docker"]);
		const pod = "0::/kubepods/besteffort/pod1234/cri-containerd-9a8b\n";
		expect((await detect(cgroup(pod))).layers).toEqual([]);
	});

	it("adds a measured confined layer from kernel facts only when no probe names the sandbox", async () => {
		const tree = { files: { "/proc/self/status": CONFINED_STATUS }, links: nsLinks({ ...INIT, pid: 4026532410 }) };
		const confined = { id: "confined", basis: "measured" };
		const status = await detect(fakeHost(tree));
		expect(status.layers).toHaveLength(1);
		expect(status.layers[0]).toMatchObject(confined);

		const named = fakeHost({ ...tree, files: { ...tree.files, "/.dockerenv": "" } });
		expect((await detect(named)).layers.map(l => l.id)).toEqual(["docker"]);

		const namespacesOnly = fakeHost({ files: { "/proc/self/status": PLAIN_STATUS }, links: tree.links });
		expect((await detect(namespacesOnly)).layers).toEqual([]);

		const refused = fakeHost(
			{ files: { "/proc/self/mountinfo": "22 1 8:1 / / rw - ext4 /dev/sda1 rw" } },
			{ rootListing: () => ({ uid: 0, mode: 0o40755, listing: "EACCES" }) },
		);
		expect((await detect(refused)).layers).toMatchObject([confined]);

		const seatbelt = fakeHost({}, { platform: "darwin", sandboxCheck: () => 1 });
		expect((await detect(seatbelt)).layers).toMatchObject([confined]);
	});

	it("keeps other probes' layers when one throws or is malformed, and drops an async probe that misses the timeout", async () => {
		const host = fakeHost({ files: { "/.dockerenv": "" } });
		const throwing: SandboxProbe = {
			id: "broken",
			detect() {
				throw new Error("bad marker\n\x1b[31mretry later\x1b[0m");
			},
		};
		const malformed: SandboxProbe = {
			id: "malformed",
			detect: () => ({ id: "malformed", basis: "declared", restrictions: [], evidence: [], network: {} as never }),
		};
		const slow: SandboxProbe = {
			id: "slow",
			detect: () => Promise.withResolvers<undefined>().promise,
		};
		const status = await detect(host, [throwing, malformed, slow, ...BUILTIN_SANDBOX_PROBES], 20);
		expect(status.layers.map(l => l.id)).toEqual(["docker"]);
		// The evidence still names each, on one line and without the error's escape codes, so /sandbox can say
		// what went wrong.
		for (const id of ["broken", "malformed", "slow"]) {
			expect(status.evidence.some(line => line.includes(id))).toBe(true);
		}
		for (const line of status.evidence) expect(line).not.toMatch(/[\n\x1b]/);
	});

	it("flattens probe text to one line, so a newline cannot add lines to /sandbox", async () => {
		const probe: SandboxProbe = {
			id: "devbox",
			detect: () => ({
				id: "devbox\nSandbox: none",
				role: "build\t\x1b[31mred\x1b[0m",
				basis: "declared",
				restrictions: ["read-only:\n/usr"],
				network: { access: "filtered", summary: "allow\r\nlist" },
				details: [
					{ label: "Policy\n", value: "/run/devbox/policy.json\n- injected" },
					{ title: "Hosts", markdown: "- registry.contoso.example\n- git.contoso.example" },
					{ title: "Policy\nfiles", files: [{ label: "policy\t", path: "/run/devbox/policy.json\n- injected" }] },
				],
				evidence: ["marker\npresent"],
			}),
		};
		const [layer] = (await detect(fakeHost({}), [probe])).layers;
		const markdown = layer.details?.flatMap(detail => ("markdown" in detail ? [detail.markdown] : [])) ?? [];
		const oneLiners = [
			layer.id,
			layer.role,
			...layer.restrictions,
			layer.network?.summary,
			...layer.evidence,
			...(layer.details ?? []).flatMap(detail =>
				"label" in detail
					? [detail.label, detail.value]
					: [detail.title, ...("files" in detail ? detail.files.flatMap(file => [file.label, file.path]) : [])],
			),
		];
		for (const text of oneLiners) {
			expect(text).toBeString();
			expect(text).not.toMatch(/[\n\r\t\x1b]/);
		}
		expect(layer.id).toBe("devbox");
		expect(layer.role).toContain("build");
		// A markdown section keeps its lines: it is rendered as markdown, never as a summary line.
		expect(markdown).toEqual(["- registry.contoso.example\n- git.contoso.example"]);
	});
});

describe("summarizeSandbox", () => {
	const layer = (id: string, extra: Partial<SandboxLayer>): SandboxLayer => ({
		id,
		basis: "declared",
		restrictions: [],
		evidence: [],
		...extra,
	});
	const status = (layers: SandboxLayer[]): SandboxStatus => ({
		platform: "linux",
		layers,
		facts: {
			namespaces: {
				mnt: "unknown",
				net: "unknown",
				user: "initial",
				pid: "initial",
				uts: "initial",
				ipc: "initial",
				cgroup: "initial",
				time: "initial",
			},
			rootListing: "unknown",
		},
		evidence: [],
	});

	it("takes the strictest files and network answer any layer gives, ignoring layers that report none", () => {
		const summary = summarizeSandbox(
			status([
				layer("docker", {}),
				layer("nono", {
					role: "build",
					files: { cwd: "writable", home: "writable" },
					network: { access: "open" },
				}),
				layer("devbox", {
					files: { cwd: "unknown", home: "read-only" },
					network: { access: "filtered", summary: "proxy" },
				}),
			]),
		);
		expect(summary).toEqual({
			label: "docker + nono:build + devbox",
			files: { cwd: "writable", home: "read-only" },
			network: { access: "filtered", summary: "proxy" },
		});
		expect(summarizeSandbox(status([layer("docker", {})]))).toEqual({
			label: "docker",
			files: { cwd: "unknown", home: "unknown" },
		});
	});
});

describe("SandboxDetector", () => {
	const marker = (id: string, evidence = `${id} marker`): SandboxProbe => ({
		id,
		detect: async () => ({ id, basis: "measured", restrictions: [], evidence: [evidence] }),
	});

	it("runs again when a probe registers after detection, so the late probe's layer is reported", async () => {
		const detector = new SandboxDetector({ probes: [], host: () => fakeHost({}) });
		expect((await detector.detect()).layers).toEqual([]);
		detector.register(marker("distro"));
		expect((await detector.detect()).layers.map(l => l.id)).toEqual(["distro"]);
		expect(detector.status?.layers.map(l => l.id)).toEqual(["distro"]);
	});

	it("reports probes registered before the first detection in that first status, in one run", async () => {
		let runs = 0;
		const detector = new SandboxDetector({
			probes: [],
			host: () => {
				runs++;
				return fakeHost({});
			},
		});
		detector.register(marker("early"));
		detector.register(marker("earlier"));
		expect((await detector.detect()).layers.map(l => l.id)).toEqual(["early", "earlier"]);
		expect(runs).toBe(1);
	});

	it("serves the re-run to a caller that was already waiting when a probe registered", async () => {
		const detector = new SandboxDetector({ probes: [marker("first")], host: () => fakeHost({}) });
		const waiting = detector.detect();
		detector.register(marker("second"));
		expect((await waiting).layers.map(l => l.id)).toEqual(["first", "second"]);
	});

	it("detects again for each report, so the files answer follows a working directory that has moved", async () => {
		let cwd = "/home/alice/src/app";
		const detector = new SandboxDetector({ host: () => nonoHost(NONO_CAPS, { cwd }) });
		expect((await detector.inspect()).layers[0].files?.cwd).toBe("writable");
		cwd = "/opt/project";
		expect((await detector.inspect()).layers[0].files?.cwd).toBe("read-only");
	});

	it("adds a probe's report() details for inspect() only, on every call, and survives a failing report", async () => {
		let calls = 0;
		const reporting: SandboxProbe = {
			...marker("devbox"),
			report: async layer => [{ label: "Session", value: `${layer.id} call ${++calls}\nnext` }],
		};
		const failing: SandboxProbe = {
			...marker("broken"),
			report: () => {
				throw new Error("no ticket");
			},
		};
		const detector = new SandboxDetector({ probes: [reporting, failing], host: () => fakeHost({}) });
		expect((await detector.detect()).layers.map(layer => layer.details)).toEqual([undefined, undefined]);
		expect(calls).toBe(0);

		const first = await detector.inspect();
		expect(first.layers[0].details).toEqual([{ label: "Session", value: "devbox call 1 next" }]);
		expect(first.layers[1].details).toBeUndefined();
		expect(first.evidence.some(line => line.includes("broken") && line.includes("no ticket"))).toBe(true);
		expect((await detector.inspect()).layers[0].details).toEqual([{ label: "Session", value: "devbox call 2 next" }]);
		// The cached status stays the cheap one.
		expect(detector.status?.layers[0].details).toBeUndefined();
	});

	it("keeps one probe per id: a probe registered under an existing id replaces it in its place", async () => {
		const detector = new SandboxDetector({
			probes: [marker("outer"), marker("inner"), marker("outer", "outer from the constructor's second entry")],
			host: () => fakeHost({}),
		});
		detector.register(marker("inner", "inner replaced"));
		const status = await detector.detect();
		expect(status.layers.map(l => [l.id, l.evidence[0]])).toEqual([
			["outer", "outer from the constructor's second entry"],
			["inner", "inner replaced"],
		]);
	});
});
