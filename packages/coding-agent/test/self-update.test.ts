import { describe, expect, it } from "bun:test";
import {
	classifyUpdateTranscript,
	type InstallIdentity,
	parseSessionUpdateArgs,
	runSessionUpdate,
	type SessionUpdateUi,
	type UpdateSpawnResult,
} from "../src/slash-commands/helpers/self-update";

const installed: InstallIdentity = { sourceCheckout: false, pathEntry: "/home/me/.local/share/mise/shims/omp" };
const sourceCheckout: InstallIdentity = { sourceCheckout: true, pathEntry: "/home/me/.local/bin/omp" };

const CHECK_OUTPUT = "Current version: 18.8.7\nNew version available: 18.9.0\n";
const INSTALL_OUTPUT =
	"Current version: 18.8.7\nNew version available: 18.9.0\nDownloading omp-linux-x64…\nInstalling update…\n\n✔ Updated to 18.9.0 at /usr/local/bin/omp\nRestart omp to use the new version\n";

/** Fake child: answers `--check` runs and install runs from fixed transcripts. */
function harness(options: {
	identity: InstallIdentity;
	answers: boolean[];
	check?: UpdateSpawnResult;
	install?: UpdateSpawnResult;
	busyAfterInstall?: boolean;
}) {
	const calls: string[][] = [];
	const status: string[] = [];
	const prompts: Array<{ title: string; message: string }> = [];
	const restarts: string[][] = [];
	const answers = [...options.answers];
	let installRan = false;
	const ui: SessionUpdateUi = {
		status: message => status.push(message),
		confirm: async (title, message) => {
			prompts.push({ title, message });
			return answers.shift() ?? false;
		},
		busy: () => installRan && options.busyAfterInstall === true,
		restart: async entry => {
			restarts.push(entry);
		},
	};
	const spawn = async (cmd: string[]): Promise<UpdateSpawnResult> => {
		const flags = cmd.slice(cmd.indexOf("update") + 1);
		calls.push(flags);
		if (flags.includes("--check")) return options.check ?? { exitCode: 0, output: CHECK_OUTPUT };
		installRan = true;
		return options.install ?? { exitCode: 0, output: INSTALL_OUTPUT };
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
	it("reports the updater's failure reason once, without its own prefix", () => {
		expect(classifyUpdateTranscript("install", 1, "Updated to 19.0.0\nUpdate failed: Error: disk full")).toEqual({
			kind: "failed",
			detail: "Error: disk full",
		});
	});

	it("does not treat a managed or Nix refusal as an install", () => {
		expect(
			classifyUpdateTranscript(
				"check",
				0,
				"/usr/bin/omp is installed and kept up to date by Tern; update it from Tern.",
			),
		).toEqual({ kind: "blocked" });
		expect(
			classifyUpdateTranscript("install", 0, "This installation is managed by Nix and cannot update itself."),
		).toEqual({
			kind: "blocked",
		});
	});

	it("reads versions for update, reinstall, and channel switch on a check run", () => {
		expect(classifyUpdateTranscript("check", 0, CHECK_OUTPUT)).toEqual({
			kind: "available",
			version: "18.9.0",
			current: "18.8.7",
		});
		expect(classifyUpdateTranscript("check", 0, "Current version: 18.8.7\nForcing reinstall of 18.8.7")).toEqual({
			kind: "available",
			version: "18.8.7",
			current: "18.8.7",
		});
	});

	it("treats a clean install as installed even if the success line is reworded", () => {
		expect(
			classifyUpdateTranscript("install", 0, "New version available: 18.9.0\nAll done: omp 18.9.0 is live"),
		).toEqual({
			kind: "installed",
		});
		expect(
			classifyUpdateTranscript("install", 0, "Warning: omp at /x still reports 18.8.7 (expected 18.9.0)"),
		).toEqual({
			kind: "unverified",
		});
	});

	it("strips non-SGR escapes and tabs from installer output", async () => {
		const h = harness({
			identity: installed,
			answers: [true, false],
			install: { exitCode: 0, output: "==> Upgrading\x1b[K\x1b]0;brew\x07\tomp\n✔ Updated to 18.9.0\n" },
		});
		await h.run();
		const shown = h.status.join("\n");
		expect(shown).not.toContain("\x1b");
		expect(shown).not.toContain("\t");
		expect(shown).toContain("Upgrading");
	});
});

