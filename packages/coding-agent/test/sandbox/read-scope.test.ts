/**
 * `readScope: workspace` keeps what tools need to start readable: the install prefix behind a
 * symlinked tool on `PATH` (Homebrew: its Cellar) and the global git configuration files, never
 * through a link a contained process can re-point. The contained cases skip where no backend exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnContainedCommand } from "@oh-my-pi/pi-coding-agent/sandbox/command";
import { foldSiblingRoots, gitConfigRoots, toolInstallRoots } from "@oh-my-pi/pi-coding-agent/sandbox/context";
import { installRoot, splitAbsolutePath } from "@oh-my-pi/pi-coding-agent/sandbox/platform";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { cfgSandboxDenyRead, cfgSandboxReadScope } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	beginContainedSandboxTest,
	type ContainedSandboxTest,
	endContainedSandboxTest,
	SANDBOX_BACKEND_PRESENT,
} from "../helpers/sandbox-test-state";

const POSIX = process.platform !== "win32";
const sorted = (paths: readonly string[]): string[] => [...paths].sort();

let scratch: TempDir;
/** `<scratch>`, realpath'd, under the real home (on Linux the sandbox hides the host's /tmp). */
let root: string;

beforeEach(() => {
	scratch = TempDir.createSync(path.join(os.homedir(), ".omp-read-scope-"));
	root = fs.realpathSync(scratch.path());
});

afterEach(() => {
	scratch.removeSync();
});

function file(p: string, executable = true, content = "#!/bin/sh\n"): string {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content, { mode: executable ? 0o755 : 0o644 });
	return p;
}

function link(target: string, at: string): string {
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.symlinkSync(target, at);
	return at;
}

/** `<base>/brew`: a Homebrew-style prefix whose `bin` links into kegs of its `Cellar`. */
function brewPrefix(base = root) {
	const prefix = path.join(base, "brew");
	const bin = path.join(prefix, "bin");
	const cellar = path.join(prefix, "Cellar");
	file(path.join(cellar, "python@3.9", "3.9.1", "bin", "python3"));
	file(path.join(cellar, "tool", "1.0", "libexec", "bin", "tool"));
	fs.mkdirSync(path.join(cellar, "libdep", "2.0", "lib"), { recursive: true });
	link("../Cellar/python@3.9/3.9.1/bin/python3", path.join(bin, "python3"));
	link("../Cellar/tool/1.0/libexec/bin/tool", path.join(bin, "tool"));
	link("../Cellar/libdep/2.0", path.join(prefix, "opt", "libdep"));
	return { prefix, bin, cellar };
}

describe.skipIf(!POSIX)("installRoot", () => {
	const home = "/home/corp/users/u";

	it("widens over bin/libexec but never to a home-level directory or a root child", () => {
		expect(installRoot("/opt/app/bin/tool", home, "linux")).toBe("/opt/app");
		expect(installRoot("/opt/app/libexec/bin/tool", home, "linux")).toBe("/opt/app");
		expect(installRoot("/usr/bin/tool", home, "linux")).toBe("/usr/bin");
		expect(installRoot(`${home}/bin/tool`, home, "linux")).toBe(`${home}/bin`);
		expect(installRoot(`${home}/.cargo/bin/tool`, home, "linux")).toBe(`${home}/.cargo/bin`);
		// `/home/corp` is an ancestor of home: the widening stops below it.
		expect(installRoot("/home/corp/bin/tool", home, "linux")).toBe("/home/corp/bin");
		expect(installRoot("C:\\tools\\app\\bin\\tool.exe", "C:\\Users\\u", "win32")).toBe("C:\\tools\\app\\bin");
	});

	it("grants nothing when the tool's own directory is home, a home ancestor, a root child or the root", () => {
		expect(installRoot(`${home}/script.sh`, home, "linux")).toBeUndefined();
		// A direct child of home other than bin/sbin/libexec grants nothing.
		expect(installRoot(`${home}/Documents/x.sh`, home, "linux")).toBeUndefined();
		expect(installRoot(`${home}/.cargo/tool`, home, "linux")).toBeUndefined();
		expect(installRoot("/home/corp/users/tool", home, "linux")).toBeUndefined();
		expect(installRoot("/opt/tool", home, "linux")).toBeUndefined();
		expect(installRoot("/tool", home, "linux")).toBeUndefined();
	});
});

