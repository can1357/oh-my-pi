import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadBeamUpstreamCompat, loadDataset } from "../../bench/memory-eval/datasets";

const fixtureDir = path.join(import.meta.dir, "fixtures", "data");

describe("datasets", () => {
	it("beam flattens ids and unions list and dict gold", async () => {
		const { cases, excluded } = await loadDataset("beam-100k", fixtureDir);
		expect(cases[0].messages.map(m => m.messageId)).toEqual(["0", "1", "2", "3", "4", "5"]);
		expect(cases[0].messages.map(m => m.sessionId)).toEqual([
			"beam-c1-0",
			"beam-c1-0",
			"beam-c1-0",
			"beam-c1-1",
			"beam-c1-1",
			"beam-c1-1",
		]);
		expect(cases[0].questions.map(q => q.goldMessageIds)).toEqual([["1"], ["0", "4"], ["3", "5"]]);
		expect(cases[0].questions.map(q => q.goldSessionIds)).toEqual([
			["beam-c1-0"],
			["beam-c1-0", "beam-c1-1"],
			["beam-c1-1"],
		]);
		expect(cases[0].questions.map(q => q.questionId)).toEqual([
			"c1:information_extraction:0",
			"c1:contradiction_resolution:0",
			"c1:event_ordering:0",
		]);
		expect(excluded.map(e => e.reason)).toEqual(["no-gold", "no-gold"]);
	});
	it("upstream-compat keeps empty messages and only dict gold", async () => {
		const [conv] = await loadBeamUpstreamCompat(fixtureDir, 3);
		expect(conv.messages).toEqual(["alpha", "", "gamma", "delta", "epsilon", "zeta"]);
		expect(conv.questions.map(q => q.goldIndices)).toEqual([[], [0, 4], [], [], []]);
	});
	it("beam throws on a gold id absent from the conversation", async () => {
		await expect(loadDataset("beam-100k", path.join(import.meta.dir, "fixtures", "dangling"))).rejects.toThrow(
			'case c9 question c9:event_ordering:0: gold id "7"',
		);
	});
	it("lme indexes user turns with official ids", async () => {
		const { cases, excluded } = await loadDataset("lme-s", fixtureDir);
		expect(cases[0].messages.map(m => m.messageId)).toEqual(["answer_x_1_1", "noans_x_1_3", "s2_1"]);
		expect(cases[0].questions[0].goldMessageIds).toEqual(["answer_x_1_1"]);
		expect(cases[0].questions[0].goldSessionIds).toEqual(["answer_x_1"]);
		expect(excluded).toEqual([{ questionId: "q_abs", reason: "abstention" }]);
	});
	it("lme-s-dev filters by the committed subset", async () => {
		const { cases } = await loadDataset("lme-s-dev", fixtureDir);
		expect(cases).toEqual([]);
	});
});
