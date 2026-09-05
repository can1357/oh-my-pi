import { describe, expect, it } from "bun:test";
import { Args, type CliConfig, Command, Flags } from "../src/cli";

/** A flag whose mode is optional: bare means the safe default. */
class PruneLikeCommand extends Command {
	static description = "prune things";
	static flags = {
		mode: Flags.string({
			description: "archive or delete",
			options: ["archive", "delete"],
			optionalValue: "archive",
		}),
		other: Flags.boolean({ description: "unrelated" }),
	};
	parsed: { mode?: string; other?: boolean } = {};
	async run(): Promise<void> {
		const { flags } = await this.parse(PruneLikeCommand);
		this.parsed = { mode: flags.mode, other: flags.other };
	}
}

/** Same flag alongside positionals, which must not be swallowed as its value. */
class PositionalCommand extends Command {
	static description = "prune with targets";
	static args = { targets: Args.string({ description: "paths", multiple: true }) };
	static flags = {
		mode: Flags.string({
			description: "archive or delete",
			options: ["archive", "delete"],
			optionalValue: "archive",
		}),
	};
	parsed: { mode?: string; targets?: string[] } = {};
	async run(): Promise<void> {
		const { flags, args } = await this.parse(PositionalCommand);
		this.parsed = { mode: flags.mode, targets: args.targets as string[] | undefined };
	}
}

async function runWith<T extends Command & { parsed: unknown }>(
	Ctor: new (argv: string[], config: CliConfig) => T,
	argv: string[],
): Promise<T> {
	const command = new Ctor(argv, { bin: "omp", version: "test", commands: new Map() });
	await command.run();
	return command;
}

describe("Flags.string({ optionalValue })", () => {
	it("leaves the flag undefined when it is absent, so a pass gated on it stays off", async () => {
		const command = await runWith(PruneLikeCommand, []);
		expect(command.parsed.mode).toBeUndefined();
	});

	it("assumes the stated default when the flag is passed bare", async () => {
		const command = await runWith(PruneLikeCommand, ["--mode"]);
		expect(command.parsed.mode).toBe("archive");
	});

	it("takes an explicit value in both spellings", async () => {
		expect((await runWith(PruneLikeCommand, ["--mode", "delete"])).parsed.mode).toBe("delete");
		expect((await runWith(PruneLikeCommand, ["--mode=delete"])).parsed.mode).toBe("delete");
	});

	it("still rejects a value outside the declared options", async () => {
		await expect(runWith(PruneLikeCommand, ["--mode=wipe"])).rejects.toThrow(/one of: archive, delete/);
	});

	it("does not consume a following flag as its value", async () => {
		const command = await runWith(PruneLikeCommand, ["--mode", "--other"]);
		expect(command.parsed.mode).toBe("archive");
		expect(command.parsed.other).toBe(true);
	});

	it("does not consume a following positional as its value", async () => {
		const command = await runWith(PositionalCommand, ["--mode", "some/path"]);
		expect(command.parsed.mode).toBe("archive");
		expect(command.parsed.targets).toEqual(["some/path"]);
	});
});