describe.skipIf(!POSIX)("toolInstallRoots", () => {
	const home = "/nonexistent-home/user";
	const scan = (dirs: string[], readable: string[] = [], untrusted: string[] = []) =>
		toolInstallRoots(dirs, readable, untrusted, home, process.platform);

	it("grants a Homebrew Cellar once for all the kegs its links reach", () => {
		const { bin, cellar } = brewPrefix();
		expect(scan([bin], [bin])).toEqual([cellar]);
	});

	it("adds nothing for tools that are not symlinks", () => {
		const bin = path.join(root, "plain", "bin");
		file(path.join(bin, "tool"));
		expect(scan([bin], [bin])).toEqual([]);
	});

	it("skips symlinks to non-executables and to directories", () => {
		const bin = path.join(root, "p", "bin");
		const data = file(path.join(root, "store", "data", "readme"), false);
		link(data, path.join(bin, "readme"));
		link(path.dirname(data), path.join(bin, "dir"));
		expect(scan([bin], [bin])).toEqual([]);
	});

	it("skips a link that already resolves inside a readable root", () => {
		const { bin, cellar } = brewPrefix();
		expect(scan([bin], [bin, cellar])).toEqual([]);
	});

	it("grants nothing for a tool directly in home or a root child", () => {
		const fakeHome = path.join(root, "home");
		const bin = path.join(root, "p", "bin");
		link(file(path.join(fakeHome, "backup.sh")), path.join(bin, "backup"));
		expect(toolInstallRoots([bin], [bin], [], fakeHome, process.platform)).toEqual([]);
		const cargo = file(path.join(fakeHome, ".cargo", "bin", "tool"));
		link(cargo, path.join(bin, "tool"));
		expect(toolInstallRoots([bin], [bin], [], fakeHome, process.platform)).toEqual([path.dirname(cargo)]);
	});

	it.skipIf(process.platform !== "darwin")(
		"never grants home or a home-level directory for a recased spelling of home",
		() => {
			const fakeHome = path.join(root, "home");
			const recased = (p: string): string => p.toUpperCase();
			const script = file(path.join(fakeHome, "script.sh"));
			const documents = file(path.join(fakeHome, "Documents", "x.sh"));
			const cargo = file(path.join(fakeHome, ".cargo", "bin", "tool"));
			// The default macOS volume ignores case; a case-sensitive one has nothing to test.
			if (!fs.existsSync(recased(script))) return;
			const bin = path.join(root, "p", "bin");
			link(recased(script), path.join(bin, "script"));
			link(recased(documents), path.join(bin, "docs"));
			expect(toolInstallRoots([bin], [bin], [], fakeHome, process.platform)).toEqual([]);
			expect(toolInstallRoots([recased(bin)], [], [], fakeHome, process.platform)).toEqual([]);
			// A grant that is allowed comes out in the canonical spelling.
			link(recased(cargo), path.join(bin, "tool"));
			expect(toolInstallRoots([bin], [bin], [], fakeHome, process.platform)).toEqual([path.dirname(cargo)]);
		},
	);

	describe("untrusted roots", () => {
		let workspace: string;
		let secret: string;
		beforeEach(() => {
			workspace = path.join(root, "work");
			secret = file(path.join(root, "secret", "bin", "tool"));
		});

		it("never scans a PATH directory inside the workspace", () => {
			const bin = path.join(workspace, "node_modules", ".bin");
			link(secret, path.join(bin, "tool"));
			expect(scan([bin], [workspace], [workspace])).toEqual([]);
			expect(scan([bin], [workspace])).toEqual([path.join(root, "secret")]);
		});

		it("never scans a PATH directory reaching the workspace through a symlinked directory", () => {
			link(secret, path.join(workspace, "node_modules", ".bin", "tool"));
			const alias = link(workspace, path.join(root, "alias"));
			expect(scan([path.join(alias, "node_modules", ".bin")], [], [workspace])).toEqual([]);
		});

		it("grants nothing for a link whose chain passes through a link in the workspace", () => {
			const bin = path.join(root, "trusted", "bin");
			const planted = link(secret, path.join(workspace, "scripts", "tool"));
			link(planted, path.join(bin, "tool"));
			expect(scan([bin], [bin], [workspace])).toEqual([]);
			expect(scan([bin], [bin])).toEqual([path.join(root, "secret")]);
		});

		it("grants nothing for a link whose directory resolves through the workspace", () => {
			// `npm link`: lib/node_modules/x → the workspace, whose `bin` a contained process re-pointed.
			const bin = path.join(root, "trusted", "bin");
			link(workspace, path.join(root, "trusted", "lib", "node_modules", "x"));
			link(path.join(root, "secret", "bin"), path.join(workspace, "bin"));
			link("../lib/node_modules/x/bin/tool", path.join(bin, "tool"));
			expect(scan([bin], [bin], [workspace])).toEqual([]);
			expect(scan([bin], [bin])).toEqual([path.join(root, "secret")]);
		});

		it.skipIf(process.platform !== "darwin")("matches the workspace case-insensitively on macOS", () => {
			const ws = path.join(workspace, "ws");
			const bin = path.join(root, "trusted", "bin");
			link(secret, path.join(ws, "scripts", "tool"));
			// The default macOS volume ignores case; a case-sensitive one has nothing to test.
			const recased = path.join(root, "Work", "WS", "scripts", "tool");
			if (!fs.existsSync(recased)) return;
			link(recased, path.join(bin, "tool"));
			expect(scan([bin], [bin], [ws])).toEqual([]);
			expect(scan([bin], [bin])).toEqual([path.join(root, "secret")]);
		});
	});

	it("survives a symlink loop", () => {
		const bin = path.join(root, "p", "bin");
		link("loop-b", path.join(bin, "loop-a"));
		link("loop-a", path.join(bin, "loop-b"));
		expect(scan([bin], [bin])).toEqual([]);
	});

	it("folds many sibling roots outside home into their parent", () => {
		const bin = path.join(root, "tex", "bin");
		const scripts = path.join(root, "tex", "scripts");
		const add = (from: number, to: number) => {
			for (let i = from; i < to; i++) link(file(path.join(scripts, `pkg${i}`, `s${i}.pl`)), path.join(bin, `s${i}`));
		};
		add(0, 7);
		expect(scan([bin], [bin]).length).toBe(7);
		add(7, 8);
		expect(scan([bin], [bin])).toEqual([scripts]);
		// Never inside home.
		expect(toolInstallRoots([bin], [bin], [], root, process.platform).length).toBe(8);
	});

	it("folds siblings only into a parent at least three levels deep", () => {
		const siblings = (parent: string) => Array.from({ length: 8 }, (_, i) => `${parent}/pkg${i}`);
		const shallow = siblings("/usr/local");
		expect(foldSiblingRoots(shallow, "/home/u", "linux")).toEqual(shallow);
		const deep = siblings("/usr/local/texlive/2026/texmf-dist/scripts");
		expect(foldSiblingRoots(deep, "/home/u", "linux")).toEqual(["/usr/local/texlive/2026/texmf-dist/scripts"]);
		const threeDeep = siblings("/usr/local/texlive");
		expect(foldSiblingRoots(threeDeep, "/home/u", "linux")).toEqual(["/usr/local/texlive"]);
	});

	it("stops after the link and root limits", () => {
		const many = path.join(root, "many");
		const dataFile = file(path.join(root, "data"), false);
		for (let i = 0; i < 4000; i++) link(dataFile, path.join(many, `l${i}`));
		const alias = link(many, path.join(root, "alias"));
		const last = path.join(root, "last", "bin");
		link(file(path.join(root, "opt", "app", "bin", "tool")), path.join(last, "tool"));
		// `many` and its alias are one directory, scanned once: the budget still reaches `last`.
		expect(scan([many, alias, last])).toEqual([path.join(root, "opt", "app")]);
		const more = path.join(root, "more");
		for (let i = 0; i < 100; i++) link(dataFile, path.join(more, `l${i}`));
		expect(scan([many, more, last])).toEqual([]);

		const wide = path.join(root, "wide");
		for (let i = 0; i < 600; i++)
			link(file(path.join(root, "t", `p${i}`, "x", "bin", "tool")), path.join(wide, `t${i}`));
		expect(scan([wide]).length).toBe(512);
	});

	it("scans nothing on Windows", () => {
		const { bin } = brewPrefix();
		expect(toolInstallRoots([bin], [], [], home, "win32")).toEqual([]);
	});
});

