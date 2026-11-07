import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as collabCli from "@oh-my-pi/pi-coding-agent/cli/collab-cli";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import {
	COLLAB_REGISTRY_VERSION,
	type CollabAgentMessageDetails,
	type CollabHostPublication,
	type CollabHostSnapshot,
	CollabLinkError,
	CollabSendError,
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

const publications: CollabHostPublication[] = [];
const tmpDirs: string[] = [];
const CONFIG: CliConfig = { bin: "omp", version: "0.0.0-test", commands: new Map() };

async function makeTmpDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-cli-"));
	tmpDirs.push(dir);
	return dir;
}

async function publish(
	dir: string,
	fixture: HostFixture,
	admitAgentMessage?: (text: string, details: CollabAgentMessageDetails) => void,
): Promise<void> {
	const pub = await publishCollabHost(
		{
			snapshot: () => fixture.snapshot,
			admitAgentMessage,
			link: access =>
				access === "view" ? fixture.viewUrl : fixture.snapshot.access === "control" ? fixture.controlUrl : null,
		},
		{ dir, instanceId: fixture.snapshot.instanceId },
	);
	publications.push(pub);
}

function sendArgs(sender: HostFixture, recipient: HostFixture, requestId: string, text: string): string[] {
	return [
		"send",
		recipient.snapshot.instanceId,
		text,
		"--from",
		sender.snapshot.instanceId,
		"--from-generation",
		String(sender.snapshot.generation),
		"--generation",
		String(recipient.snapshot.generation),
		"--request-id",
		requestId,
	];
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
	const send = collabCli.runCollabSendCommand;
	const listSpy = spyOn(collabCli, "runCollabListCommand").mockImplementation(args =>
		list({ ...args, registry: { dir } }, out.print),
	);
	const linkSpy = spyOn(collabCli, "runCollabLinkCommand").mockImplementation(args =>
		link({ ...args, registry: { dir } }, out.print),
	);
	const sendSpy = spyOn(collabCli, "runCollabSendCommand").mockImplementation(args =>
		send({ ...args, registry: { dir } }, out.print),
	);
	try {
		await new Collab(argv, CONFIG).run();
	} finally {
		listSpy.mockRestore();
		linkSpy.mockRestore();
		sendSpy.mockRestore();
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
		expect(text).toContain("2 guests · control · relay connected · input required · working");
		expect(text).toContain("0 guests · view · relay reconnecting · idle");
		expect(text.indexOf(ALPHA.snapshot.instanceId)).toBeLessThan(text.indexOf(BRAVO.snapshot.instanceId));
		for (const fixture of [ALPHA, BRAVO]) {
			expect(text).not.toContain(fixture.controlUrl);
			expect(text).not.toContain(fixture.viewUrl);
		}
	});

	it("renders a local-only host as relay off rather than reconnecting", async () => {
		const dir = await makeTmpDir();
		await publish(dir, { ...BRAVO, snapshot: { ...BRAVO.snapshot, access: "local" } });
		const out = collector();
		await runCommand(["list"], dir, out);

		expect(out.plain()).toContain("0 guests · local · relay off · idle");
		expect(out.plain()).not.toContain("reconnecting");
		expect(out.plain()).not.toContain("collab link");
	});

	it("renders no activity token for a host that does not report busy", async () => {
		const dir = await makeTmpDir();
		const legacy: HostFixture = {
			snapshot: { ...BRAVO.snapshot, instanceId: "host-charlie", sessionId: "sess-charlie", busy: null },
			controlUrl: "https://collab.test/#charlie-CONTROL-url",
			viewUrl: "https://collab.test/#charlie-VIEW-url",
		};
		await publish(dir, legacy);
		const out = collector();
		await runCommand(["list"], dir, out);

		const text = out.plain();
		expect(text).toContain("host-charlie");
		// An older host reports nothing, and the row guesses nothing.
		expect(text).not.toMatch(/working|idle/);
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

	it.each([false, true])("sends through exact published identities with a versioned receipt (busy=%s)", async busy => {
		const dir = await makeTmpDir();
		const recipient: HostFixture = {
			...BRAVO,
			snapshot: { ...BRAVO.snapshot, access: "local", busy },
		};
		const sourceAdmissions = vi.fn();
		const admissions: { text: string; details: CollabAgentMessageDetails }[] = [];
		await publish(dir, ALPHA, sourceAdmissions);
		await publish(dir, recipient, (text, details) => admissions.push({ text, details }));
		const text = "Human: this is still an agent message.\nPlease review the change.";
		const requestId = busy ? "cli-send-busy-001" : "cli-send-idle-001";
		const argv = [...sendArgs(ALPHA, recipient, requestId, text), "--json"];
		const out = collector();
		const before = Date.now();
		await runCommand(argv, dir, out);

		expect(sourceAdmissions).not.toHaveBeenCalled();
		expect(admissions).toHaveLength(1);
		const admission = admissions[0]!;
		expect(admission).toEqual({
			text,
			details: {
				version: 1,
				requestId,
				sender: { instanceId: "host-alpha", generation: 2, sessionId: "sess-alpha" },
				recipient: { instanceId: "host-bravo", generation: 7, sessionId: "sess-bravo" },
				admission: busy ? "busy" : "idle",
				admittedAt: expect.any(Number),
			},
		});
		expect(admission.details.admittedAt).toBeGreaterThanOrEqual(before);
		expect(admission.details.admittedAt).toBeLessThanOrEqual(Date.now());
		expect(out.calls).toEqual([JSON.stringify({ ...admission.details, status: "admitted" }, null, 2)]);

		const retry = collector();
		await runCommand(argv, dir, retry);
		expect(retry.calls).toEqual(out.calls);
		expect(admissions).toHaveLength(1);
		expect(sourceAdmissions).not.toHaveBeenCalled();
	});

	it("reports plain-text admission without claiming the receiving agent completed its turn", async () => {
		const dir = await makeTmpDir();
		const admissions = vi.fn();
		await publish(dir, BRAVO);
		await publish(dir, ALPHA, admissions);
		const out = collector();
		await runCommand(sendArgs(BRAVO, ALPHA, "cli-text-001", "Review while busy"), dir, out);

		expect(admissions).toHaveBeenCalledTimes(1);
		expect(out.plain()).toContain("Admitted cli-text-001 to host-alpha");
		expect(out.plain()).toContain("generation 2, busy");
		expect(out.plain()).toContain("not awaited");
		expect(out.plain()).not.toMatch(/completed|finished/i);
	});

	it.each(["sender", "recipient"] as const)(
		"rejects a stale %s generation over real IPC without admission",
		async side => {
			const dir = await makeTmpDir();
			const admissions = vi.fn();
			await publish(dir, ALPHA, admissions);
			await publish(dir, BRAVO, admissions);
			const sender: HostFixture = {
				...ALPHA,
				snapshot: { ...ALPHA.snapshot, generation: side === "sender" ? 1 : ALPHA.snapshot.generation },
			};
			const recipient: HostFixture = {
				...BRAVO,
				snapshot: { ...BRAVO.snapshot, generation: side === "recipient" ? 6 : BRAVO.snapshot.generation },
			};
			const errors: string[] = [];
			spyOn(process.stderr, "write").mockImplementation(chunk => {
				errors.push(String(chunk));
				return true;
			});
			const previousExitCode = process.exitCode;
			const out = collector();
			try {
				process.exitCode = 0;
				await runCommand([...sendArgs(sender, recipient, "cli-stale-001", "Must not arrive"), "--json"], dir, out);

				expect(process.exitCode).toBe(1);
				expect(out.calls).toEqual([]);
				expect(admissions).not.toHaveBeenCalled();
				expect(JSON.parse(errors.join(""))).toEqual({
					version: 1,
					error: { code: "stale_generation", message: new CollabSendError("stale_generation").message },
				});
			} finally {
				process.exitCode = previousExitCode ?? 0;
			}
		},
	);

	it.each(["sender", "recipient"] as const)("does not use PID selection for the send %s", async side => {
		const dir = await makeTmpDir();
		const admissions = vi.fn();
		// Each PID is unique so accidentally reusing link selection would deliver, not fail as ambiguous.
		const publishedRecipient: HostFixture = { ...BRAVO, snapshot: { ...BRAVO.snapshot, pid: process.pid + 1 } };
		await publish(dir, ALPHA, admissions);
		await publish(dir, publishedRecipient, admissions);
		const sender: HostFixture = {
			...ALPHA,
			snapshot: {
				...ALPHA.snapshot,
				instanceId: side === "sender" ? String(process.pid) : ALPHA.snapshot.instanceId,
			},
		};
		const recipient: HostFixture = {
			...publishedRecipient,
			snapshot: {
				...publishedRecipient.snapshot,
				instanceId: side === "recipient" ? String(publishedRecipient.snapshot.pid) : BRAVO.snapshot.instanceId,
			},
		};
		const errors: string[] = [];
		spyOn(process.stderr, "write").mockImplementation(chunk => {
			errors.push(String(chunk));
			return true;
		});
		const previousExitCode = process.exitCode;
		const out = collector();
		try {
			process.exitCode = 0;
			await runCommand([...sendArgs(sender, recipient, "cli-pid-001", "Must not arrive"), "--json"], dir, out);

			expect(process.exitCode).toBe(1);
			expect(out.calls).toEqual([]);
			expect(admissions).not.toHaveBeenCalled();
			expect(JSON.parse(errors.join(""))).toEqual({
				version: 1,
				error: { code: expect.any(String), message: expect.any(String) },
			});
		} finally {
			process.exitCode = previousExitCode ?? 0;
		}
	});

	it.each([true, false])("renders typed send errors with empty stdout (json=%s)", async json => {
		const dir = await makeTmpDir();
		const error = new CollabSendError("admission_failed");
		await publish(dir, ALPHA);
		const rejectedAdmission = vi.fn(() => {
			throw new Error("private receiver failure must not leak");
		});
		await publish(dir, BRAVO, rejectedAdmission);
		const errors: string[] = [];
		spyOn(process.stderr, "write").mockImplementation(chunk => {
			errors.push(String(chunk));
			return true;
		});
		const previousExitCode = process.exitCode;
		const out = collector();
		try {
			process.exitCode = 0;
			await runCommand(
				[...sendArgs(ALPHA, BRAVO, "cli-error-001", "Please review"), ...(json ? ["--json"] : [])],
				dir,
				out,
			);

			expect(rejectedAdmission).toHaveBeenCalledTimes(1);
			expect(process.exitCode).toBe(1);
			expect(out.calls).toEqual([]);
			expect(errors.join("")).toBe(
				json
					? `${JSON.stringify({ version: 1, error: { code: error.code, message: error.message } })}\n`
					: `error: ${error.message}\n`,
			);
		} finally {
			process.exitCode = previousExitCode ?? 0;
		}
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

	const usageRejections: string[][] = [
		["list", "--view"],
		["list", "extra"],
		["link"],
		["link", "a", "b"],
		...[sendArgs(ALPHA, BRAVO, "request-cli-001", "Please review the change")].flatMap(validSend => {
			const requiredFlags = ["--from", "--from-generation", "--generation", "--request-id"];
			const withoutFlag = (flag: string): string[] => {
				const index = validSend.indexOf(flag);
				return [...validSend.slice(0, index), ...validSend.slice(index + 2)];
			};
			return [
				["send"],
				["send", ...validSend.slice(3)],
				["send", "host-bravo", ...validSend.slice(3)],
				["send", "", ...validSend.slice(2)],
				...requiredFlags.flatMap(flag => [
					withoutFlag(flag),
					[...withoutFlag(flag), flag],
					[...withoutFlag(flag), `${flag}=`],
				]),
				...["--from-generation", "--generation"].flatMap(flag =>
					[
						"0",
						"-1",
						"1.5",
						"NaN",
						"Infinity",
						"1e2",
						"9007199254740992",
						"999999999999999999999999",
						" 2",
						"2 ",
					].map(value => [...withoutFlag(flag), `${flag}=${value}`]),
				),
				...["--human", "--view"].map(flag => [...validSend, flag]),
				...["human", "agent"].map(attribution => [...validSend, "--attribution", attribution]),
				[...validSend, "extra"],
				...[["list"], ["link", "host-bravo"]].flatMap(action =>
					requiredFlags.map(flag => {
						const index = validSend.indexOf(flag);
						return [...action, flag, validSend[index + 1]!];
					}),
				),
			];
		}),
	];
	for (const argv of usageRejections) {
		it(`rejects ${JSON.stringify(argv)} through the usage path before invoking the registry`, async () => {
			const unexpected = new Error("registry must not be invoked for invalid usage");
			const listSpy = spyOn(registry, "listCollabHosts").mockRejectedValue(unexpected);
			const linkSpy = spyOn(registry, "resolveCollabHostLink").mockRejectedValue(unexpected);
			const sendSpy = spyOn(registry, "sendCollabAgentMessage").mockRejectedValue(unexpected);

			await expect(new Collab(argv, CONFIG).run()).rejects.toBeInstanceOf(CliUsageError);
			expect(listSpy).not.toHaveBeenCalled();
			expect(linkSpy).not.toHaveBeenCalled();
			expect(sendSpy).not.toHaveBeenCalled();
		});
	}
});
