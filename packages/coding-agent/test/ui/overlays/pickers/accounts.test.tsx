/** @jsxImportSource @oh-my-pi/pi-tui */
import type { UiEvent } from "@oh-my-pi/pi-tui";
import type { LogoutAccount } from "../../../../src/modes/view-model/overlays/logout-account-selector";
import type { ResetUsageAccount } from "../../../../src/modes/view-model/overlays/reset-usage-selector";
import { LogoutAccountSelector } from "../../../../src/ui/overlays/pickers/logout-account-selector";
import { ResetUsageSelector } from "../../../../src/ui/overlays/pickers/reset-usage-selector";
import { type Driver, pickerSuite } from "./harness";

const noop = (): void => {};

/**
 * A step event. The old screens also listened on a `list` keypath (their
 * pre-picker tree), where a click highlighted and confirmed at once; the
 * picker tree has no such node, so those steps replay as the picker gesture
 * with the same effect (`activate`).
 */
function ev(
	event: { type: "select" | "activate"; key: string; item: string } | { type: "action"; key: string; act: string },
) {
	return (d: Driver): void => {
		if (event.key === "list" && event.type !== "action") {
			d.emit({ type: "activate", key: "picker", item: event.item });
			return;
		}
		d.emit((event.type === "action" ? { ...event, mods: [] } : event) as UiEvent);
	};
}

const acct = (id: number, label: string, extra: Partial<LogoutAccount> = {}): LogoutAccount => ({
	credentialId: id,
	provider: "anthropic",
	label,
	detail: "",
	type: "oauth",
	active: false,
	...extra,
});
const FEW = [
	acct(1, "me@example.com", { detail: "Acme org" }),
	acct(2, "work", { active: true, type: "api_key" }),
	acct(3, "ユーザー日本語"),
];
const MANY = Array.from({ length: 25 }, (_, i) =>
	acct(i + 10, `account-${i}@example.com`, { detail: i % 3 ? `org ${i}` : "", active: i === 12 }),
);

pickerSuite({
	dir: "overlays/logout-account-selector",
	mount(caseName) {
		const [provider, accounts] =
			caseName === "few" ? ["Anthropic", FEW] : caseName === "many" ? ["Very\tLong  Provider", MANY] : ["", []];
		return {
			view: () => (
				<LogoutAccountSelector
					provider={provider}
					accounts={accounts}
					onSelect={noop}
					onOpenConnection={noop}
					onCancel={noop}
				/>
			),
			steps: {
				"picker select": ev({ type: "select", key: "picker", item: "3" }),
				"picker select many": ev({ type: "select", key: "picker", item: "20" }),
				"list select": ev({ type: "select", key: "list", item: "1" }),
				"list activate": ev({ type: "activate", key: "list", item: "15" }),
				"list unknown": ev({ type: "select", key: "list", item: "999" }),
				"picker activate": ev({ type: "activate", key: "picker", item: "2" }),
				confirm: ev({ type: "action", key: "picker", act: "confirm" }),
				close: ev({ type: "action", key: "picker", act: "close" }),
				"other key": ev({ type: "select", key: "other", item: "1" }),
			},
		};
	},
});

const FIXED = Date.parse("2026-11-23T12:00:00Z");
const reset = (id: number, extra: Partial<ResetUsageAccount> = {}): ResetUsageAccount => ({
	label: `user${id}@example.com`,
	provider: "anthropic",
	providerLabel: "Anthropic",
	availableCount: 2,
	redeemableCount: 2,
	target: { credentialId: id, provider: "anthropic" },
	active: false,
	...extra,
});
const RESET_FEW: ResetUsageAccount[] = [
	reset(1, {
		active: true,
		expiresAt: "2026-11-25T12:00:00Z",
		credit: { title: "Weekend boost", program: "juniper_tide" } as ResetUsageAccount["credit"],
	}),
	reset(2, { redeemableCount: 0, unavailableReason: "limit\tnot reached\nyet" }),
	reset(3, { error: "fetch failed:\n500" }),
	reset(4, {
		availableCount: 3,
		redeemableCount: 1,
		expiresAt: "2026-11-01T00:00:00Z",
		credit: { clears: ["5h", "weekly"], requiresLimit: false } as ResetUsageAccount["credit"],
	}),
	reset(5, {
		label: "ユーザー 日本語",
		providerLabel: "OpenAI",
		provider: "openai",
		availableCount: 1,
		redeemableCount: 1,
		target: { credentialId: 5, provider: "openai", creditId: "c1" },
	}),
];
const RESET_MANY = Array.from({ length: 23 }, (_, i) =>
	reset(i + 10, { redeemableCount: i % 4 === 0 ? 0 : 1, availableCount: 1 }),
);

pickerSuite({
	dir: "overlays/reset-usage-selector",
	mount(caseName) {
		const accounts = caseName === "few" ? RESET_FEW : caseName === "many" ? RESET_MANY : [];
		return {
			view: () => <ResetUsageSelector accounts={accounts} onSelect={noop} onCancel={noop} now={() => FIXED} />,
			steps: {
				"picker select 2": ev({ type: "select", key: "picker", item: "anthropic:2:" }),
				"picker confirm (unusable)": ev({ type: "action", key: "picker", act: "confirm" }),
				"picker select 1": ev({ type: "select", key: "picker", item: "anthropic:1:" }),
				"picker activate 1": ev({ type: "activate", key: "picker", item: "anthropic:1:" }),
				"picker cancel pending": ev({ type: "action", key: "picker", act: "cancel" }),
				"picker confirm": ev({ type: "action", key: "picker", act: "confirm" }),
				"list select 4": ev({ type: "select", key: "list", item: "anthropic:4:" }),
				"list activate 5": ev({ type: "activate", key: "list", item: "openai:5:c1" }),
				"list unknown": ev({ type: "select", key: "list", item: "nope" }),
				"other key": ev({ type: "select", key: "x", item: "anthropic:1:" }),
				"picker many": ev({ type: "select", key: "picker", item: "anthropic:30:" }),
				close: ev({ type: "action", key: "picker", act: "close" }),
			},
		};
	},
});
