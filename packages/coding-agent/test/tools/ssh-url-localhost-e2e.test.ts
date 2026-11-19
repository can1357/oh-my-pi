import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as capability from "@oh-my-pi/pi-coding-agent/capability";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import type { CapabilityResult } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { SshProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/ssh-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

// Live integration against `ssh localhost`. Skips automatically where key-based
// localhost SSH is unavailable (CI without sshd). Capability lookup is mocked
// empty so "localhost"/"-oProxy…" resolve through the opaque-destination branch,
// exercising the real connection-manager + file-transfer over a real ssh process.
const SSH_OK = (() => {
	try {
		const r = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "localhost", "true"]);
		return r.exitCode === 0;
	} catch {
		return false;
	}
})();

function mockEmptyHosts(): void {
	const result: CapabilityResult<SSHHost> = {
		items: [],
		sources: [],
		diagnostics: [],
	} as unknown as CapabilityResult<SSHHost>;
	vi.spyOn(capability, "loadCapability").mockResolvedValue(result as CapabilityResult<unknown>);
}

const sh = async (script: string) => {
	await Bun.$`ssh -o BatchMode=yes localhost ${script}`.quiet();
};

describe.skipIf(!SSH_OK)("ssh:// handler against a real localhost ssh", () => {
	const handler = new SshProtocolHandler();
	const TMP = `/tmp/omp-ssh-e2e-${process.pid}`;

	beforeAll(async () => {
		await sh(`mkdir -p ${TMP}`);
	});

	afterAll(async () => {
		await Bun.$`ssh -o BatchMode=yes localhost rm -rf ${TMP}`.nothrow().quiet();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reads a real remote text file byte-exact", async () => {
		mockEmptyHosts();
		await sh(`printf 'alpha\\n\\tbeta\\n' > ${TMP}/read.txt`);
		const res = await handler.resolve(parseInternalUrl(`ssh://localhost${TMP}/read.txt`));
		expect(res.content).toBe("alpha\n\tbeta\n");
	});

	it("rejects an argument-injecting host before spawning ssh (no side effect runs)", async () => {
		mockEmptyHosts();
		await sh(`rm -f ${TMP}/PWNED`);
		// `-oProxyCommand=touch …` would execute locally if it reached ssh's argv.
		const url = parseInternalUrl(`ssh://-oProxyCommand=touch%20${encodeURIComponent(`${TMP}/PWNED`)}/etc/hostname`);
		await expect(handler.resolve(url)).rejects.toThrow(/must not begin with/);
		const pwned = await Bun.$`ssh -o BatchMode=yes localhost test -e ${TMP}/PWNED && echo yes || echo no`.text();
		expect(pwned.trim()).toBe("no");
	});

	it("rejects a real binary file via full-buffer validation", async () => {
		mockEmptyHosts();
		// 9000 'a' bytes (valid past the old 8 KiB window) then one invalid UTF-8 byte.
		await sh(`sh -c 'head -c 9000 /dev/zero | tr "\\0" a > ${TMP}/bin; printf "\\377" >> ${TMP}/bin'`);
		await expect(handler.resolve(parseInternalUrl(`ssh://localhost${TMP}/bin`))).rejects.toThrow(
			/binary or non-UTF-8/,
		);
	});

	it("writes byte-exact, leaves no temp, and the read path round-trips", async () => {
		mockEmptyHosts();
		const dest = `${TMP}/write.txt`;
		await handler.write(parseInternalUrl(`ssh://localhost${dest}`), "hi\n\t!\n");
		const back = await handler.resolve(parseInternalUrl(`ssh://localhost${dest}`));
		expect(back.content).toBe("hi\n\t!\n");
		// The uniquely-named temp must have been renamed away (no leftovers).
		const leftovers = await Bun.$`ssh -o BatchMode=yes localhost ls ${TMP} | grep -c omp-tmp || true`.text();
		expect(leftovers.trim()).toBe("0");
	});

	it("creates missing remote parent directories when writing a new nested file", async () => {
		mockEmptyHosts();
		const dest = `${TMP}/new/sub/notes.txt`;
		await handler.write(parseInternalUrl(`ssh://localhost${dest}`), "nested\n");
		const back = await handler.resolve(parseInternalUrl(`ssh://localhost${dest}`));
		expect(back.content).toBe("nested\n");
	});

	it("rejects a trailing-slash write target before staging (no directory created)", async () => {
		mockEmptyHosts();
		await expect(handler.write(parseInternalUrl(`ssh://localhost${TMP}/newdir/`), "x\n")).rejects.toThrow(
			/directory path|trailing/,
		);
		const exists = await Bun.$`ssh -o BatchMode=yes localhost test -d ${TMP}/newdir && echo yes || echo no`.text();
		expect(exists.trim()).toBe("no");
	});

	it("replaces a symlinked destination with a regular file (documented v1 limit)", async () => {
		mockEmptyHosts();
		await sh(`sh -c 'printf orig > ${TMP}/sym-target; ln -sf ${TMP}/sym-target ${TMP}/sym-link'`);
		await handler.write(parseInternalUrl(`ssh://localhost${TMP}/sym-link`), "replaced\n");
		const isLink =
			await Bun.$`ssh -o BatchMode=yes localhost test -L ${TMP}/sym-link && echo link || echo regular`.text();
		expect(isLink.trim()).toBe("regular");
		const back = await handler.resolve(parseInternalUrl(`ssh://localhost${TMP}/sym-link`));
		expect(back.content).toBe("replaced\n");
	});

	it("lists a real remote directory (dirs first, dotfiles included, no sourcePath)", async () => {
		mockEmptyHosts();
		await sh(`mkdir -p ${TMP}/listdir/sub && printf x > ${TMP}/listdir/a.txt && printf y > ${TMP}/listdir/.hidden`);
		const res = await handler.resolve(parseInternalUrl(`ssh://localhost${TMP}/listdir`));
		expect(res.isDirectory).toBe(true);
		expect(res.immutable).toBe(true); // listings are never editable
		expect(res.contentType).toBe("text/plain");
		expect(res.sourcePath).toBeUndefined();
		const lines = res.content.split("\n");
		expect(lines[0]).toBe("sub/"); // directories sort first
		expect(lines).toContain(".hidden"); // dotfiles included via ls -A
		expect(lines).toContain("a.txt");
		expect(lines).toHaveLength(3);
	});

	it("refuses to write to a directory and cleans up its temp", async () => {
		mockEmptyHosts();
		await sh(`mkdir -p ${TMP}/wdir`);
		await expect(handler.write(parseInternalUrl(`ssh://localhost${TMP}/wdir`), "x")).rejects.toThrow();
		const kind = await Bun.$`ssh -o BatchMode=yes localhost test -d ${TMP}/wdir && echo dir || echo notdir`.text();
		expect(kind.trim()).toBe("dir"); // directory intact, not clobbered into a file
		// The dir-error path must remove the temp it created beside the destination.
		const leftovers =
			await Bun.$`ssh -o BatchMode=yes localhost ls -A ${TMP} | grep -c "wdir.omp-tmp" || true`.text();
		expect(leftovers.trim()).toBe("0");
	});

	// GNU `stat -c` is Linux-only; `ssh localhost` targets this same machine, so
	// gate on the local platform. Defends finding 2: overwriting an existing
	// regular file preserves its ordinary permission bits and inode (in place),
	// rather than resetting them via an inode-replacing temp+rename.
	it.skipIf(process.platform !== "linux")(
		"overwrites an existing regular file in place, preserving its mode and inode",
		async () => {
			mockEmptyHosts();
			const dest = `${TMP}/perm.txt`;
			await sh(`printf orig > ${dest}; chmod 600 ${dest}`);
			const inode = async () => (await Bun.$`ssh -o BatchMode=yes localhost stat -c %i ${dest}`.text()).trim();
			const inodeBefore = await inode();
			await handler.write(parseInternalUrl(`ssh://localhost${dest}`), "new\n");
			const mode = (await Bun.$`ssh -o BatchMode=yes localhost stat -c %a ${dest}`.text()).trim();
			expect(mode).toBe("600");
			expect(await inode()).toBe(inodeBefore);
			const back = await handler.resolve(parseInternalUrl(`ssh://localhost${dest}`));
			expect(back.content).toBe("new\n");
		},
	);
});