describe.skipIf(!POSIX)("spawnContainedCommand", () => {
	it("grants a symlinked command's Cellar, its directory for a plain one or one directly in home", async () => {
		const { bin, cellar } = brewPrefix();
		const fakeHome = path.join(root, "home");
		vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
		try {
			const requests: { extraRead?: readonly string[] }[] = [];
			const runtime = {
				spawn: async (request: { extraRead?: readonly string[] }) => {
					requests.push(request);
					return undefined;
				},
			} as unknown as SandboxRuntime;
			const plain = file(path.join(root, "plain", "bin", "tool"));
			const inHome = link(file(path.join(fakeHome, "server.sh")), path.join(root, "links", "server"));
			for (const command of [path.join(bin, "python3"), plain, inHome]) {
				await spawnContainedCommand(runtime, { argv: [command], cwd: root, what: "test command" });
			}
			expect(requests.map(request => request.extraRead)).toEqual([
				[bin, cellar],
				[path.dirname(plain)],
				[path.dirname(inHome), fakeHome],
			]);
		} finally {
			vi.restoreAllMocks();
		}
	});
});

describe.skipIf(!POSIX)("gitConfigRoots", () => {
	let home: string;
	beforeEach(() => {
		home = path.join(root, "home");
		fs.mkdirSync(home);
	});
	const roots = (env: Record<string, string> = {}, pathDirs: string[] = [], untrusted: string[] = []) =>
		sorted(gitConfigRoots(home, env, pathDirs, untrusted, process.platform));

	it("grants the existing global config files, never the XDG git directory", () => {
		const xdgGit = path.join(home, ".config", "git");
		file(path.join(xdgGit, "credentials"), false);
		expect(roots()).toEqual([]);
		const files = [
			file(path.join(home, ".gitconfig"), false),
			file(path.join(xdgGit, "config"), false),
			file(path.join(xdgGit, "ignore"), false),
			file(path.join(xdgGit, "attributes"), false),
		];
		expect(roots()).toEqual(sorted(files));
	});

	it("reads $XDG_CONFIG_HOME and an absolute $GIT_CONFIG_GLOBAL; skips /dev/null and relative values", () => {
		const xdgConfig = file(path.join(root, "xdg", "git", "config"), false);
		const explicit = file(path.join(root, "elsewhere", "gitconfig"), false);
		expect(roots({ XDG_CONFIG_HOME: path.join(root, "xdg"), GIT_CONFIG_GLOBAL: explicit })).toEqual(
			sorted([xdgConfig, explicit]),
		);
		expect(roots({ GIT_CONFIG_GLOBAL: "/dev/null" })).toEqual([]);
		// Both resolve from the current directory, but git does not take relative values so.
		const cwd = process.cwd();
		process.chdir(root);
		try {
			expect(roots({ GIT_CONFIG_GLOBAL: path.join("elsewhere", "gitconfig"), XDG_CONFIG_HOME: "xdg" })).toEqual([]);
		} finally {
			process.chdir(cwd);
		}
	});

	it("treats an impossible path as absent", () => {
		const rc = file(path.join(home, ".gitconfig"), false);
		expect(roots({ GIT_CONFIG_GLOBAL: "/etc/hosts/x" })).toEqual([rc]);
	});

	it.skipIf(process.getuid?.() === 0)("treats an unreadable path as absent", () => {
		const rc = file(path.join(home, ".gitconfig"), false);
		const locked = path.join(root, "locked");
		file(path.join(locked, "git", "config"), false);
		fs.chmodSync(locked, 0o000);
		try {
			expect(roots({ XDG_CONFIG_HOME: locked, GIT_CONFIG_GLOBAL: path.join(locked, "gitconfig") })).toEqual([rc]);
		} finally {
			fs.chmodSync(locked, 0o755);
		}
	});

	it("grants a symlinked ~/.gitconfig through its target, unless the chain passes the workspace", () => {
		const target = file(path.join(root, "dotfiles", "gitconfig"), false);
		const workspace = path.join(root, "work");
		link(target, path.join(workspace, "gitconfig"));
		link(path.join(workspace, "gitconfig"), path.join(home, ".gitconfig"));
		expect(roots()).toEqual([target]);
		expect(roots({}, [], [workspace])).toEqual([]);
	});

	it("follows plain include and includeIf paths, five levels deep", () => {
		const local = file(path.join(home, ".gitconfig.local"), false);
		const work = file(path.join(home, "conf", "work.inc"), false, '[include]\n\tpath = "nested.inc" ; trailing\n');
		const nested = file(path.join(home, "conf", "nested.inc"), false, "[include]\n\tpath = ../.gitconfig\n");
		file(
			path.join(home, ".gitconfig"),
			false,
			[
				"[user]",
				"\tpath = not-an-include",
				"[include]",
				"\tpath = ~/.gitconfig.local",
				'[includeIf "gitdir:~/work/"]',
				"\tPath = conf/work.inc",
				"[include]",
				"\tpath = ~other/x",
				"\tpath = %(prefix)/etc/x",
			].join("\n"),
		);
		file(path.join(home, "not-an-include"), false);
		expect(roots()).toEqual(sorted([path.join(home, ".gitconfig"), local, work, nested]));

		const chain = Array.from({ length: 8 }, (_, i) => path.join(root, "chain", `c${i}`));
		chain.forEach((entry, i) => {
			file(entry, false, i + 1 < chain.length ? `[include]\n\tpath = c${i + 1}\n` : "");
		});
		fs.rmSync(path.join(home, ".gitconfig"));
		expect(roots({ GIT_CONFIG_GLOBAL: chain[0] })).toEqual(sorted(chain.slice(0, 6)));
	});

	it("grants no include that resolves through the workspace", () => {
		const workspace = path.join(root, "work");
		const secret = file(path.join(root, "secret", "notes"), false);
		link(secret, path.join(workspace, "inc"));
		file(path.join(home, ".gitconfig"), false, `[include]\n\tpath = ${path.join(workspace, "inc")}\n`);
		expect(roots({}, [], [workspace])).toEqual([path.join(home, ".gitconfig")]);
	});

	it.skipIf(process.platform !== "darwin")(
		"checks the workspace by its real path, not by a spelling in another Unicode normalization",
		() => {
			const workspace = path.join(root, "caf\u00e9");
			const secret = file(path.join(root, "secret", "notes"), false);
			link(secret, path.join(workspace, "inc"));
			const variant = path.join(root, "cafe\u0301", "inc");
			// APFS ignores normalization; a volume that does not has nothing to test.
			if (!fs.existsSync(variant)) return;
			expect(roots({ GIT_CONFIG_GLOBAL: variant }, [], [workspace])).toEqual([]);
			// A variant spelling outside the workspace still resolves, to the stored spelling.
			const outside = file(path.join(root, "na\u00efve", "gitconfig"), false);
			expect(roots({ GIT_CONFIG_GLOBAL: path.join(root, "nai\u0308ve", "gitconfig") }, [], [workspace])).toEqual([
				outside,
			]);
		},
	);

	it.skipIf(process.platform !== "darwin" || process.getuid?.() === 0)(
		"treats a directory whose real path cannot be read as untrusted",
		() => {
			const searchOnly = path.join(root, "search-only");
			const config = file(path.join(searchOnly, "conf", "gitconfig"), false);
			expect(roots({ GIT_CONFIG_GLOBAL: config })).toEqual([config]);
			fs.chmodSync(searchOnly, 0o111);
			try {
				// macOS cannot realpath a directory it may only search; where it can, nothing to test.
				try {
					fs.realpathSync(searchOnly);
					return;
				} catch {}
				expect(roots({ GIT_CONFIG_GLOBAL: config })).toEqual([]);
			} finally {
				fs.chmodSync(searchOnly, 0o755);
			}
		},
	);

	it("resolves a relative include after following links, as git does", () => {
		const physical = path.join(root, "real");
		const config = file(path.join(physical, "a", "gitconfig"), false, "[include]\n\tpath = ../x/inc\n");
		const included = file(path.join(physical, "x", "inc"), false);
		// Lexically `<root>/x/inc`: the sibling of the link, not of its target.
		file(path.join(root, "x", "inc"), false);
		const viaLink = link(path.join(physical, "a"), path.join(root, "lnk"));
		expect(roots({ GIT_CONFIG_GLOBAL: path.join(viaLink, "gitconfig") })).toEqual(sorted([config, included]));
	});

	it("grants <prefix>/etc/gitconfig when the first git on PATH is a Homebrew link", () => {
		const { prefix, bin } = brewPrefix();
		link("../Cellar/git/2.0/bin/git", path.join(bin, "git"));
		file(path.join(prefix, "Cellar", "git", "2.0", "bin", "git"));
		const system = file(path.join(prefix, "etc", "gitconfig"), false);
		const notExecutable = path.join(root, "noexec", "bin");
		file(path.join(notExecutable, "git"), false);
		expect(roots({}, [notExecutable, bin])).toEqual([system]);
		const other = path.join(root, "other", "bin");
		file(path.join(other, "git"));
		expect(roots({}, [other, bin])).toEqual([]);
	});
});

