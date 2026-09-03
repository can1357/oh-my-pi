import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as collabCli from "@oh-my-pi/pi-coding-agent/cli/collab-cli";
import { runCollabListCommand } from "@oh-my-pi/pi-coding-agent/cli/collab-cli";
import {
	COLLAB_REGISTRY_VERSION,
	type CollabHostPublication,
	publishCollabHost,
} from "@oh-my-pi/pi-coding-agent/collab/registry";
import Collab from "@oh-my-pi/pi-coding-agent/commands/collab";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

interface HostFixture {
	sessionId: string;
	sessionName: string | null;
	cwd: string;
	pid: number;
	startedAt: number;
	participants: number;
	writeUrl: string;
	viewUrl: string;
}

const ALPHA: HostFixture = {
	sessionId: "sess-alpha",
	sessionName: "Alpha Session",
	cwd: "/tmp/work/alpha",
	pid: 111,
	startedAt: 1_700_000_000_000,
	participants: 3, // 2 guests
	writeUrl: "https://collab.test/#alpha-WRITE-url",
	viewUrl: "https://collab.test/#alpha-VIEW-url",
};

const BRAVO: HostFixture = {
	sessionId: "sess-bravo",
	sessionName: null,
	cwd: "/tmp/work/bravo",
	pid: 222,
	startedAt: 1_700_000_100_000,
	participants: 1, // 0 guests
	writeUrl: "https://collab.test/#bravo-WRITE-url",
	viewUrl: "https://collab.test/#bravo-VIEW-url",
};

const publications: CollabHostPublication[] = [];
const tmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-collab-cli-"));
	tmpDirs.push(dir);
	return dir;
}

async function publish(dir: string, fixture: HostFixture): Promise<CollabHostPublication> {
	const pub = await publishCollabHost(
		mode => ({
			sessionId: fixture.sessionId,
			sessionName: fixture.sessionName,
			cwd: fixture.cwd,
			pid: fixture.pid,
			startedAt: fixture.startedAt,
			participants: fixture.participants,
			url: mode === "view" ? fixture.viewUrl : fixture.writeUrl,
		}),
		{ dir },
	);
	publications.push(pub);
	return pub;
}

function collector(): { print: (line: string) => void; plain: () => string; calls: string[] } {
	const calls: string[] = [];
	return {
		print: line => calls.push(line),
		plain: () => Bun.stripANSI(calls.join("\n")),
		calls,
	};
}

