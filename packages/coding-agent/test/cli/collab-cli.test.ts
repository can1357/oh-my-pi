import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as collabCli from "@oh-my-pi/pi-coding-agent/cli/collab-cli";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import {
	COLLAB_REGISTRY_VERSION,
	type CollabHostPublication,
	type CollabHostSnapshot,
	CollabLinkError,
	publishCollabHost,
	resolveCollabHostLink,
} from "@oh-my-pi/pi-coding-agent/collab/registry";
import Collab from "@oh-my-pi/pi-coding-agent/commands/collab";
import { type CliConfig, CliUsageError } from "@oh-my-pi/pi-utils/cli";

interface HostFixture {
	snapshot: CollabHostSnapshot;
	controlUrl: string;
	viewUrl: string;
}

const ALPHA: HostFixture = {
	snapshot: {
		instanceId: "host-alpha",
		generation: 2,
		pid: process.pid,
		sessionId: "sess-alpha",
		sessionName: "Alpha Session",
		cwd: "/tmp/work/alpha",
		model: { provider: "test", id: "alpha-model" },
		startedAt: 1_700_000_000_000,
		participants: 3,
		relayConnected: true,
		inputRequired: true,
		access: "control",
	},
	controlUrl: "https://collab.test/#alpha-CONTROL-url",
	viewUrl: "https://collab.test/#alpha-VIEW-url",
};

const BRAVO: HostFixture = {
	snapshot: {
		instanceId: "host-bravo",
		generation: 7,
		pid: process.pid,
		sessionId: "sess-bravo",
		sessionName: null,
		cwd: "/tmp/work/bravo",
		model: null,
		startedAt: 1_700_000_100_000,
		participants: 1,
		relayConnected: false,
		inputRequired: false,
		access: "view",
	},
	controlUrl: "https://collab.test/#bravo-CONTROL-url",
	viewUrl: "https://collab.test/#bravo-VIEW-url",
};

const publications: CollabHostPublication[] = [];
const tmpDirs: string[] = [];
const CONFIG: CliConfig = { bin: "omp", version: "0.0.0-test", commands: new Map() };

async function makeTmpDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-cli-"));
	tmpDirs.push(dir);
	return dir;
}

async function publish(dir: string, fixture: HostFixture): Promise<void> {
	const pub = await publishCollabHost(
		{
			snapshot: () => fixture.snapshot,
			link: access =>
				access === "view" ? fixture.viewUrl : fixture.snapshot.access === "control" ? fixture.controlUrl : null,
		},
		{ dir, instanceId: fixture.snapshot.instanceId },
	);
	publications.push(pub);
}

interface Collector {
	print: (line: string) => void;
	plain: () => string;
	calls: string[];
}

function collector(): Collector {
	const calls: string[] = [];
	return {
		print: line => calls.push(line),
		plain: () => Bun.stripANSI(calls.join("\n")),
		calls,
	};
}