describe.skipIf(!POSIX)("SandboxRuntime under workspace scope", () => {
	let fx: ContainedSandboxTest;
	let home: string;

	beforeEach(async () => {
		fx = await beginContainedSandboxTest("read-scope");
		home = path.join(fs.realpathSync(fx.scratch.path()), "home");
		fs.mkdirSync(home);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		delete process.env.XDG_CONFIG_HOME;
		delete process.env.GIT_CONFIG_GLOBAL;
		cfgSandboxReadScope.set(fx.settings, "workspace");
	});

	afterEach(async () => {
		await endContainedSandboxTest(fx);
	});

	async function run(argv: string[], env: Record<string, string>) {
		const instance = await SandboxRuntime.for(fx.workspace);
		const child = await instance.spawn({ argv, cwd: fx.workspace, env });
		child.stdin.end();
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	}

	it("reads the Cellar behind a symlinked PATH tool and the git config files", async () => {
		const { bin, cellar } = brewPrefix(fx.outside);
		process.env.PATH = bin;
		const rc = file(path.join(home, ".gitconfig"), false);
		const policy = (await SandboxRuntime.for(fx.workspace)).effectivePolicy();
		expect(policy.readonlyPaths).toEqual(expect.arrayContaining([cellar, rc]));
	});

	it("adds nothing for plain PATH tools, links outside PATH, or without git configuration", async () => {
		const bin = path.join(fx.outside, "plain", "bin");
		file(path.join(bin, "tool"));
		process.env.PATH = bin;
		// MXC discovers $CARGO_HOME too, but it is no PATH directory: its links are not followed.
		const { bin: brewBin } = brewPrefix(fx.outside);
		const cargo = path.join(fx.outside, "cargo");
		link(path.join(brewBin, "python3"), path.join(cargo, "python3"));
		process.env.CARGO_HOME = cargo;
		const policy = (await SandboxRuntime.for(fx.workspace)).effectivePolicy();
		const extra = policy.readonlyPaths.filter(
			entry => (entry.startsWith(fx.outside) && entry !== bin && entry !== cargo) || entry.startsWith(home),
		);
		expect(extra).toEqual([]);
	});

	it.skipIf(!SANDBOX_BACKEND_PRESENT)(
		"keeps a granted git config unreadable under a wider denyRead",
		async () => {
			const config = file(path.join(home, ".config", "git", "config"), false, "[user]\n\tname = Hidden\n");
			cfgSandboxDenyRead.set(fx.settings, [path.join(home, ".config")]);
			const instance = await SandboxRuntime.for(fx.workspace);
			expect(instance.effectivePolicy().readonlyPaths).not.toContain(config);
			const result = await run(["/bin/cat", config], { PATH: "/usr/bin:/bin" });
			expect(result.code).not.toBe(0);
			expect(result.stdout).not.toContain("Hidden");
		},
		30_000,
	);

	const gitPath = Bun.which("git");
	it.skipIf(!SANDBOX_BACKEND_PRESENT || !gitPath)(
		"runs git with a global config that includes another file",
		async () => {
			fs.writeFileSync(path.join(home, ".gitconfig"), "[include]\n\tpath = ~/.gitconfig.local\n");
			fs.writeFileSync(path.join(home, ".gitconfig.local"), "[user]\n\tname = Read Scope\n");
			const env = { PATH: process.env.PATH ?? "", HOME: home };
			const result = await run([gitPath ?? "git", "config", "--includes", "--global", "user.name"], env);
			expect(result.stderr).not.toContain("Operation not permitted");
			expect(result.stdout.trim()).toBe("Read Scope");
		},
		30_000,
	);

	const homebrewPython = "/opt/homebrew/bin/python3";
	it.skipIf(
		!SANDBOX_BACKEND_PRESENT || !fs.existsSync(homebrewPython) || !fs.lstatSync(homebrewPython).isSymbolicLink(),
	)(
		"starts a Homebrew python3, whose framework and dependencies lie in the Cellar",
		async () => {
			process.env.PATH = "/opt/homebrew/bin";
			const result = await run([homebrewPython, "-c", "import ssl; print(6 * 7)"], {
				PATH: process.env.PATH,
				HOME: home,
			});
			expect(result.stderr).not.toContain("Library not loaded");
			expect(result.stdout.trim()).toBe("42");
		},
		30_000,
	);
});

