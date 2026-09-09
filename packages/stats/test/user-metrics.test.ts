import { describe, expect, it } from "bun:test";
import { computeUserMessageMetrics, EMPTY_USER_METRICS } from "@oh-my-pi/omp-stats/user-metrics";

describe("computeUserMessageMetrics", () => {
	it("returns zeros for empty / whitespace-only text", () => {
		expect(computeUserMessageMetrics("")).toEqual({ ...EMPTY_USER_METRICS });
		expect(computeUserMessageMetrics("   \n\t ")).toEqual({ ...EMPTY_USER_METRICS });
	});

	it("counts multi-word caps as yelling when >50% of letters are uppercase", () => {
		const m = computeUserMessageMetrics("STOP DOING THAT NOW");
		expect(m.yelling).toBe(1);
	});

	it("treats mostly-lowercase sentences as not yelling even with embedded CAPS", () => {
		const m = computeUserMessageMetrics("Hi there, please STOP doing THAT immediately, it is really annoying.");
		expect(m.yelling).toBe(0);
	});

	it("ignores very short uppercase fragments below the letter floor", () => {
		expect(computeUserMessageMetrics("OK").yelling).toBe(0);
		expect(computeUserMessageMetrics("WIP.").yelling).toBe(0);
	});

	it("counts multiple yelling sentences separated by terminators", () => {
		const m = computeUserMessageMetrics("WHY IS THIS BROKEN? FIX IT NOW!! please.");
		expect(m.yelling).toBe(2);
	});

	it("does not flag camelCase / acronyms inside otherwise-lowercase prose", () => {
		const m = computeUserMessageMetrics("call getHTMLParser then exit");
		expect(m.yelling).toBe(0);
	});

	it("requires multi-word caps or an elongated shout before yelling", () => {
		expect(computeUserMessageMetrics("Follow AGENTS.md and SYSTEM.md carefully.").yelling).toBe(0);
		expect(computeUserMessageMetrics("HELLO").yelling).toBe(0);
		expect(computeUserMessageMetrics("WHAT THE HELL").yelling).toBe(1);
		expect(computeUserMessageMetrics("CMOOON").yelling).toBe(1);
	});

	it("matches profanity case-insensitively at word boundaries only", () => {
		// Regression: prior version used a non-raw template literal so `\b` was
		// compiled as backspace (U+0008) and the regex matched nothing in real
		// prose. Lock the word-boundary contract in.
		const m = computeUserMessageMetrics("oh FUCK this is bullshit, damn it");
		expect(m.profanity).toBe(3);
		expect(computeUserMessageMetrics("import classes from module").profanity).toBe(0);
	});

	it("does not treat technical or opinion vocabulary as profanity", () => {
		expect(computeUserMessageMetrics("this is garbage, useless and horrible work").profanity).toBe(0);
		expect(computeUserMessageMetrics("dummy data, blast radius, and config knob").profanity).toBe(0);
	});

	it("does not count the version-control tool `git` as profanity", () => {
		// Regression for #2457: `git` was dropped from the profanity list so
		// ordinary repository prose no longer scores as profanity. The slang
		// plural `gits` is intentionally retained.
		expect(computeUserMessageMetrics("git status shows the rebase failed").profanity).toBe(0);
		expect(computeUserMessageMetrics("run git commit then git push").profanity).toBe(0);
	});

	it("counts drama runs and elongated interjections as `anguish` but ignores dot trails", () => {
		expect(computeUserMessageMetrics("why!!! seriously??? omg!?!?!?").anguish).toBe(3);
		expect(computeUserMessageMetrics("nooo whyyy").anguish).toBe(2);
		expect(computeUserMessageMetrics("ok!! sure??").anguish).toBe(0);
		expect(computeUserMessageMetrics("waiting.. still loading...").anguish).toBe(0);
	});

	it("scores plain frustration interjections as anguish, not profanity", () => {
		for (const text of ["ugh", "argh", "grr"]) {
			const m = computeUserMessageMetrics(text);
			expect(m.anguish).toBe(1);
			expect(m.profanity).toBe(0);
		}

		const elongated = computeUserMessageMetrics("ughh");
		expect(elongated.anguish).toBe(1);
		expect(elongated.profanity).toBe(0);
	});

	it("absorbs shift-key `1` mishits into a single drama burst", () => {
		expect(computeUserMessageMetrics("what!!!111").anguish).toBeGreaterThanOrEqual(1);
		expect(computeUserMessageMetrics("are you serious!?!?!??111").anguish).toBeGreaterThanOrEqual(1);
		expect(computeUserMessageMetrics("port 8111 please").anguish).toBe(0);
	});

	it("counts sad emoticons as anguish without matching code-like punctuation", () => {
		expect(computeUserMessageMetrics("nope still same :(").anguish).toBeGreaterThanOrEqual(1);
		expect(computeUserMessageMetrics(":((").anguish).toBe(1);
		expect(computeUserMessageMetrics("match foo:(bar) in code").anguish).toBe(0);
	});

	describe("negation signal", () => {
		it("fires on line-leading correction openers", () => {
			expect(computeUserMessageMetrics("no this is the renderer").negation).toBe(1);
			expect(computeUserMessageMetrics("nope, still wrong").negation).toBe(1);
			expect(computeUserMessageMetrics("nah look at this").negation).toBe(1);
			expect(computeUserMessageMetrics("wrong file").negation).toBe(1);
			expect(computeUserMessageMetrics("nvm got it").negation).toBe(1);
		});

		it("gates bare leading `no` to interjection uses", () => {
			expect(computeUserMessageMetrics("no extensions to the landing page").negation).toBe(0);
			expect(computeUserMessageMetrics("no-op change for the flag").negation).toBe(0);
			expect(computeUserMessageMetrics("no - not that one").negation).toBe(1);
			expect(computeUserMessageMetrics("no—wait").negation).toBe(1);
			expect(computeUserMessageMetrics("no i meant the other one").negation).toBe(1);
			expect(computeUserMessageMetrics("no, wait").negation).toBe(1);
		});

		it("does not fire on words that share a prefix with negation tokens", () => {
			// `now`, `nobody`, `north`, `noble`, `normal` all start with `no` but
			// are not corrective negation.
			expect(computeUserMessageMetrics("now everything works").negation).toBe(0);
			expect(computeUserMessageMetrics("nobody knows why").negation).toBe(0);
			expect(computeUserMessageMetrics("normal operation resumed").negation).toBe(0);
		});

		it("only anchors at the start of the message - mid-message `no`/`No` lines do not fire", () => {
			// Real corrective negation overwhelmingly opens the message. Pasted error
			// text and bullet lists trip the old `^...$/m` anchor with FPs like
			// "Wrong user name or password" or "No JSDoc warning on X".
			expect(computeUserMessageMetrics("i instantly get Finalizing ->\nNo speech detected").negation).toBe(0);
			expect(computeUserMessageMetrics("Authentication failed\n\nWrong user name or password").negation).toBe(0);
		});

		it("strips `[Image #N]` placeholders so message-leading negation still fires", () => {
			// The TUI inserts `[Image #1]` markers ahead of real user prose; the
			// strip pass removes them so anchored-at-start negation still works.
			expect(computeUserMessageMetrics("[Image #1] nope still broken").negation).toBe(1);
		});

		it("fires on explicit rejection phrases", () => {
			expect(computeUserMessageMetrics("thats not what i wanted").negation).toBe(1);
			expect(computeUserMessageMetrics("that's not right").negation).toBe(1);
			expect(computeUserMessageMetrics("this is not what i meant at all").negation).toBe(1);
		});

		it("fires on negative sense-making phrases without flagging affirmative sense", () => {
			expect(computeUserMessageMetrics("ok but this makes no sense").negation).toBe(1);
			expect(computeUserMessageMetrics("ok but this makes zero sense").negation).toBe(1);
			expect(computeUserMessageMetrics("the docs explain it well and it makes sense").negation).toBe(0);
		});
	});

	describe("repetition signal", () => {
		it("counts explicit recall verbs", () => {
			expect(computeUserMessageMetrics("i meant the other file").repetition).toBe(1);
			expect(computeUserMessageMetrics("i told you to skip it").repetition).toBe(1);
			expect(computeUserMessageMetrics("i asked you for json not yaml").repetition).toBe(1);
			expect(computeUserMessageMetrics("like i said earlier").repetition).toBe(1);
		});

		it("requires `you` after `i asked` to suppress neutral third-party usage", () => {
			// In the real corpus, bare `i asked` is overwhelmingly "i asked
			// <some third party>" - committee, experts, weaker LLMs, etc. -
			// which is not frustration with us. The `(like|as) i asked` form is
			// still allowed because it always refers back to our own ask.
			expect(computeUserMessageMetrics("i asked the committee to review").repetition).toBe(0);
			expect(computeUserMessageMetrics("so i asked a bunch of experts").repetition).toBe(0);
			expect(computeUserMessageMetrics("you're not doing AST rewriting like i asked").repetition).toBe(1);
		});

		it("counts `still` only when paired with a negative / sameness marker", () => {
			// Bare `still` would over-fire on neutral usage.
			expect(computeUserMessageMetrics("the agent still works fine").repetition).toBe(0);
			expect(computeUserMessageMetrics("it still doesnt work").repetition).toBe(1);
			expect(computeUserMessageMetrics("still the same issue").repetition).toBe(1);
			expect(computeUserMessageMetrics("still failing on darwin").repetition).toBe(1);
		});
	});

	describe("blame signal", () => {
		it("fires on accusatory second-person verbs", () => {
			expect(computeUserMessageMetrics("you broke the layout").blame).toBe(1);
			expect(computeUserMessageMetrics("you didnt update AGENTS").blame).toBe(1);
			expect(computeUserMessageMetrics("you missed a callsite").blame).toBe(1);
			expect(computeUserMessageMetrics("you forgot to commit").blame).toBe(1);
			expect(computeUserMessageMetrics("you keep doing that").blame).toBe(1);
		});

		it("does not fire on bare `you`", () => {
			// `you` alone is too generic - dominated by neutral instructions.
			expect(computeUserMessageMetrics("can you fix the bug?").blame).toBe(0);
			expect(computeUserMessageMetrics("could you also add a test").blame).toBe(0);
		});

		it("fires on blamey why-did-you questions without flagging neutral why questions", () => {
			expect(computeUserMessageMetrics("why did you list the request as is?").blame).toBe(1);
			expect(computeUserMessageMetrics("why would u delete the config?").blame).toBe(1);
			expect(computeUserMessageMetrics("why is this slow").blame).toBe(0);
			expect(computeUserMessageMetrics("why does it use webpack").blame).toBe(0);
		});

		it("only fires on `stop X-ing` at sentence start", () => {
			expect(computeUserMessageMetrics("stop touching git").blame).toBe(1);
			expect(computeUserMessageMetrics("please stop making yolo changes").blame).toBe(0); // mid-sentence
			expect(computeUserMessageMetrics("ok. stop reverting things").blame).toBe(1);
			// `nonstop`/`stopping` should not match the imperative pattern.
			expect(computeUserMessageMetrics("the loop keeps stopping").blame).toBe(0);
		});
	});

	it("zeros out behavior signals on long structured prompts", () => {
		// >= 3 non-empty prose lines after stripping = deliberate prompt, not a tantrum.
		const long = [
			"no this is wrong, you broke it, i meant the other one.",
			"please undo and try again.",
			"acceptance: green tests.",
			"thanks!",
		].join("\n");
		const m = computeUserMessageMetrics(long);
		expect(m.negation).toBe(0);
		expect(m.repetition).toBe(0);
		expect(m.blame).toBe(0);
		expect(m.anguish).toBe(0);
		expect(m.profanity).toBe(0);
		expect(m.yelling).toBe(0);
		// But char/word counts still reflect the raw text.
		expect(m.chars).toBeGreaterThan(0);
		expect(m.words).toBeGreaterThan(0);
	});

	it("captures multiple frustration signals on a single short message", () => {
		const m = computeUserMessageMetrics("no, you broke it AGAIN. i told you it still doesnt work");
		expect(m.negation).toBe(1);
		expect(m.blame).toBe(1);
		expect(m.repetition).toBeGreaterThanOrEqual(2); // `i told you` + `still doesnt`
	});
});
