import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { AdvisorNote } from "@oh-my-pi/pi-tui/chat/messages";
import { formatAdvisorBatchContent } from "../../src/advisor/advise-tool";
import {
	type AdvisorCuratorCandidate,
	applyAdvisorCuration,
	attributeMergedAdvisorNote,
	curateAdvisorCandidates,
} from "../../src/advisor/curator";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import * as judgment from "../../src/judgment";

function settingsStub(curator: "auto" | "off" = "auto"): Settings {
	return Settings.isolated({ "advisor.curator": curator });
}

const registry = {} as ModelRegistry;

function candidate(
	id: string,
	note: string,
	advisor: string,
	severity: "nit" | "concern" = "nit",
): AdvisorCuratorCandidate {
	return { id, note, advisor, severity, coveredTurn: 1 };
}

const context = { recentPrimaryMessages: "the primary rewrote the parser" };

function stubJudge(answers: Record<string, unknown>): void {
	spyOn(judgment, "resolveJudge").mockReturnValue({
		label: "stub",
		judge: async () => ({ answers }),
	} as unknown as judgment.ChainJudge);
}

afterEach(() => {
	// Full-suite safety: never leave the judge resolver patched for later files.
	spyOn(judgment, "resolveJudge").mockRestore();
});

describe("advisor curator", () => {
	it("collapses the same issue raised by several advisors into one surviving note", async () => {
		const candidates = [
			candidate("a", "the retry loop never backs off", "Reliability"),
			candidate("b", "retries hammer the endpoint with no delay", "Performance", "nit"),
			candidate("c", "no exponential backoff between retries", "Architecture", "nit"),
		];
		stubJudge({
			"addressed:a": { type: "noul", noul: 0.1 },
			"addressed:b": { type: "noul", noul: 0.1 },
			"addressed:c": { type: "noul", noul: 0.1 },
			"duplicate:a": { type: "choice", choice: "cb" },
			"duplicate:b": { type: "choice", choice: "none" },
			"duplicate:c": { type: "choice", choice: "ca" },
		});

		const { decisions } = await curateAdvisorCandidates({ settings: settingsStub(), registry, candidates, context });

		// Exactly one note survives, and it is the highest-severity original —
		// never generated text. The other two merge into it rather than being
		// dropped, so their advisors can still be attributed.
		const kept = decisions.filter(decision => decision.action === "keep");
		expect(kept.map(decision => decision.candidateId)).toEqual(["a"]);
		const merged = decisions.filter(decision => decision.action === "merge");
		expect(merged.map(decision => decision.mergeInto)).toEqual(["a", "a"]);
	});

	it("never elects two candidates as each other's merge target", async () => {
		const candidates = [candidate("a", "same issue", "One"), candidate("b", "same issue, other words", "Two")];
		stubJudge({
			"addressed:a": { type: "noul", noul: 0 },
			"addressed:b": { type: "noul", noul: 0 },
			"duplicate:a": { type: "choice", choice: "cb" },
			"duplicate:b": { type: "choice", choice: "ca" },
		});

		const { decisions } = await curateAdvisorCandidates({ settings: settingsStub(), registry, candidates, context });

		// A pairwise merge would leave a → b and b → a, a cycle in which no note
		// reaches the primary at all.
		expect(decisions.filter(decision => decision.action === "keep")).toHaveLength(1);
		const merge = decisions.find(decision => decision.action === "merge");
		expect(merge?.mergeInto).not.toBe(merge?.candidateId);
	});

	it("drops a note the primary's recent work already resolved", async () => {
		const candidates = [
			candidate("a", "parser ignores CRLF", "Correctness"),
			candidate("b", "add a CHANGELOG entry", "Process"),
		];
		stubJudge({
			"addressed:a": { type: "noul", noul: 0.92 },
			"addressed:b": { type: "noul", noul: 0.04 },
			"duplicate:a": { type: "choice", choice: "none" },
			"duplicate:b": { type: "choice", choice: "none" },
		});

		const { decisions } = await curateAdvisorCandidates({ settings: settingsStub(), registry, candidates, context });

		expect(decisions.find(decision => decision.candidateId === "a")?.action).toBe("drop");
		expect(decisions.find(decision => decision.candidateId === "b")?.action).toBe("keep");
	});

	it("keeps two unrelated duplicate pairs as two notes", async () => {
		const candidates = [
			candidate("a", "get() runs eviction on every read", "One"),
			candidate("b", "reads cost O(n) because get() evicts", "Two", "nit"),
			candidate("c", "no test covers TTL expiry", "One", "nit"),
			candidate("d", "TTL expiry is untested", "Three", "nit"),
		];
		stubJudge({
			"addressed:a": { type: "noul", noul: 0.1 },
			"addressed:b": { type: "noul", noul: 0.1 },
			"addressed:c": { type: "noul", noul: 0.1 },
			"addressed:d": { type: "noul", noul: 0.1 },
			"duplicate:a": { type: "choice", choice: "cb" },
			"duplicate:b": { type: "choice", choice: "ca" },
			"duplicate:c": { type: "choice", choice: "cd" },
			"duplicate:d": { type: "choice", choice: "cc" },
		});

		const { decisions } = await curateAdvisorCandidates({ settings: settingsStub(), registry, candidates, context });

		// One survivor per issue: collapsing every "duplicate" into a single
		// group would silently lose the TTL issue.
		expect(decisions.filter(decision => decision.action === "keep").map(decision => decision.candidateId)).toEqual([
			"a",
			"c",
		]);
		expect(decisions.find(decision => decision.candidateId === "b")?.mergeInto).toBe("a");
		expect(decisions.find(decision => decision.candidateId === "d")?.mergeInto).toBe("c");
	});

	it("never withholds a concern even when the judge says it was already fixed", async () => {
		const candidates = [
			candidate("a", "fetch has no timeout", "One", "concern"),
			candidate("b", "rename the helper", "Two", "nit"),
		];
		stubJudge({
			"addressed:a": { type: "noul", noul: 0.95 },
			"addressed:b": { type: "noul", noul: 0.95 },
		});

		const { decisions } = await curateAdvisorCandidates({ settings: settingsStub(), registry, candidates, context });

		// A false "already fixed" on a concern loses real advice, so only the nit is withheld.
		expect(decisions.map(decision => decision.action)).toEqual(["keep", "drop"]);
	});

	it("delivers every candidate unchanged when curation is off", async () => {
		const resolve = spyOn(judgment, "resolveJudge");
		const candidates = [candidate("a", "one", "One"), candidate("b", "two", "Two")];

		const { decisions } = await curateAdvisorCandidates({
			settings: settingsStub("off"),
			registry,
			candidates,
			context,
		});

		expect(decisions.every(decision => decision.action === "keep")).toBe(true);
		// Disabled means no judgment backend is consulted at all.
		expect(resolve).not.toHaveBeenCalled();
	});

	it("delivers every candidate unchanged when the judge fails", async () => {
		const candidates = [candidate("a", "one", "One"), candidate("b", "two", "Two")];
		spyOn(judgment, "resolveJudge").mockReturnValue({
			label: "stub",
			judge: async () => {
				throw new Error("no judgment backend");
			},
		} as unknown as judgment.ChainJudge);

		const { decisions } = await curateAdvisorCandidates({ settings: settingsStub(), registry, candidates, context });

		// Fail-open: a curator outage must cost advice quality, never advice.
		expect(decisions.map(decision => decision.action)).toEqual(["keep", "keep"]);
	});

	it("keeps a candidate the judge answered nothing about", async () => {
		const candidates = [candidate("a", "one", "One")];
		stubJudge({});

		const { decisions } = await curateAdvisorCandidates({ settings: settingsStub(), registry, candidates, context });

		expect(decisions).toEqual([{ candidateId: "a", action: "keep" }]);
	});

	it("delivers every candidate unchanged when the judge exceeds the timeout", async () => {
		const candidates = [candidate("a", "one", "One"), candidate("b", "two", "Two"), candidate("c", "three", "Three")];
		spyOn(judgment, "resolveJudge").mockReturnValue({
			label: "stub",
			judge: (_request: unknown, options?: { signal?: AbortSignal }) => {
				const { promise, reject } = Promise.withResolvers<never>();
				options?.signal?.addEventListener("abort", () => reject(options.signal?.reason ?? new Error("aborted")));
				return promise;
			},
		} as unknown as judgment.ChainJudge);

		const { decisions } = await curateAdvisorCandidates({
			settings: settingsStub(),
			registry,
			candidates,
			context,
			signal: AbortSignal.timeout(20),
		});

		// The point of the timeout is that advice still arrives: a slow judge may
		// cost curation quality, never a note.
		expect(decisions.map(decision => decision.action)).toEqual(["keep", "keep", "keep"]);
	});

	it("marks only the surviving note as curated and renders it for the agent", () => {
		const notes: AdvisorNote[] = [
			{ note: "the retry loop never backs off", severity: "nit", advisor: "Reliability" },
			{ note: "retries hammer the endpoint", severity: "nit", advisor: "Performance" },
			{ note: "rename the helper", severity: "nit", advisor: "Style" },
		];

		const applied = applyAdvisorCuration(notes, [
			{ candidateId: "0", action: "keep" },
			{ candidateId: "1", action: "merge", mergeInto: "0" },
			{ candidateId: "2", action: "keep" },
		]);

		// Only the note that absorbed another advisor's report is flagged.
		expect(applied.map(note => note.curated)).toEqual([true, undefined]);
		const rendered = formatAdvisorBatchContent(applied);
		expect(rendered).toContain('advisor="Reliability" severity="nit" curated="true"');
		expect(rendered).not.toContain('advisor="Style" severity="nit" curated');
		// Attribution stays inside the note; the curator never signs it.
		expect(rendered).not.toContain("Curator");
		expect(rendered).toContain("Also raised by Performance.");
	});

	it("attributes merged sources without restating their notes", () => {
		expect(
			attributeMergedAdvisorNote("the retry loop never backs off", ["Performance", "Architecture", undefined]),
		).toBe("the retry loop never backs off\n\nAlso raised by Performance, Architecture.");
		expect(attributeMergedAdvisorNote("solo", [])).toBe("solo");
	});
});
