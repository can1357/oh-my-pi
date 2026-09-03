import { afterEach, beforeEach } from "bun:test";

/**
 * Neutralize `ANTHROPIC_BASE_URL` for the calling test file.
 *
 * The variable reroutes the effective Anthropic endpoint, and every
 * "official endpoint" behavior — eager tool-input streaming, long cache
 * retention, the Cowork TLS profile, the Claude Code session header — switches
 * off once it points elsewhere. A contributor running a gateway, or running the
 * suite from inside another agent, otherwise sees these tests fail on a clean
 * checkout. Tests that exercise gateway routing set the variable explicitly
 * with `withEnv` inside the test body, which still wins over this reset.
 */
export function withOfficialAnthropicEndpoint(): void {
	let previous: string | undefined;
	beforeEach(() => {
		previous = Bun.env.ANTHROPIC_BASE_URL;
		delete Bun.env.ANTHROPIC_BASE_URL;
	});
	afterEach(() => {
		if (previous === undefined) {
			delete Bun.env.ANTHROPIC_BASE_URL;
		} else {
			Bun.env.ANTHROPIC_BASE_URL = previous;
		}
	});
}