describe.skipIf(!SSH_OK)("ssh:// through the real read/grep/write tools (localhost)", () => {
	const TMP = `/tmp/omp-ssh-tools-e2e-${process.pid}`;

	function createSession(): ToolSession {
		return {
			cwd: os.tmpdir(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
		};
	}

	function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
		return result.content
			.filter(c => c.type === "text")
			.map(c => c.text ?? "")
			.join("\n");
	}

	beforeAll(async () => {
		// Register built-in protocol handlers (incl. ssh) so the tools resolve ssh:// through the router.
		InternalUrlRouter.resetForTests();
		await sh(
			`mkdir -p ${TMP}; printf 'alpha\\n\\tbeta\\ngamma\\n' > ${TMP}/read.txt; awk 'BEGIN{print "ALPHALINE"; for(i=2;i<=9;i++)print "filler"i; print "OMEGALINE"}' > ${TMP}/range.txt`,
		);
	});

	afterAll(async () => {
		await Bun.$`ssh -o BatchMode=yes localhost rm -rf ${TMP}`.nothrow().quiet();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("ReadTool reads a remote file full and by range", async () => {
		mockEmptyHosts();
		const tool = new ReadTool(createSession());
		const full = textOf(await tool.execute("r-full", { path: `ssh://localhost${TMP}/read.txt` }));
		expect(full).toContain("alpha");
		expect(full).toContain("beta");
		expect(full).toContain("gamma");
		// `:1-1` plus the 3-line trailing context window covers lines 1-4; the
		// line-10 OMEGALINE marker proves the bounded range actually sliced.
		const range = textOf(await tool.execute("r-range", { path: `ssh://localhost${TMP}/range.txt:1-1` }));
		expect(range).toContain("ALPHALINE");
		expect(range).not.toContain("OMEGALINE");
	});

	it("GrepTool reports matches under the ssh:// URL with no scratch-temp leak", async () => {
		mockEmptyHosts();
		const tool = new GrepTool(createSession());
		const result = await tool.execute("s", { pattern: "beta", path: `ssh://localhost${TMP}/read.txt` });
		const out = textOf(result);
		expect(out).toContain("beta");
		// The resource is reported under its ssh:// URL, not a local scratch path.
		expect(result.details?.files).toContain(`ssh://localhost${TMP}/read.txt`);
		// The pure-virtual RE2 probe's scratch dir must never leak into text or metadata.
		const detailsJson = JSON.stringify(result.details ?? {});
		expect(out).not.toContain("omp-search-probe");
		expect(detailsJson).not.toContain("omp-search-probe");
	});

	it("WriteTool round-trips a remote file byte-exact", async () => {
		mockEmptyHosts();
		const dest = `ssh://localhost${TMP}/wtool.txt`;
		await new WriteTool(createSession()).execute("w", { path: dest, content: "hi\n\t!\n" });
		const onDisk = await Bun.$`ssh -o BatchMode=yes localhost cat ${TMP}/wtool.txt`.text();
		expect(onDisk).toBe("hi\n\t!\n");
		const back = textOf(await new ReadTool(createSession()).execute("rb", { path: dest }));
		expect(back).toContain("hi");
	});

	it("WriteTool refuses to overwrite a remote special file (FIFO) and leaves it intact", async () => {
		mockEmptyHosts();
		await sh(`rm -f ${TMP}/fifo; mkfifo ${TMP}/fifo`);
		await expect(
			new WriteTool(createSession()).execute("wf", { path: `ssh://localhost${TMP}/fifo`, content: "x" }),
		).rejects.toThrow(/special file/i);
		const kind = (
			await Bun.$`ssh -o BatchMode=yes localhost test -p ${TMP}/fifo && echo fifo || echo other`.text()
		).trim();
		expect(kind).toBe("fifo");
	});
});
