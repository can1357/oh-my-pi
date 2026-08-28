/**
 * Context packet composition — tier assignment, budgets, provenance, render.
 */

import { describe, expect, it } from "bun:test";
import {
	assignRecordTier,
	composeContextPacket,
	estimateRecordTokens,
	formatContextForModel,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/context-composer";
import type { CreateMemoryRecordInput, MemoryRecord } from "@oh-my-pi/pi-coding-agent/memory-fabric/types";
import { createMemoryRecord } from "@oh-my-pi/pi-coding-agent/memory-fabric/types";

function record(overrides?: Partial<CreateMemoryRecordInput>): MemoryRecord {
	return createMemoryRecord({
		type: "fact",
		projectId: "proj-1",
		content: "tests run with bun",
		sourceRefs: [{ type: "user-message", id: "msg-1" }],
		...overrides,
	});
}

describe("assignRecordTier", () => {
	it("routes by type and verification", () => {
		expect(assignRecordTier(record({ type: "working-state" }))).toBe("L1");
		expect(assignRecordTier(record({ type: "evidence" }))).toBe("L3");
		expect(assignRecordTier(record({ type: "episode" }))).toBe("L4");
		expect(assignRecordTier(record({ type: "fact" }))).toBe("L2");
		expect(assignRecordTier(record({ type: "decision" }))).toBe("L2");
	});

	it("sends superseded and archived records to history regardless of type", () => {
		expect(assignRecordTier(record({ type: "fact", verification: "superseded" }))).toBe("L4");
		expect(assignRecordTier(record({ type: "decision", verification: "archived" }))).toBe("L4");
	});
});

describe("estimateRecordTokens", () => {
	it("estimates one token per four characters, summed", () => {
		const a = record({ content: "abcd" });
		const b = record({ content: "abcdefgh" });
		expect(estimateRecordTokens([a])).toBe(1);
		expect(estimateRecordTokens([a, b])).toBe(3);
		expect(estimateRecordTokens([])).toBe(0);
	});
});

describe("composeContextPacket", () => {
	it("places identity and task state into L0/L1 and retrieved facts into L2", () => {
		const identity = record({ content: "I am the coding agent" });
		const state = record({ type: "working-state", content: "fixing the parser" });
		const fact = record({ content: "parser lives in src/parse" });
		const packet = composeContextPacket([fact], { identity: [identity], taskState: [state] });
		expect(packet.tiers.L0).toHaveLength(1);
		expect(packet.tiers.L1).toHaveLength(1);
		expect(packet.tiers.L2).toHaveLength(1);
	});

	it("gives history a zero budget by default", () => {
		const episode = record({ type: "episode", content: "last week we refactored" });
		const packet = composeContextPacket([episode]);
		expect(packet.tiers.L4).toHaveLength(0);
	});

	it("respects the total budget when filling L2", () => {
		const big = record({ content: "x".repeat(4000) });
		const small = record({ content: "tiny fact" });
		const packet = composeContextPacket([big, small], { totalBudget: 100 });
		expect(packet.tiers.L2).toHaveLength(1);
		expect(packet.tiers.L2[0].content).toBe("tiny fact");
		expect(packet.estimatedTokens <= 100).toBe(true);
	});

	it("preserves broker ranking order within a tier", () => {
		const first = record({ content: "first fact" });
		const second = record({ content: "second fact" });
		const packet = composeContextPacket([first, second]);
		expect(packet.tiers.L2[0].id).toBe(first.id);
		expect(packet.tiers.L2[1].id).toBe(second.id);
	});

	it("records provenance for every shipped record", () => {
		const fact = record();
		const packet = composeContextPacket([fact]);
		expect(packet.provenance[fact.id]).toBe("observed | fact | user-message:msg-1");
	});

	it("warns when provisional records ship", () => {
		const provisional = record({ verification: "model-proposed" });
		const packet = composeContextPacket([provisional]);
		expect(packet.warnings).toEqual(["1 provisional records included"]);
	});

	it("emits no warnings for a fully verified packet", () => {
		const packet = composeContextPacket([record()]);
		expect(packet.warnings).toEqual([]);
	});

	it("defaults to the compact-first representation policy", () => {
		expect(composeContextPacket([]).representationPolicy).toBe("compact-first");
		expect(composeContextPacket([], { representationPolicy: "mixed" }).representationPolicy).toBe("mixed");
	});

	it("is deterministic for identical inputs", () => {
		const records = [record({ id: "mem_a", content: "alpha" }), record({ id: "mem_b", content: "beta" })];
		const one = composeContextPacket(records);
		const two = composeContextPacket(records);
		expect(one.estimatedTokens).toBe(two.estimatedTokens);
		expect(one.tiers.L2.map(r => r.id)).toEqual(two.tiers.L2.map(r => r.id));
	});
});

describe("formatContextForModel", () => {
	it("renders sections for identity, task state, verified, and provisional", () => {
		const packet = composeContextPacket(
			[record({ content: "verified fact" }), record({ content: "guess", verification: "model-proposed" })],
			{
				identity: [record({ content: "identity line" })],
				taskState: [record({ type: "working-state", content: "state line" })],
			},
		);
		const text = formatContextForModel(packet);
		expect(text).toContain("[MEMORY CONTEXT: IDENTITY]");
		expect(text).toContain("[MEMORY CONTEXT: TASK STATE]");
		expect(text).toContain("[MEMORY CONTEXT: VERIFIED]");
		expect(text).toContain("[MEMORY CONTEXT: PROVISIONAL]");
		expect(text).toContain("- verified fact [fact]");
		expect(text).toContain("confidence: 0.5");
	});

	it("omits empty sections and always ends with provenance", () => {
		const packet = composeContextPacket([]);
		const text = formatContextForModel(packet);
		expect(text).toContain("---");
		expect(text).toContain("Provenance:");
		expect(text.includes("[MEMORY CONTEXT: IDENTITY]")).toBe(false);
	});
});
