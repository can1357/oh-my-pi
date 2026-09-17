import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { appendCoverageNote, extractUserRequests } from "@oh-my-pi/pi-coding-agent/session/compaction-coverage";
import { asGlobalFetch } from "./helpers/fetch-mock";

const LONG_REQUEST = "Please migrate the scheduler to the new retry policy without touching the public API.";
const OTHER_REQUEST = "Keep every commit message in conventional-commits form; the release tooling depends on it.";
const THIRD_REQUEST = "Run the integration suite against the staging database before opening the PR.";

function user(text: string, extra: Partial<Extract<AgentMessage, { role: "user" }>> = {}): AgentMessage {
	return { role: "user", content: text, timestamp: 1, ...extra } as AgentMessage;
}

function assistant(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 1 } as unknown as AgentMessage;
}

describe("compaction coverage", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("extractUserRequests", () => {
		it("keeps user-authored text and drops agent, synthetic, assistant, and short messages", () => {
			const requests = extractUserRequests([
				user(LONG_REQUEST),
				assistant("Working on it; the summary of my reasoning is long enough to look like a request."),
				user("Summarize and hand off the session for a fresh context window.", { attribution: "agent" }),
				user("Continue where you left off; keep going until the task is done.", { synthetic: true }),
				user("ok do that"),
				user("", { content: [{ type: "text", text: OTHER_REQUEST }] } as never),
			]);

			expect(requests).toEqual([LONG_REQUEST, OTHER_REQUEST]);
		});

		it("keeps the first and last halves when more than the cap qualify", () => {
			const messages = Array.from({ length: 30 }, (_, index) => user(`${LONG_REQUEST} (request number ${index})`));

			const requests = extractUserRequests(messages);

			expect(requests).toHaveLength(24);
			expect(requests[0]).toContain("(request number 0)");
			expect(requests[11]).toContain("(request number 11)");
			expect(requests[12]).toContain("(request number 18)");
			expect(requests[23]).toContain("(request number 29)");
		});
	});

	describe("appendCoverageNote", () => {
		function typeSafeRegistry() {
			return {
				authStorage: { hasAuth: (provider: string) => provider === "typesafe", resolver: () => "ts-key" },
				getAvailable: () => [],
			} as never;
		}

		it("leaves the summary alone when the check is disabled", async () => {
			const fetchMock = vi.spyOn(globalThis, "fetch");

			const result = await appendCoverageNote("## Goal\nShip it.", {
				settings: Settings.isolated({}),
				registry: typeSafeRegistry(),
				messages: [user(LONG_REQUEST)],
			});

			expect(result).toBe("## Goal\nShip it.");
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("asks one noul per request and lists the ones the judge reports missing ahead of the files block", async () => {
			let requested:
				| { state: unknown; questions: Record<string, { type: string; instructions: string }> }
				| undefined;
			vi.spyOn(globalThis, "fetch").mockImplementation(
				asGlobalFetch(async (_url, init) => {
					requested = JSON.parse(String(init?.body));
					return Response.json({
						model: "jev-latest",
						answers: {
							request0: { type: "noul", noul: 0.92 },
							request1: { type: "noul", noul: 0.12 },
							request2: { type: "noul", noul: 0.4 },
						},
						usage: { input_tokens: 300, output_tokens: 3 },
					});
				}),
			);
			const onUsage = vi.fn();
			const summary = "## Goal\nMigrate the scheduler retry policy.\n\n<files>\nsrc/scheduler.ts (RW)\n</files>\n";

			const result = await appendCoverageNote(summary, {
				settings: Settings.isolated({ "compaction.coverageCheck": true }),
				registry: typeSafeRegistry(),
				messages: [user(LONG_REQUEST), assistant("done"), user(OTHER_REQUEST), user(THIRD_REQUEST)],
				onUsage,
			});

			expect(requested?.state).toEqual({ summary, requests: [LONG_REQUEST, OTHER_REQUEST, THIRD_REQUEST] });
			expect(Object.keys(requested?.questions ?? {})).toEqual(["request0", "request1", "request2"]);
			expect(requested?.questions.request1.type).toBe("noul");
			expect(requested?.questions.request1.instructions).toContain("`requests[1]`");
			expect(result).toBe(
				[
					"## Goal",
					"Migrate the scheduler retry policy.",
					"",
					"## Uncovered User Requests",
					"",
					"The summary above does not reflect these user messages from the compacted conversation. They still apply.",
					"",
					`- ${OTHER_REQUEST}`,
					`- ${THIRD_REQUEST}`,
					"",
					"<files>",
					"src/scheduler.ts (RW)",
					"</files>",
					"",
				].join("\n"),
			);
			expect(onUsage).toHaveBeenCalledWith(
				expect.objectContaining({
					role: "typesafe",
					provider: "typesafe",
					model: "jev-latest",
					stopReason: "stop",
				}),
			);
		});

		it("appends at the end when there is no files block and returns the summary unchanged when everything is covered", async () => {
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
				asGlobalFetch(async () =>
					Response.json({
						model: "jev-latest",
						answers: { request0: { type: "noul", noul: 0.2 } },
						usage: { input_tokens: 100, output_tokens: 1 },
					}),
				),
			);
			const deps = {
				settings: Settings.isolated({ "compaction.coverageCheck": true }),
				registry: typeSafeRegistry(),
				messages: [user(LONG_REQUEST)],
			};

			expect(await appendCoverageNote("## Goal\nShip it.", deps)).toBe(
				`## Goal\nShip it.\n\n## Uncovered User Requests\n\nThe summary above does not reflect these user messages from the compacted conversation. They still apply.\n\n- ${LONG_REQUEST}\n`,
			);

			fetchMock.mockImplementation(
				asGlobalFetch(async () =>
					Response.json({
						model: "jev-latest",
						answers: { request0: { type: "noul", noul: 0.95 } },
						usage: { input_tokens: 100, output_tokens: 1 },
					}),
				),
			);
			expect(await appendCoverageNote("## Goal\nShip it.", deps)).toBe("## Goal\nShip it.");
		});

		it("skips the judge when no message qualifies and fails open when every backend fails", async () => {
			const fetchMock = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(asGlobalFetch(async () => new Response("unauthorized", { status: 401 })));
			const settings = Settings.isolated({ "compaction.coverageCheck": true });

			expect(
				await appendCoverageNote("## Goal\nShip it.", {
					settings,
					registry: typeSafeRegistry(),
					messages: [user("ok"), assistant(LONG_REQUEST)],
				}),
			).toBe("## Goal\nShip it.");
			expect(fetchMock).not.toHaveBeenCalled();

			// TypeSafe rejects the key and no tiny/smol/default role or session
			// model exists to fall back to: the summary goes out as generated.
			expect(
				await appendCoverageNote("## Goal\nShip it.", {
					settings,
					registry: typeSafeRegistry(),
					messages: [user(LONG_REQUEST)],
				}),
			).toBe("## Goal\nShip it.");
			expect(fetchMock).toHaveBeenCalled();
		});
	});
});
