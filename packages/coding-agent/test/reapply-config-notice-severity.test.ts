import { describe, expect, it } from "bun:test";
import { buildModelFallbackNotification } from "../src/main";

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

	it("passes the message through unchanged", () => {
		const message = "--reapply-config: resumed on anthropic/claude-opus-4-1 from config instead of the session's x/y";
		expect(buildModelFallbackNotification(message).message).toBe(message);
	});
});
