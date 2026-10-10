import { describe, expect, it } from "bun:test";
import {
	classifyUpdateTranscript,
	type InstallIdentity,
	parseSessionUpdateArgs,
	restartLoadsUpdate,
	runSessionUpdate,
	type SessionUpdateUi,
	type UpdateSpawnResult,
} from "../src/slash-commands/helpers/self-update";

const sameBinary: InstallIdentity = {
	sourceCheckout: false,
	compiled: true,
	selfPath: "/usr/local/bin/omp",
	installedPath: "/usr/local/bin/omp",
};
const sourceCheckout: InstallIdentity = {
	sourceCheckout: true,
	compiled: false,
	installedPath: "/home/me/.local/bin/omp",
};

const CHECK_OUTPUT = "Current version: 18.8.7\nNew version available: 18.9.0\n";
const INSTALL_OUTPUT =
	"Current version: 18.8.7\nNew version available: 18.9.0\nDownloading omp-linux-x64…\nInstalling update…\n\n✔ Updated to 18.9.0 at /usr/local/bin/omp\nRestart omp to use the new version\n";

/** Fake child: answers `--check` runs and install runs from fixed transcripts. */
function harness(options: {
	identity: InstallIdentity;
	answers: boolean[];
	check?: UpdateSpawnResult;
	install?: UpdateSpawnResult;
}) {
	const calls: string[][] = [];
	const status: string[] = [];
	const prompts: Array<{ title: string; message: string }> = [];
	const restarts: Array<string[] | undefined> = [];
	const answers = [...options.answers];
	const ui: SessionUpdateUi = {
		status: message => status.push(message),
		confirm: async (title, message) => {
			prompts.push({ title, message });
			return answers.shift() ?? false;
		},
		restart: async entry => {
			restarts.push(entry);
		},
	};
	const spawn = async (cmd: string[]): Promise<UpdateSpawnResult> => {
		const flags = cmd.slice(cmd.indexOf("update") + 1);
		calls.push(flags);
		return flags.includes("--check")
			? (options.check ?? { exitCode: 0, output: CHECK_OUTPUT })
			: (options.install ?? { exitCode: 0, output: INSTALL_OUTPUT });
	};
	const run = (flags: string[] = []) => runSessionUpdate({ flags, ui, identity: options.identity, spawn });
	return { run, calls, status, prompts, restarts };
}

describe("parseSessionUpdateArgs", () => {
	it("rejects an unknown option instead of installing", () => {
		expect(parseSessionUpdateArgs("--force --nope")).toEqual({
			error: 'Unknown /update option "--nope". Usage: /update [--check] [--force] [--canary|--stable]',
		});
	});

	it("rejects --plugins: plugin upgrades are not an omp self-update", () => {
		expect("error" in parseSessionUpdateArgs("--plugins")).toBe(true);
	});

	it("rejects both channels", () => {
		expect(parseSessionUpdateArgs("--canary --stable")).toEqual({
			error: "--canary and --stable are mutually exclusive",
		});
	});
});

describe("classifyUpdateTranscript", () => {
	it("treats a non-zero exit as a failure even if stdout looks successful", () => {
		expect(classifyUpdateTranscript(1, "Updated to 19.0.0\nUpdate failed: disk full")).toEqual({
			kind: "failed",
			detail: "Update failed: disk full",
		});
	});

	it("does not treat a managed or Nix refusal as an update", () => {
		expect(
			classifyUpdateTranscript(0, "/usr/bin/omp is installed and kept up to date by Tern; update it from Tern."),
		).toEqual({
			kind: "blocked",
		});
		expect(classifyUpdateTranscript(0, "This installation is managed by Nix and cannot update itself.")).toEqual({
			kind: "blocked",
		});
	});

	it("reads versions for update, reinstall, and channel switch", () => {
		expect(classifyUpdateTranscript(0, CHECK_OUTPUT)).toEqual({
			kind: "available",
			version: "18.9.0",
			current: "18.8.7",
		});
		expect(classifyUpdateTranscript(0, "Current version: 18.8.7\nForcing reinstall of 18.8.7")).toEqual({
			kind: "available",
			version: "18.8.7",
			current: "18.8.7",
		});
		expect(classifyUpdateTranscript(0, "\u001b[32m✔ Updated to 19.1.0-canary.2 at /x\u001b[0m")).toEqual({
			kind: "updated",
			version: "19.1.0-canary.2",
		});
	});
});