afterEach(async () => {
	await Promise.all(publications.splice(0).map(pub => pub.close()));
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("runCollabListCommand", () => {
	it("reports no active hosts against an empty registry", async () => {
		const dir = makeTmpDir();
		const out = collector();

		await runCollabListCommand({ view: false, json: false, registry: { dir } }, out.print);

		expect(out.plain()).toBe("No active Collab hosts.");
	});

	it("renders write rows ordered by startedAt then pid with URLs, pids and guest counts", async () => {
		const dir = makeTmpDir();
		// Publish out of order to prove the command sorts, not the filesystem.
		await publish(dir, BRAVO);
		await publish(dir, ALPHA);
		const out = collector();

		await runCollabListCommand({ view: false, json: false, registry: { dir } }, out.print);

		const text = out.plain();
		expect(text).toContain("write");
		expect(text).toContain("pid 111");
		expect(text).toContain("pid 222");
		expect(text).toContain("2 guests");
		expect(text).toContain("0 guests");
		expect(text).toContain("Alpha Session (sess-alpha)");
		expect(text).toContain("sess-bravo");
		expect(text).toContain(ALPHA.writeUrl);
		expect(text).toContain(BRAVO.writeUrl);
		// Alpha (older startedAt) precedes Bravo.
		expect(text.indexOf(ALPHA.writeUrl)).toBeLessThan(text.indexOf(BRAVO.writeUrl));
	});

	it("renders view rows with view URLs and never leaks write URLs", async () => {
		const dir = makeTmpDir();
		await publish(dir, ALPHA);
		await publish(dir, BRAVO);
		const out = collector();

		await runCollabListCommand({ view: true, json: false, registry: { dir } }, out.print);

		const text = out.plain();
		expect(text).toContain("view");
		expect(text).toContain(ALPHA.viewUrl);
		expect(text).toContain(BRAVO.viewUrl);
		expect(text).not.toContain(ALPHA.writeUrl);
		expect(text).not.toContain(BRAVO.writeUrl);
	});

	it("emits deterministic write-mode JSON carrying only write URLs", async () => {
		const dir = makeTmpDir();
		await publish(dir, BRAVO);
		await publish(dir, ALPHA);
		const out = collector();

		await runCollabListCommand({ view: false, json: true, registry: { dir } }, out.print);

		// A single print call carries the full JSON document.
		expect(out.calls).toHaveLength(1);
		const parsed = JSON.parse(out.calls[0]!);
		expect(parsed).toEqual({
			version: COLLAB_REGISTRY_VERSION,
			mode: "write",
			hosts: [
				{
					sessionId: ALPHA.sessionId,
					sessionName: ALPHA.sessionName,
					cwd: ALPHA.cwd,
					pid: ALPHA.pid,
					startedAt: ALPHA.startedAt,
					participants: ALPHA.participants,
					mode: "write",
					url: ALPHA.writeUrl,
				},
				{
					sessionId: BRAVO.sessionId,
					sessionName: BRAVO.sessionName,
					cwd: BRAVO.cwd,
					pid: BRAVO.pid,
					startedAt: BRAVO.startedAt,
					participants: BRAVO.participants,
					mode: "write",
					url: BRAVO.writeUrl,
				},
			],
		});
		// The view URL never appears anywhere in write-mode output.
		expect(out.calls[0]).not.toContain(ALPHA.viewUrl);
		expect(out.calls[0]).not.toContain(BRAVO.viewUrl);

		// Repeated invocation yields byte-identical JSON.
		const again = collector();
		await runCollabListCommand({ view: false, json: true, registry: { dir } }, again.print);
		expect(again.calls[0]).toBe(out.calls[0]);
	});

	it("emits view-mode JSON carrying only view URLs", async () => {
		const dir = makeTmpDir();
		await publish(dir, ALPHA);
		const out = collector();

		await runCollabListCommand({ view: true, json: true, registry: { dir } }, out.print);

		const parsed = JSON.parse(out.calls[0]!);
		expect(parsed.mode).toBe("view");
		expect(parsed.hosts[0].url).toBe(ALPHA.viewUrl);
		expect(parsed.hosts[0].mode).toBe("view");
		expect(out.calls[0]).not.toContain(ALPHA.writeUrl);
	});
});

describe("Collab command contract", () => {
	it("warns that default output prints write-capable URLs granting host control", () => {
		const description = Collab.description.toLowerCase();
		expect(description).toContain("write-capable");
		expect(description).toContain("control");
		expect(description).toContain("view");
	});

	it("exposes view and json flags", () => {
		expect(Collab.flags).toHaveProperty("view");
		expect(Collab.flags).toHaveProperty("json");
	});

	const CONFIG = { bin: "omp", version: "0.0.0-test", commands: new Map() } as CliConfig;

	it("honors the `collab list view` spelling instead of silently printing write URLs", async () => {
		const runSpy = spyOn(collabCli, "runCollabListCommand").mockResolvedValue();
		try {
			await new Collab(["list", "view"], CONFIG).run();
			expect(runSpy).toHaveBeenCalledWith({ view: true, json: false });

			await new Collab(["list", "view", "--json"], CONFIG).run();
			expect(runSpy).toHaveBeenLastCalledWith({ view: true, json: true });
		} finally {
			runSpy.mockRestore();
		}
	});

	it("rejects unknown trailing arguments instead of degrading to write output", async () => {
		const runSpy = spyOn(collabCli, "runCollabListCommand").mockResolvedValue();
		try {
			await expect(new Collab(["list", "bogus"], CONFIG).run()).rejects.toThrow(/Unknown argument.*bogus/);
			expect(runSpy).not.toHaveBeenCalled();
		} finally {
			runSpy.mockRestore();
		}
	});
});
