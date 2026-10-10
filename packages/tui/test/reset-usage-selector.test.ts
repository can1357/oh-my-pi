import { beforeAll, describe, expect, it } from "bun:test";
import type { UsageResetCredit } from "@oh-my-pi/pi-ai";
import { formatKeyHint } from "../src/app-keybindings";
import type { NativeNode } from "../src/native/node";
import { type ResetUsageAccount, ResetUsageSelectorComponent } from "../src/overlays/reset-usage-selector";
import { initTheme } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function credits(): UsageResetCredit[] {
	return [
		{ id: "soon", status: "available", title: "Soon reset", expiresAt: "2099-01-03T00:00:00.000Z" },
		{ id: "mid", status: "available", title: "Middle reset", expiresAt: "2099-01-07T00:00:00.000Z" },
		{ id: "late", status: "available", title: "Late reset", expiresAt: "2099-01-10T00:00:00.000Z" },
	];
}

function account(credentialId = 1): ResetUsageAccount {
	const inventory = credits();
	const credit = inventory[0]!;
	return {
		label: `fixture-${credentialId}@example.com`,
		provider: "openai-codex",
		providerLabel: "Codex",
		availableCount: 3,
		redeemableCount: 3,
		target: { provider: "openai-codex", credentialId, creditId: credit.id },
		active: credentialId === 1,
		credit,
		expiresAt: credit.expiresAt,
		credits: inventory,
	};
}

function findList(root: NativeNode): Extract<NativeNode, { k: "list" }> {
	const pending = [root];
	while (pending.length) {
		const current = pending.pop()!;
		if (current.k === "list") return current;
		for (const child of current.c ?? []) {
			if ("k" in child) pending.push(child);
		}
	}
	throw new Error("Expected reset account list");
}

/** The destructive confirmation is a warning text node, not the muted credit details. */
function confirmationText(selector: ResetUsageSelectorComponent): string | undefined {
	for (const child of selector.describe().c ?? []) {
		if ("k" in child && child.k === "text" && child.p?.spans?.some(span => span.s === "warning")) {
			return child.p.spans.map(span => span.t).join("");
		}
	}
	return undefined;
}

function nativeHintKeys(selector: ResetUsageSelectorComponent): string[] {
	const hints = selector
		.describe()
		.c?.find(child => "k" in child && child.k === "row" && child.p?.role === "omp.overlay.hints");
	if (!hints || !("k" in hints)) throw new Error("Expected reset selector hints");
	const keys: string[] = [];
	const pending: NativeNode[] = [hints];
	while (pending.length) {
		const current = pending.pop()!;
		if (current.k === "kbd") keys.push(current.p?.keys?.join("+") ?? "");
		for (const child of current.c ?? []) {
			if ("k" in child) pending.push(child);
		}
	}
	return keys;
}

function expectCycleHints(selector: ResetUsageSelectorComponent, visible: boolean): void {
	const keys = nativeHintKeys(selector);
	const terminal = selector.render(240).join("\n");
	for (const key of ["tab", "shift+tab"] as const) {
		if (visible) {
			expect(keys).toContain(key);
			expect(terminal).toContain(formatKeyHint(key));
		} else {
			expect(keys).not.toContain(key);
			expect(terminal).not.toContain(formatKeyHint(key));
		}
	}
}

function fixture(accounts = [account()]) {
	const selected: ResetUsageAccount[] = [];
	let cancelled = false;
	const selector = new ResetUsageSelectorComponent(
		accounts,
		row => selected.push(row),
		() => {
			cancelled = true;
		},
	);
	return { selector, selected, cancelled: () => cancelled };
}

function confirm(selector: ResetUsageSelectorComponent): void {
	selector.handleInput("\r");
	selector.handleInput("\r");
}