/** Exercise parsing and real handlers while keeping registry and output isolated. */
async function runCommand(argv: string[], dir: string, out: Collector): Promise<void> {
	const list = collabCli.runCollabListCommand;
	const link = collabCli.runCollabLinkCommand;
	const listSpy = spyOn(collabCli, "runCollabListCommand").mockImplementation(args =>
		list({ ...args, registry: { dir } }, out.print),
	);
	const linkSpy = spyOn(collabCli, "runCollabLinkCommand").mockImplementation(args =>
		link({ ...args, registry: { dir } }, out.print),
	);
	try {
		await new Collab(argv, CONFIG).run();
	} finally {
		listSpy.mockRestore();
		linkSpy.mockRestore();
	}
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(publications.splice(0).map(pub => pub.close()));
	for (const dir of tmpDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("Collab CLI", () => {
	it("reports no active hosts against an empty registry", async () => {
		const dir = await makeTmpDir();
		const out = collector();
		await runCommand(["list"], dir, out);

		expect(out.plain()).toBe("No active Collab hosts.");
	});

	it("lists host identities, sessions, generations and attention state without either capability", async () => {
		const dir = await makeTmpDir();
		await publish(dir, BRAVO);
		await publish(dir, ALPHA);
		const out = collector();
		await runCommand(["list"], dir, out);

		const text = out.plain();
		expect(text).toContain("2 active Collab hosts");
		expect(text).toContain("host-alpha  Alpha Session (sess-alpha)  /tmp/work/alpha");
		expect(text).toContain("host-bravo  sess-bravo  /tmp/work/bravo");
		expect(text).toContain(`pid ${process.pid}`);
		expect(text).toContain("gen 2 · test/alpha-model");
		expect(text).toContain("gen 7 · no model");
		expect(text).toContain("2 guests · control · relay connected · input required");
		expect(text).toContain("0 guests · view · relay reconnecting");
		expect(text.indexOf(ALPHA.snapshot.instanceId)).toBeLessThan(text.indexOf(BRAVO.snapshot.instanceId));
		for (const fixture of [ALPHA, BRAVO]) {
			expect(text).not.toContain(fixture.controlUrl);
			expect(text).not.toContain(fixture.viewUrl);
		}
	});

	it("emits repeatable, two-space metadata-only JSON for list and the default action with -j", async () => {
		const dir = await makeTmpDir();
		await publish(dir, BRAVO);
		await publish(dir, ALPHA);
		const out = collector();
		await runCommand(["list", "--json"], dir, out);

		const expected = { version: COLLAB_REGISTRY_VERSION, hosts: [ALPHA.snapshot, BRAVO.snapshot] };
		expect(out.plain()).toBe(JSON.stringify(expected, null, 2));
		for (const fixture of [ALPHA, BRAVO]) {
			expect(out.plain()).not.toContain(fixture.controlUrl);
			expect(out.plain()).not.toContain(fixture.viewUrl);
		}
		const again = collector();
		await runCommand(["-j"], dir, again);
		expect(again.plain()).toBe(out.plain());
	});

	it("prints only the control URL when linking by instance ID", async () => {
		const dir = await makeTmpDir();
		await publish(dir, ALPHA);
		const out = collector();
		await runCommand(["link", ALPHA.snapshot.instanceId], dir, out);

		expect(out.calls).toEqual([ALPHA.controlUrl]);
	});

	it("prints only the view URL when --view is requested", async () => {
		const dir = await makeTmpDir();
		await publish(dir, ALPHA);
		const out = collector();
		await runCommand(["link", ALPHA.snapshot.instanceId, "--view"], dir, out);

		expect(out.calls).toEqual([ALPHA.viewUrl]);
		expect(out.plain()).not.toContain(ALPHA.controlUrl);
	});

	it("emits a versioned link JSON response with identity, generation and access", async () => {
		const dir = await makeTmpDir();
		await publish(dir, ALPHA);
		const out = collector();
		await runCommand(["link", ALPHA.snapshot.instanceId, "-j"], dir, out);

		expect(out.plain()).toBe(
			JSON.stringify(
				{
					version: COLLAB_REGISTRY_VERSION,
					instanceId: ALPHA.snapshot.instanceId,
					generation: ALPHA.snapshot.generation,
					access: "control",
					url: ALPHA.controlUrl,
				},
				null,
				2,
			),
		);
	});

	it("accepts a unique PID selector", async () => {
		const dir = await makeTmpDir();
		await publish(dir, ALPHA);
		const out = collector();
		await runCommand(["link", String(process.pid)], dir, out);

		expect(out.calls).toEqual([ALPHA.controlUrl]);
	});

	it.each([
		{ code: "not_found", selector: "missing-host", fixtures: [] },
		{ code: "ambiguous", selector: String(process.pid), fixtures: [ALPHA, BRAVO] },
	])("surfaces $code as a nonzero failure with the registry message and no URL or stack", async testCase => {
		const dir = await makeTmpDir();
		for (const fixture of testCase.fixtures) await publish(dir, fixture);
		const error = await resolveCollabHostLink(testCase.selector, "control", { dir }).catch((error: unknown) => error);
		if (!(error instanceof CollabLinkError)) throw new Error("expected a registry selection failure");
		expect(error.code).toBe(testCase.code);
		const errors: string[] = [];
		spyOn(process.stderr, "write").mockImplementation(chunk => {
			errors.push(String(chunk));
			return true;
		});
		const previousExitCode = process.exitCode;
		const out = collector();
		try {
			await runCommand(["link", testCase.selector, "--json"], dir, out);
			expect(process.exitCode).toBe(1);
			expect(errors.join("")).toBe(`error: ${error.message}\n`);
			expect(out.calls).toEqual([]);
			for (const fixture of [ALPHA, BRAVO]) {
				expect(errors.join("")).not.toContain(fixture.controlUrl);
				expect(errors.join("")).not.toContain(fixture.viewUrl);
			}
		} finally {
			process.exitCode = previousExitCode ?? 0;
		}
	});

	const usageRejections: string[][] = [["list", "--view"], ["list", "extra"], ["link"], ["link", "a", "b"]];
	for (const argv of usageRejections) {
		it(`rejects ${JSON.stringify(argv)} through the usage path before invoking the registry`, async () => {
			const unexpected = new Error("registry must not be invoked for invalid usage");
			const listSpy = spyOn(registry, "listCollabHosts").mockRejectedValue(unexpected);
			const linkSpy = spyOn(registry, "resolveCollabHostLink").mockRejectedValue(unexpected);

			await expect(new Collab(argv, CONFIG).run()).rejects.toBeInstanceOf(CliUsageError);
			expect(listSpy).not.toHaveBeenCalled();
			expect(linkSpy).not.toHaveBeenCalled();
		});
	}
});
