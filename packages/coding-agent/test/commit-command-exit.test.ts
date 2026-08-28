import { afterEach, describe, expect, it, vi } from "bun:test";
import CommitCommand from "@oh-my-pi/pi-coding-agent/commands/commit";
import * as commitModule from "@oh-my-pi/pi-coding-agent/commit";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { postmortem } from "@oh-my-pi/pi-utils";

describe("omp commit command lifecycle (issue #1041)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forces process exit after the commit pipeline resolves", async () => {
		const initThemeSpy = vi.spyOn(themeModule, "initTheme").mockResolvedValue(undefined);
		const runCommitSpy = vi.spyOn(commitModule, "runCommitCommand").mockResolvedValue({ usedFallback: false });
		// Stub postmortem.quit so it records the exit code without actually
		// terminating the test runner. Resolves immediately — the production
		// implementation never returns, but the contract under test is that
		// the call happens at all.
		const quitSpy = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);

		const command = new CommitCommand([], {
			bin: "omp",
			version: "0.0.0-test",
			commands: new Map(),
		});

		await command.run();

		expect(initThemeSpy).toHaveBeenCalledTimes(1);
		expect(runCommitSpy).toHaveBeenCalledTimes(1);
		// Quit must come after the pipeline so we cannot regress the order.
		expect(runCommitSpy.mock.invocationCallOrder[0]).toBeLessThan(quitSpy.mock.invocationCallOrder[0]);
		expect(quitSpy).toHaveBeenCalledWith(0);
	});

	it("exits non-zero when the commit pipeline used the mechanical fallback", async () => {
		const initThemeSpy = vi.spyOn(themeModule, "initTheme").mockResolvedValue(undefined);
		const runCommitSpy = vi.spyOn(commitModule, "runCommitCommand").mockResolvedValue({ usedFallback: true });
		const quitSpy = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);

		const command = new CommitCommand([], {
			bin: "omp",
			version: "0.0.0-test",
			commands: new Map(),
		});

		await command.run();

		expect(initThemeSpy).toHaveBeenCalledTimes(1);
		expect(runCommitSpy).toHaveBeenCalledTimes(1);
		expect(quitSpy).toHaveBeenCalledWith(1);
	});

	it("does not convert commit pipeline failures into exit 0", async () => {
		const initThemeSpy = vi.spyOn(themeModule, "initTheme").mockResolvedValue(undefined);
		const runCommitSpy = vi
			.spyOn(commitModule, "runCommitCommand")
			.mockRejectedValue(new Error("commit was not created"));
		const quitSpy = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);

		const command = new CommitCommand([], {
			bin: "omp",
			version: "0.0.0-test",
			commands: new Map(),
		});

		await expect(command.run()).rejects.toThrow("commit was not created");

		expect(initThemeSpy).toHaveBeenCalledTimes(1);
		expect(runCommitSpy).toHaveBeenCalledTimes(1);
		expect(quitSpy).not.toHaveBeenCalled();
	});

	it("maps CommitAbortedError to exit code 1 without rethrowing (issue #7834)", async () => {
		vi.spyOn(themeModule, "initTheme").mockResolvedValue(undefined);
		vi.spyOn(commitModule, "runCommitCommand").mockRejectedValue(new commitModule.CommitAbortedError());
		const quitSpy = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);

		const command = new CommitCommand([], {
			bin: "omp",
			version: "0.0.0-test",
			commands: new Map(),
		});

		// A hook refusal is already reported with a readable message; the command
		// must exit non-zero rather than let the runtime dump the error.
		await command.run();

		expect(quitSpy).toHaveBeenCalledWith(1);
	});
});
