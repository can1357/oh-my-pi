import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { resolveCompressTargets, runCompressCommand } from "@oh-my-pi/pi-coding-agent/compress/index";
import { CompressProtocol } from "@oh-my-pi/pi-coding-agent/compress/protocol";

const SOURCE = "The timeout parameter defaults to thirty seconds when no value is supplied by the caller.";
const PACKAGE_ROOT = path.join(import.meta.dir, "..");

describe("compress protocol", () => {
	test("approve before any draft is rejected", () => {
		const protocol = new CompressProtocol(SOURCE);
		expect(() => protocol.accept("looks fine")).toThrow(/Call rewrite before approve/);
		expect(protocol.approved).toBe(false);
	});

	test("approve is gated on the review turn for the newest draft", () => {
		const protocol = new CompressProtocol(SOURCE);
		protocol.submit("Default 30s.", []);

		expect(() => protocol.accept("premature")).toThrow(/has not been reviewed/);
		expect(protocol.approved).toBe(false);

		protocol.markReviewed(1);
		expect(protocol.accept("reviewed and correct").round).toBe(1);
		expect(protocol.approved).toBe(true);
		expect(protocol.verdict).toBe("reviewed and correct");
	});

	test("a new draft supersedes an approval and needs its own review", () => {
		const protocol = new CompressProtocol(SOURCE);
		protocol.submit("Default 30s.", []);
		protocol.markReviewed(1);
		protocol.accept("accepted");

		protocol.submit("timeout: default 30s.", []);
		expect(protocol.approved).toBe(false);
		expect(protocol.verdict).toBeUndefined();
		expect(protocol.rounds).toBe(2);
		expect(protocol.latest?.round).toBe(2);
		expect(() => protocol.accept("again")).toThrow(/has not been reviewed/);
	});

	test("declared losses are copied onto the draft", () => {
		const protocol = new CompressProtocol(SOURCE);
		const losses = [{ content: "when no value is supplied by the caller", reason: "implied by default" }];
		const draft = protocol.submit("Default 30s.", losses);
		losses[0] = { content: "mutated", reason: "mutated" };
		expect(draft.losses).toEqual([
			{ content: "when no value is supplied by the caller", reason: "implied by default" },
		]);
	});

	test("metrics measure the draft against the source and report growth as a negative ratio", () => {
		const protocol = new CompressProtocol(SOURCE);
		const shrunk = protocol.metrics({ round: 1, text: "Default 30s.", losses: [] });
		expect(shrunk.sourceWords).toBe(15);
		expect(shrunk.draftWords).toBe(2);
		expect(shrunk.draftTokens).toBeLessThan(shrunk.sourceTokens);
		expect(shrunk.ratio).toBeGreaterThan(0);

		const grown = protocol.metrics({ round: 1, text: `${SOURCE} ${SOURCE}`, losses: [] });
		expect(grown.ratio).toBeLessThan(0);
	});

	test("an empty source yields zero sizes instead of dividing by zero", () => {
		const protocol = new CompressProtocol("");
		expect(protocol.sourceWords).toBe(0);
		expect(protocol.sourceTokens).toBe(0);
		expect(protocol.metrics({ round: 1, text: "anything", losses: [] }).ratio).toBe(0);
	});
});

describe("compress targets", () => {
	test("expands globs, dedupes overlapping patterns, and sorts", async () => {
		const targets = await resolveCompressTargets(["src/compress/*.ts", "src/compress/types.ts"], PACKAGE_ROOT);
		expect(targets).toEqual([...targets].sort());
		expect(targets.filter(target => target.endsWith("types.ts"))).toHaveLength(1);
		expect(targets.some(target => target.endsWith("protocol.ts"))).toBe(true);
	});

	test("a pattern matching nothing fails loudly", async () => {
		await expect(resolveCompressTargets(["src/compress/*.nope"], PACKAGE_ROOT)).rejects.toThrow(/No files matched/);
	});

	test("a missing literal path fails instead of being skipped", async () => {
		await expect(resolveCompressTargets(["definitely-not-here.md"], PACKAGE_ROOT)).rejects.toThrow(/Not a file/);
	});
});

describe("compress command", () => {
	test("rejects a non-positive round budget before opening a session", async () => {
		await expect(runCompressCommand({ files: ["missing.md"], maxRounds: 0 })).rejects.toThrow(
			/--rounds must be a positive integer/,
		);
	});

	test("rejects a non-positive concurrency", async () => {
		await expect(runCompressCommand({ files: ["missing.md"], concurrency: 0 })).rejects.toThrow(
			/--agents must be a positive integer/,
		);
	});

	test("rejects writing to two destinations at once", async () => {
		await expect(runCompressCommand({ files: ["missing.md"], inPlace: true, output: "out.md" })).rejects.toThrow(
			/mutually exclusive/,
		);
	});

	test("routes compress as a top-level command", () => {
		expect(resolveCliArgv(["compress", "notes.md", "-r", "2"])).toEqual({
			argv: ["compress", "notes.md", "-r", "2"],
		});
	});
});
