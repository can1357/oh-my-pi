import { describe, expect, it } from "bun:test";
import { buildModelFallbackNotification, renderStartupModelNotice } from "../src/main";

describe("buildModelFallbackNotification", () => {
	it("renders a --reapply-config adoption as informational, not a warning", () => {
		// The documented contract on `modelFallbackMessage`: a config swap the user
		// asked for with `--reapply-config` is the flag working, so it must not be
		// dressed up as a warning.
		const notify = buildModelFallbackNotification(
			"--reapply-config: resumed on anthropic/claude-sonnet-4-5 from config instead of the session's openai/gpt-5",
		);
		expect(notify.kind).toBe("info");
	});

	it("keeps a --reapply-config unresolved config default as a warning", () => {
		// Same flag, but the config named a model that did not resolve: a real
		// fallback the user should see as a warning.
		const notify = buildModelFallbackNotification(
			'--reapply-config: config default "anthropic/nope" did not resolve; kept the session\'s anthropic/claude-sonnet-4-5',
		);
		expect(notify.kind).toBe("warn");
	});

	it("keeps a --reapply-config double failure as a warning", () => {
		const notify = buildModelFallbackNotification(
			'--reapply-config: config default "anthropic/nope" did not resolve and the session\'s openai/gone could not be restored; using anthropic/claude-sonnet-4-5',
		);
		expect(notify.kind).toBe("warn");
	});

	it("keeps an ordinary model-restore fallback as a warning", () => {
		const notify = buildModelFallbackNotification(
			"Could not restore the session's openai/gpt-5; using anthropic/claude-sonnet-4-5",
		);
		expect(notify.kind).toBe("warn");
	});

	it("classifies by prefix, so an adoption phrase quoted mid-message stays a warning", () => {
		// The `info` downgrade is anchored to the start of the message because
		// only `sdk.ts` emits that exact prefix. A failure notice that merely
		// mentions the phrase must not inherit the downgrade — relaxing the match
		// to a substring test would silence a real fallback warning.
		const notify = buildModelFallbackNotification(
			"Could not restore the session's openai/gpt-5 (--reapply-config: resumed on anthropic/claude-opus-4-1 from config instead of the session's x/y)",
		);
		expect(notify.kind).toBe("warn");
	});
});

describe("renderStartupModelNotice", () => {
	const ADOPTION =
		"--reapply-config: resumed on anthropic/claude-sonnet-4-5 from config instead of the session's openai/gpt-5";

	it("reports an adopted config model under -p", () => {
		// `notifs` is drained only by `runInteractiveMode`, and the noninteractive
		// print block is gated on having NO model — so a `--reapply-config` run
		// that successfully adopted a different model told the user nothing.
		const notice = renderStartupModelNotice({
			isInteractive: false,
			hasModel: true,
			modelFallbackMessage: ADOPTION,
		});

		expect(notice).toBeDefined();
		expect(notice).toContain("resumed on anthropic/claude-sonnet-4-5");
		expect(notice?.endsWith("\n")).toBe(true);
	});

	it("reports a broken config default that still restored the session model", () => {
		const notice = renderStartupModelNotice({
			isInteractive: false,
			hasModel: true,
			modelFallbackMessage:
				'--reapply-config: config default "anthropic/nope" did not resolve; kept the session\'s anthropic/claude-sonnet-4-5',
		});

		expect(notice).toContain("did not resolve");
	});

	it("stays silent in interactive mode, where the notice queue carries it", () => {
		expect(
			renderStartupModelNotice({ isInteractive: true, hasModel: true, modelFallbackMessage: ADOPTION }),
		).toBeUndefined();
	});

	it("stays silent with no model, where the caller prints the longer diagnostic", () => {
		expect(
			renderStartupModelNotice({ isInteractive: false, hasModel: false, modelFallbackMessage: ADOPTION }),
		).toBeUndefined();
	});

	it("stays silent when nothing moved", () => {
		expect(
			renderStartupModelNotice({ isInteractive: false, hasModel: true, modelFallbackMessage: undefined }),
		).toBeUndefined();
	});
});
