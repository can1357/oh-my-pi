import { beforeAll, describe, expect, it } from "bun:test";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { type LogoutAccount, LogoutAccountSelectorComponent } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const DOWN = "\x1b[B";
const genericCx: DescribeContext = {
	cols: 100,
	reduceMotion: false,
	dark: true,
	supports: kind => kind !== "picker",
	feature: () => true,
};
const pickerCx: DescribeContext = {
	cols: 100,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const ENTER = "\n";

const ACCOUNTS: LogoutAccount[] = [
	{ credentialId: 1, provider: "anthropic", label: "work", detail: "oauth", type: "oauth", active: true },
	{ credentialId: 2, provider: "anthropic", label: "personal", detail: "api key", type: "api_key", active: false },
	{ credentialId: 3, provider: "anthropic", label: "ci", detail: "api key", type: "api_key", active: false },
];

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child && typeof child.k === "string";
}

function findList(root: NativeNode): NativeNode {
	const stack: NativeNode[] = [root];
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current.k === "list") return current;
		for (const child of current.c ?? []) if (isNode(child)) stack.push(child);
	}
	throw new Error("no list node described");
}

function selector(picked: LogoutAccount[]): LogoutAccountSelectorComponent {
	return new LogoutAccountSelectorComponent(
		"Anthropic",
		ACCOUNTS,
		account => picked.push(account),
		() => {},
	);
}

describe("selector overlay driven natively", () => {
	beforeAll(async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("Failed to load dark theme");
		setThemeInstance(dark);
	});

	it("a select event on an item picks the same account as arrowing to it and pressing Enter", () => {
		const viaKeys: LogoutAccount[] = [];
		const keyed = selector(viaKeys);
		keyed.handleInput(DOWN);
		keyed.handleInput(DOWN);
		keyed.handleInput(ENTER);

		const viaPointer: LogoutAccount[] = [];
		const native = selector(viaPointer);
		const list = findList(native.describe(genericCx));
		const target = list.c?.[2];
		expect(target !== undefined && isNode(target) ? target.key : undefined).toBe("3");
		native.handleNativeEvent({ type: "select", key: list.key ?? "", item: "3" });

		expect(viaKeys.map(account => account.credentialId)).toEqual([3]);
		expect(viaPointer).toEqual(viaKeys);
	});

	it("keeps its description while nothing changes and moves the selection with the arrow keys", () => {
		const component = selector([]);
		const first = component.describe(genericCx);
		expect(component.describe(genericCx)).toBe(first);
		expect(findList(first).p).toMatchObject({ selected: "1" });

		component.handleInput(DOWN);
		const moved = component.describe(genericCx);
		expect(moved).not.toBe(first);
		expect(findList(moved).p).toMatchObject({ selected: "2" });
	});

	it("as a picker, a row click moves the selection and a second click signs that account out", () => {
		const picked: LogoutAccount[] = [];
		const component = selector(picked);
		const sheet = component.describe(pickerCx).c?.[0] as NativeNode;
		expect(sheet.k).toBe("picker");
		expect(sheet.p).toMatchObject({ selected: "1", current: ["1"], size: "md" });
		component.handleNativeEvent({ type: "select", key: "^picker", item: "3" });
		expect(picked).toEqual([]);
		expect(component.describe(pickerCx).c?.[0]).toMatchObject({ p: { selected: "3" } });
		component.handleNativeEvent({ type: "activate", key: "^picker", item: "3" });
		expect(picked.map(account => account.credentialId)).toEqual([3]);
	});
});