describe("runSessionUpdate", () => {
	it("installs nothing when the user answers no to the update prompt", async () => {
		const h = harness({ identity: installed, answers: [false] });
		await h.run();
		expect(h.calls).toEqual([["--check"]]);
		expect(h.prompts).toEqual([{ title: "Update omp?", message: "Update omp 18.8.7 → 18.9.0?" }]);
		expect(h.status).toEqual(["Update skipped."]);
		expect(h.restarts).toEqual([]);
	});

	it("restarts through the unresolved PATH entry so argv[0] shims like mise still launch omp", async () => {
		const h = harness({ identity: installed, answers: [true, true] });
		await h.run(["--force"]);
		expect(h.calls).toEqual([["--force", "--check"], ["--force"]]);
		expect(h.prompts[1]?.title).toBe("Restart omp?");
		expect(h.restarts).toEqual([["/home/me/.local/share/mise/shims/omp"]]);
		expect(h.status.join("\n")).not.toContain("Restart omp to use the new version");
	});

	it("keeps running the old process when the restart prompt is declined", async () => {
		const h = harness({ identity: installed, answers: [true, false] });
		await h.run();
		expect(h.restarts).toEqual([]);
		expect(h.status.at(-1)).toContain("/restart");
	});

	it("does not restart over a turn that started while the install ran", async () => {
		const h = harness({ identity: installed, answers: [true, true], busyAfterInstall: true });
		await h.run();
		expect(h.prompts).toHaveLength(1);
		expect(h.restarts).toEqual([]);
		expect(h.status.at(-1)).toContain("/restart");
	});

	it("offers to restart into the installed omp from a source checkout", async () => {
		const h = harness({ identity: sourceCheckout, answers: [true, true] });
		await h.run();
		expect(h.prompts[1]?.title).toBe("Restart into the installed omp?");
		expect(h.prompts[1]?.message).toContain("source checkout");
		expect(h.restarts).toEqual([["/home/me/.local/bin/omp"]]);
	});

	it("never installs or prompts for --check", async () => {
		const h = harness({ identity: installed, answers: [] });
		await h.run(["--check"]);
		expect(h.calls).toEqual([["--check"]]);
		expect(h.prompts).toEqual([]);
		expect(h.status[0]).toContain("New version available: 18.9.0");
	});

	it("does not prompt when the check reports up to date or a managed install", async () => {
		for (const output of [
			"Current version: 18.8.7\n✔ Already up to date",
			"/usr/bin/omp is installed and kept up to date by Tern; update it from Tern.",
		]) {
			const h = harness({ identity: installed, answers: [], check: { exitCode: 0, output } });
			await h.run();
			expect(h.prompts).toEqual([]);
			expect(h.calls).toEqual([["--check"]]);
		}
	});

	it("reports a Nix refusal from the install run and does not offer a restart", async () => {
		const h = harness({
			identity: installed,
			answers: [true],
			install: { exitCode: 0, output: "This installation is managed by Nix and cannot update itself." },
		});
		await h.run();
		expect(h.prompts).toHaveLength(1);
		expect(h.restarts).toEqual([]);
		expect(h.status.at(-1)).toContain("cannot update itself");
	});

	it("surfaces a failed install once and does not offer a restart", async () => {
		const h = harness({
			identity: installed,
			answers: [true],
			install: { exitCode: 1, output: "Update failed: Error: disk full" },
		});
		await h.run();
		expect(h.status.at(-1)).toBe("Update failed: Error: disk full");
		expect(h.prompts).toHaveLength(1);
		expect(h.restarts).toEqual([]);
	});
});