describe("gitConfigRoots on Windows", () => {
	let home: string;
	beforeEach(() => {
		home = path.join(root, "home");
		fs.mkdirSync(home);
	});
	/** Whether the file symlink was created: without Developer Mode or elevation Windows refuses it. */
	const symlinked = (target: string, at: string): boolean => {
		fs.mkdirSync(path.dirname(at), { recursive: true });
		try {
			fs.symlinkSync(target, at, "file");
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
			throw error;
		}
	};
	const slashed = (p: string): string => p.replaceAll("\\", "/");

	it.skipIf(process.platform !== "win32")(
		"follows an include through a link whose target spells the drive with mixed separators",
		() => {
			const included = file(path.join(root, "real", "inc"), false);
			// `C:/Users/.../real\inc`: the drive root and the components spelled with both separators.
			const target = `${slashed(path.dirname(included))}\\inc`;
			const at = path.join(root, "links", "inc");
			if (!symlinked(target, at)) return;
			// git takes no backslash in an include value, so the config spells it `C:/...` too.
			const config = file(path.join(root, "cfg", "gitconfig"), false, `[include]\n\tpath = ${slashed(at)}\n`);
			expect(sorted(gitConfigRoots(home, { GIT_CONFIG_GLOBAL: config }, [], [], "win32"))).toEqual(
				sorted([config, included]),
			);
		},
	);

	it.skipIf(process.platform !== "win32")("never follows a device-path spelling of a workspace link", () => {
		const workspace = path.join(root, "work");
		const secret = file(path.join(root, "secret", "notes"), false);
		if (!symlinked(secret, path.join(workspace, "inc"))) return;
		const config = file(path.join(root, "cfg", "gitconfig"), false);
		for (const prefix of ["\\\\?\\", "\\\\.\\", "//?/"]) {
			const spelled = (p: string): string => (prefix === "//?/" ? slashed(prefix + p) : prefix + p);
			expect(
				gitConfigRoots(home, { GIT_CONFIG_GLOBAL: spelled(path.join(workspace, "inc")) }, [], [workspace], "win32"),
			).toEqual([]);
			expect(gitConfigRoots(home, { GIT_CONFIG_GLOBAL: spelled(config) }, [], [workspace], "win32")).toEqual([
				config,
			]);
		}
	});
});

