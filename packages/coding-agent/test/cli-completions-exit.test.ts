import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";
import Completions from "../src/commands/completions";

describe("Completions command exit contract", () => {
	afterEach(() => {
		spyOn(postmortem, "quit").mockRestore();
		spyOn(Bun, "write").mockRestore();
	});

	it("calls postmortem.quit(0) after writing completion script", async () => {
		const quitSpy = spyOn(postmortem, "quit").mockResolvedValue(undefined);
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const config = { bin: "omp", version: "0.0.0", commands: new Map() };
		const cmd = new Completions(["zsh"], config);
		await cmd.run();

		expect(writeSpy).toHaveBeenCalled();
		expect(quitSpy).toHaveBeenCalledWith(0);
	});
});
