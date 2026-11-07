import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { Settings } from "../src/config/settings";
import { bindProviderAvailabilityNotices } from "../src/session/provider-availability-notice";
import * as availability from "../src/session/provider-exhaustion";

afterEach(() => vi.restoreAllMocks());

test("two main sessions deliver each claimed transition once through user notices", () => {
	const events: availability.ProviderAvailabilityTransition[] = [
		{ id: "failure", provider: "muse", available: false, class: "entitlement", since: 1_000, failedCallCount: 2 },
		{ id: "recovery", provider: "muse", available: true, class: "entitlement", since: 1_000, failedCallCount: 2 },
	];
	spyOn(availability, "claimProviderTransitions").mockImplementation(() => events.splice(0));
	const notices: Array<{ level: string; message: string; source?: string }> = [];
	const host = {
		settings: Settings.isolated(),
		emitNotice: (level: "info" | "warning", message: string, source?: string) => {
			notices.push({ level, message, source });
		},
	};
	const first = bindProviderAvailabilityNotices(host);
	const second = bindProviderAvailabilityNotices(host);
	try {
		expect(notices).toEqual([
			{
				level: "warning",
				message: "muse unavailable (entitlement); since 1970-01-01T00:00:01.000Z; failed calls: 2",
				source: "provider-availability",
			},
			{
				level: "info",
				message: "muse available (entitlement); since 1970-01-01T00:00:01.000Z; failed calls: 2",
				source: "provider-availability",
			},
		]);
	} finally {
		first();
		second();
	}
});