describe("restartLoadsUpdate", () => {
	it("is true only when this process is the install that was replaced", () => {
		expect(restartLoadsUpdate(sameBinary)).toBe(true);
		expect(restartLoadsUpdate({ sourceCheckout: false, compiled: false })).toBe(true);
		expect(restartLoadsUpdate(sourceCheckout)).toBe(false);
		expect(
			restartLoadsUpdate({
				sourceCheckout: false,
				compiled: true,
				selfPath: "/opt/omp",
				installedPath: "/usr/local/bin/omp",
			}),
		).toBe(false);
	});
});

describe("runSessionUpdate", () => {
	it("installs nothing when the user answers no to the update prompt", async () => {
		const h = harness({ identity: sameBinary, answers: [false] });
		await h.run();
		expect(h.calls).toEqual([["--check"]]);
		expect(h.prompts).toEqual([{ title: "Update omp?", message: "Update omp 18.8.7 → 18.9.0?" }]);
		expect(h.status).toEqual(["Update skipped."]);
		expect(h.restarts).toEqual([]);
	});

	it("installs on yes, then restarts the same process image on a second yes", async () => {
		const h = harness({ identity: sameBinary, answers: [true, true] });
		await h.run(["--force"]);
		expect(h.calls).toEqual([["--force", "--check"], ["--force"]]);
		expect(h.prompts[1]?.title).toBe("Restart omp?");
		expect(h.restarts).toEqual([undefined]);
		// Neither the updater's own restart advice nor a second "Updated to" line is shown.
		expect(h.status.join("\n")).not.toContain("Restart omp to use the new version");
	});

	it("keeps running the old process when the restart prompt is declined", async () => {
		const h = harness({ identity: sameBinary, answers: [true, false] });
		await h.run();
		expect(h.restarts).toEqual([]);
		expect(h.status.at(-1)).toContain("/restart");
	});

	it("restarts into the installed omp from a source checkout instead of relaunching the checkout", async () => {
		const h = harness({ identity: sourceCheckout, answers: [true, true] });
		await h.run();
		expect(h.prompts[1]?.title).toBe("Restart into the installed omp?");
		expect(h.prompts[1]?.message).toContain("source checkout");
		expect(h.restarts).toEqual([["/home/me/.local/bin/omp"]]);
	});

	it("never installs or prompts for --check", async () => {
		const h = harness({ identity: sameBinary, answers: [] });
		await h.run(["--check"]);
		expect(h.calls).toEqual([["--check"]]);
		expect(h.prompts).toEqual([]);
		expect(h.status[0]).toContain("New version available: 18.9.0");
	});

	it("reports an up-to-date or refused install without prompting", async () => {
		for (const output of [
			"Current version: 18.8.7\n✔ Already up to date",
			"This installation is managed by Nix and cannot update itself.",
		]) {
			const h = harness({ identity: sameBinary, answers: [], check: { exitCode: 0, output } });
			await h.run();
			expect(h.prompts).toEqual([]);
			expect(h.calls).toEqual([["--check"]]);
		}
	});

	it("surfaces a failed install and does not offer a restart", async () => {
		const h = harness({
			identity: sameBinary,
			answers: [true],
			install: { exitCode: 1, output: "Update failed: Error: disk full" },
		});
		await h.run();
		expect(h.status.at(-1)).toBe("Update failed: Update failed: Error: disk full");
		expect(h.prompts).toHaveLength(1);
		expect(h.restarts).toEqual([]);
	});
});