describe("splitAbsolutePath", () => {
	it("takes a Windows drive or share root once, whichever separator spells the path", () => {
		expect(splitAbsolutePath("C:\\Users\\me\\.gitconfig", "win32")).toEqual({
			root: "C:\\",
			components: ["Users", "me", ".gitconfig"],
		});
		expect(splitAbsolutePath("C:/Users/me\\.gitconfig", "win32")).toEqual({
			root: "C:/",
			components: ["Users", "me", ".gitconfig"],
		});
		expect(splitAbsolutePath("\\\\srv\\share\\home\\.gitconfig", "win32")).toEqual({
			root: "\\\\srv\\share\\",
			components: ["home", ".gitconfig"],
		});
		expect(splitAbsolutePath("D:\\", "win32")).toEqual({ root: "D:\\", components: [] });
	});

	it("maps a Windows device-namespace drive or share to its plain root", () => {
		const drive = { root: "C:\\", components: ["ws", "inc"] };
		expect(splitAbsolutePath("\\\\?\\C:\\ws\\inc", "win32")).toEqual(drive);
		expect(splitAbsolutePath("\\\\.\\C:\\ws\\inc", "win32")).toEqual(drive);
		expect(splitAbsolutePath("//?/C:/ws/inc", "win32")).toEqual(drive);
		expect(splitAbsolutePath("\\\\?\\C:/ws\\inc", "win32")).toEqual(drive);
		expect(splitAbsolutePath("\\\\?\\D:", "win32")).toEqual({ root: "D:\\", components: [] });
		const share = { root: "\\\\srv\\share\\", components: ["home", ".gitconfig"] };
		expect(splitAbsolutePath("\\\\?\\UNC\\srv\\share\\home\\.gitconfig", "win32")).toEqual(share);
		expect(splitAbsolutePath("//?/unc/srv/share/home/.gitconfig", "win32")).toEqual(share);
		expect(splitAbsolutePath("\\\\?\\UNC\\srv\\share", "win32")).toEqual({
			root: "\\\\srv\\share\\",
			components: [],
		});
	});

	it("rejects any other Windows device-namespace root", () => {
		for (const device of [
			"\\\\.\\pipe\\x",
			"\\\\?\\Volume{0b1a2c3d-0000-0000-0000-000000000000}\\x",
			"\\\\.\\",
			"\\\\?\\",
			"\\\\.\\UNC\\srv\\share\\x",
			"\\\\?\\UNC\\srv",
			"\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x",
		]) {
			expect(splitAbsolutePath(device, "win32")).toBeUndefined();
		}
	});

	it("splits POSIX paths on slashes only, with no device namespace", () => {
		expect(splitAbsolutePath("/home//me/a\\b/../c", "linux")).toEqual({
			root: "/",
			components: ["home", "me", "a\\b", "..", "c"],
		});
		expect(splitAbsolutePath("/", "darwin")).toEqual({ root: "/", components: [] });
		expect(splitAbsolutePath("//?/C:/x", "linux")).toEqual({ root: "/", components: ["?", "C:", "x"] });
	});
});
