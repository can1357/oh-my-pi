import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
		busy: true,
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
		busy: false,
		access: "view",
	},
	controlUrl: "https://collab.test/#bravo-CONTROL-url",
	viewUrl: "https://collab.test/#bravo-VIEW-url",
};

const CONFIG: CliConfig = { bin: "omp", version: "0.0.0-test", commands: new Map() };

interface CollabFixture {
	dir: string;
	publish(fixture: HostFixture): Promise<void>;
	close(): Promise<void>;
}

async function createFixture(): Promise<CollabFixture> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-cli-"));
	const publications: CollabHostPublication[] = [];
	return {
		dir,
		async publish(fixture: HostFixture): Promise<void> {
			const publication = await publishCollabHost(
				{
					snapshot: () => fixture.snapshot,
					link: access =>
						access === "view"
							? fixture.viewUrl
							: fixture.snapshot.access === "control"
								? fixture.controlUrl
								: null,
				},
				{ dir, instanceId: fixture.snapshot.instanceId },
			);
			publications.push(publication);
		},
		async close(): Promise<void> {
			try {
				await Promise.all(publications.map(publication => publication.close()));
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	};
}

async function withFixture<T>(callback: (fixture: CollabFixture) => Promise<T>): Promise<T> {
	const fixture = await createFixture();
	try {
		const result = await callback(fixture);
		return result;
	} finally {
		await fixture.close();
	}
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

/** Exercise the real parser and handlers while keeping registry and output isolated. */
async function runCommand(argv: string[], dir: string, out: Collector): Promise<void> {
	await new Collab(argv, CONFIG, { registry: { dir }, print: out.print }).run();
}

describe("Collab CLI", () => {
	it("reports no active hosts against an empty registry", async () => {
		await withFixture(async fixture => {
			const out = collector();
			await runCommand(["list"], fixture.dir, out);

			expect(out.plain()).toBe("No active Collab hosts.");
		});
	});

	it("lists host identities, sessions, generations and attention state without either capability", async () => {
		await withFixture(async fixture => {
			await fixture.publish(BRAVO);
			await fixture.publish(ALPHA);
			const out = collector();
			await runCommand(["list"], fixture.dir, out);

			const text = out.plain();
			expect(text).toContain("2 active Collab hosts");
			expect(text).toContain("host-alpha  Alpha Session (sess-alpha)  /tmp/work/alpha");
			expect(text).toContain("host-bravo  sess-bravo  /tmp/work/bravo");
			expect(text).toContain(`pid ${process.pid}`);
			expect(text).toContain("gen 2 · test/alpha-model");
			expect(text).toContain("gen 7 · no model");
			expect(text).toContain("2 guests · control · relay connected · input required · working");
			expect(text).toContain("0 guests · view · relay reconnecting · idle");
			expect(text.indexOf(ALPHA.snapshot.instanceId)).toBeLessThan(text.indexOf(BRAVO.snapshot.instanceId));
			for (const host of [ALPHA, BRAVO]) {
				expect(text).not.toContain(host.controlUrl);
				expect(text).not.toContain(host.viewUrl);
			}
		});
	});

	it("keeps concurrent commands bound to their own registry and collector", async () => {
		await withFixture(async alphaFixture => {
			await withFixture(async bravoFixture => {
				await Promise.all([alphaFixture.publish(ALPHA), bravoFixture.publish(BRAVO)]);
				const alphaOut = collector();
				const bravoOut = collector();

				await Promise.all([
					runCommand(["list"], alphaFixture.dir, alphaOut),
					runCommand(["list"], bravoFixture.dir, bravoOut),
				]);

				expect(alphaOut.plain()).toContain(ALPHA.snapshot.instanceId);
				expect(alphaOut.plain()).not.toContain(BRAVO.snapshot.instanceId);
				expect(bravoOut.plain()).toContain(BRAVO.snapshot.instanceId);
				expect(bravoOut.plain()).not.toContain(ALPHA.snapshot.instanceId);
			});
		});
	});

	it("renders no activity token for a host that does not report busy", async () => {
		await withFixture(async fixture => {
			const legacy: HostFixture = {
				snapshot: { ...BRAVO.snapshot, instanceId: "host-charlie", sessionId: "sess-charlie", busy: null },
				controlUrl: "https://collab.test/#charlie-CONTROL-url",
				viewUrl: "https://collab.test/#charlie-VIEW-url",
			};
			await fixture.publish(legacy);
			const out = collector();
			await runCommand(["list"], fixture.dir, out);

			const text = out.plain();
			expect(text).toContain("host-charlie");
			// An older host reports nothing, and the row guesses nothing.
			expect(text).not.toMatch(/working|idle/);
		});
	});

	it("emits repeatable, two-space metadata-only JSON for list and the default action with -j", async () => {
		await withFixture(async fixture => {
			await fixture.publish(BRAVO);
			await fixture.publish(ALPHA);
			const out = collector();
			await runCommand(["list", "--json"], fixture.dir, out);

			const expected = { version: COLLAB_REGISTRY_VERSION, hosts: [ALPHA.snapshot, BRAVO.snapshot] };
			expect(out.plain()).toBe(JSON.stringify(expected, null, 2));
			for (const host of [ALPHA, BRAVO]) {
				expect(out.plain()).not.toContain(host.controlUrl);
				expect(out.plain()).not.toContain(host.viewUrl);
			}
			const again = collector();
			await runCommand(["-j"], fixture.dir, again);
			expect(again.plain()).toBe(out.plain());
		});
	});

	it("prints only the control URL when linking by instance ID", async () => {
		await withFixture(async fixture => {
			await fixture.publish(ALPHA);
			const out = collector();
			await runCommand(["link", ALPHA.snapshot.instanceId], fixture.dir, out);

			expect(out.calls).toEqual([ALPHA.controlUrl]);
		});
	});

	it("prints only the view URL when --view is requested", async () => {
		await withFixture(async fixture => {
			await fixture.publish(ALPHA);
			const out = collector();
			await runCommand(["link", ALPHA.snapshot.instanceId, "--view"], fixture.dir, out);

			expect(out.calls).toEqual([ALPHA.viewUrl]);
			expect(out.plain()).not.toContain(ALPHA.controlUrl);
		});
	});

	it("emits a versioned link JSON response with identity, generation and access", async () => {
		await withFixture(async fixture => {
			await fixture.publish(ALPHA);
			const out = collector();
			await runCommand(["link", ALPHA.snapshot.instanceId, "-j"], fixture.dir, out);

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
	});

	it("accepts a unique PID selector", async () => {
		await withFixture(async fixture => {
			await fixture.publish(ALPHA);
			const out = collector();
			await runCommand(["link", String(process.pid)], fixture.dir, out);

			expect(out.calls).toEqual([ALPHA.controlUrl]);
		});
	});

	it.each([
		{ code: "not_found", selector: "missing-host", fixtures: [] },
		{ code: "ambiguous", selector: String(process.pid), fixtures: [ALPHA, BRAVO] },
	])("surfaces $code as a nonzero failure with the registry message and no URL or stack", async testCase => {
		await withFixture(async fixture => {
			for (const host of testCase.fixtures) await fixture.publish(host);
			const error = await resolveCollabHostLink(testCase.selector, "control", { dir: fixture.dir }).catch(
				(error: unknown) => error,
			);
			if (!(error instanceof CollabLinkError)) throw new Error("expected a registry selection failure");
			expect(error.code).toBe(testCase.code);
			const errors: string[] = [];
			const stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
				errors.push(String(chunk));
				return true;
			});
			const previousExitCode = process.exitCode;
			const out = collector();
			try {
				await runCommand(["link", testCase.selector, "--json"], fixture.dir, out);
				expect(process.exitCode).toBe(1);
				expect(errors.join("")).toBe(`error: ${error.message}\n`);
				expect(out.calls).toEqual([]);
				for (const host of [ALPHA, BRAVO]) {
					expect(errors.join("")).not.toContain(host.controlUrl);
					expect(errors.join("")).not.toContain(host.viewUrl);
				}
			} finally {
				stderrSpy.mockRestore();
				process.exitCode = previousExitCode ?? 0;
			}
		});
	});

	const usageRejections: string[][] = [["list", "--view"], ["list", "extra"], ["link"], ["link", "a", "b"]];
	for (const argv of usageRejections) {
		it(`rejects ${JSON.stringify(argv)} through the usage path before invoking the registry`, async () => {
			const unexpected = new Error("registry must not be invoked for invalid usage");
			const listSpy = spyOn(registry, "listCollabHosts").mockRejectedValue(unexpected);
			const linkSpy = spyOn(registry, "resolveCollabHostLink").mockRejectedValue(unexpected);
			try {
				await expect(new Collab(argv, CONFIG).run()).rejects.toBeInstanceOf(CliUsageError);
				expect(listSpy).not.toHaveBeenCalled();
				expect(linkSpy).not.toHaveBeenCalled();
			} finally {
				listSpy.mockRestore();
				linkSpy.mockRestore();
			}
		});
	}
});