describe("saved reset credit selector", () => {
	it("confirms the caller's normalized default metadata and exact pin", () => {
		const input = account();
		const { selector, selected } = fixture([input]);
		expect(findList(selector.describe()).c).toHaveLength(1);
		expect(selector.render(160).join("\n")).toContain("selected 1/3");
		selector.handleInput("\r");
		expect(selected).toEqual([]);
		const confirmation = confirmationText(selector);
		expect(confirmation).toContain("Soon reset");
		expect(confirmation).toContain(new Date(input.credit!.expiresAt!).toLocaleDateString());
		expect(JSON.stringify(selector.describe())).toContain("Soon reset");
		selector.handleInput("\r");
		expect(selected[0]?.target.creditId).toBe("soon");
		expect(selected[0]?.credit?.id).toBe("soon");
		expect(input.target.creditId).toBe("soon");
	});

	it("spends a caller-pinned Codex credit without an inventory after two Enters", () => {
		const input = { ...account(), credits: undefined, availableCount: 7, redeemableCount: 7 };
		const { selector, selected } = fixture([input]);
		expectCycleHints(selector, false);
		selector.handleInput("\r");
		expect(selected).toEqual([]);
		expect(confirmationText(selector)).toContain("Soon reset");
		selector.handleInput("\t");
		selector.handleInput("\x1b[Z");
		expect(confirmationText(selector)).toContain("Soon reset");
		selector.handleInput("\r");
		expect(selected).toHaveLength(1);
		expect(selected[0]).toMatchObject({
			redeemableCount: 7,
			target: { credentialId: 1, creditId: "soon" },
			credit: input.credit,
			expiresAt: input.expiresAt,
		});
	});

	it("honors a caller-selected nondefault credit at the first confirmation", () => {
		const input = account();
		const credit = input.credits![2]!;
		input.target.creditId = credit.id;
		input.credit = credit;
		input.expiresAt = credit.expiresAt;
		const { selector, selected } = fixture([input]);
		expect(selector.render(240).join("\n")).toContain("selected 3/3");
		selector.handleInput("\r");
		expect(selected).toEqual([]);
		expect(confirmationText(selector)).toContain("Late reset");
		expect(confirmationText(selector)).toContain(new Date(credit.expiresAt!).toLocaleDateString());
		selector.handleInput("\r");
		expect(selected[0]).toMatchObject({
			target: { creditId: "late" },
			credit,
			expiresAt: credit.expiresAt,
		});
	});

	it("cycles forwards and backwards in expiry order without moving the account or leaving native state stale", () => {
		const input = account();
		const { selector, selected } = fixture([input, account(2)]);
		const initial = selector.describe();
		const selectedAccount = findList(initial).p?.selected;
		const check = (index: number, title: string) => {
			const native = selector.describe();
			expect(findList(native).p?.selected).toBe(selectedAccount);
			expect(findList(native).c).toHaveLength(2);
			expect(JSON.stringify(native)).toContain(`selected ${index}/3`);
			expect(selector.render(160).join("\n")).toContain(`selected ${index}/3`);
			expect(JSON.stringify(native)).toContain(title);
		};
		selector.handleInput("\t");
		check(2, "Middle reset");
		selector.handleInput("\t");
		check(3, "Late reset");
		selector.handleInput("\t");
		check(1, "Soon reset");
		selector.handleInput("\x1b[Z");
		check(3, "Late reset");
		confirm(selector);
		expect(selected[0]?.target).toMatchObject({ credentialId: 1, creditId: "late" });
		expect(input.target.creditId).toBe("soon");
		expect(input.credit?.id).toBe("soon");
	});

	it("cancels the old destructive confirmation on Tab and requires two fresh Enters for the new exact credit", () => {
		const { selector, selected } = fixture();
		selector.handleInput("\r");
		expect(confirmationText(selector)).toContain("Soon reset");
		selector.handleInput("\t");
		expect(confirmationText(selector)).toBeUndefined();
		selector.handleInput("\r");
		expect(selected).toEqual([]);
		expect(selector.render(160).join("\n")).toContain("Middle reset");
		selector.handleInput("\r");
		expect(selected[0]?.target.creditId).toBe("mid");
		expect(selected[0]?.credit?.id).toBe("mid");
	});

	it("retains each account's credit when navigating and Escape cancels without spending", () => {
		const { selector, selected, cancelled } = fixture([account(), account(2)]);
		selector.handleInput("\t");
		selector.handleInput("\x1b[B");
		selector.handleInput("\t");
		selector.handleInput("\t");
		selector.handleInput("\x1b[A");
		selector.handleInput("\r");
		expect(selector.render(160).join("\n")).toContain("Middle reset");
		expect(confirmationText(selector)).toContain("Middle reset");
		selector.handleInput("\x1b");
		expect(confirmationText(selector)).toBeUndefined();
		selector.handleInput("\x1b");
		expect(cancelled()).toBe(true);
		expect(selected).toEqual([]);
	});

	it("does not cycle Claude's provider-selected grant or cancel its confirmation on Tab", () => {
		const claude = {
			...account(),
			provider: "anthropic",
			providerLabel: "Claude",
			target: { provider: "anthropic", credentialId: 1, creditId: "late" },
			credit: { ...credits()[2]!, program: "juniper_tide" },
		};
		const { selector, selected } = fixture([claude]);
		selector.handleInput("\r");
		selector.handleInput("\t");
		selector.handleInput("\x1b[Z");
		expect(JSON.stringify(selector.describe())).not.toContain("selected 1/3");
		expect(selector.render(160).join("\n")).toContain("5h session limit only");
		selector.handleInput("\r");
		expect(selected[0]?.target.creditId).toBe("late");
	});

	for (const [name, row, visible] of [
		["multiple usable Codex credits", account(), true],
		[
			"one usable Codex credit",
			{ ...account(), availableCount: 1, redeemableCount: 1, credits: credits().slice(0, 1) },
			false,
		],
		["no supplied Codex inventory", { ...account(), credits: undefined }, false],
		["disabled Codex account", { ...account(), redeemableCount: 0 }, false],
		[
			"Claude grant",
			{
				...account(),
				provider: "anthropic",
				providerLabel: "Claude",
				target: { provider: "anthropic", credentialId: 1, creditId: "soon" },
			},
			false,
		],
	] as const) {
		it(`shows cycling shortcuts only when actionable: ${name}`, () => {
			const { selector } = fixture([row]);
			expectCycleHints(selector, visible);
		});
	}

	for (const navigation of ["keyboard", "native"] as const) {
		it(`refreshes cached cycling hints when ${navigation} selection moves between multi-credit, single-credit and Claude rows`, () => {
			const single = { ...account(2), availableCount: 1, redeemableCount: 1, credits: credits().slice(0, 1) };
			const claude = {
				...account(3),
				provider: "anthropic",
				providerLabel: "Claude",
				target: { provider: "anthropic", credentialId: 3, creditId: "soon" },
				credits: undefined,
			};
			const { selector, selected } = fixture([account(), single, claude]);
			// Prime the memo on the multi-credit row before moving to a different hint set.
			expectCycleHints(selector, true);
			const move = (key: string, input: string) => {
				if (navigation === "keyboard") {
					selector.handleInput(input);
				} else {
					selector.handleNativeEvent({ type: "select", key: "list", item: key });
					// Native selection also arms confirmation; cancel it to inspect the current shortcut row.
					expect(selected).toEqual([]);
					selector.handleInput("\x1b");
				}
			};
			move("openai-codex:2", "\x1b[B");
			expectCycleHints(selector, false);
			move("anthropic:3", "\x1b[B");
			expectCycleHints(selector, false);
			move("openai-codex:2", "\x1b[A");
			expectCycleHints(selector, false);
			move("openai-codex:1", "\x1b[A");
			expectCycleHints(selector, true);
			selector.handleInput("\t");
			expectCycleHints(selector, true);
			selector.handleInput("\r");
			expect(confirmationText(selector)).toContain("Middle reset");
			expect(selected).toEqual([]);
		});
	}
});
