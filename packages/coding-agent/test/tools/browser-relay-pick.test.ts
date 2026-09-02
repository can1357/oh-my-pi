import { describe, expect, it } from "bun:test";
import { pickAndClaimRelayTarget } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/pick";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import type { Browser, Page, Target } from "puppeteer-core";

interface FakeTabOptions {
	id: string;
	url: string;
	title: string;
	claimedBy?: string;
	visible?: boolean;
	type?: string;
	claim?: (owner: string) => Promise<void>;
}

interface FakeTab {
	target: Target;
	sends: Array<{ method: string; params?: { owner: string } }>;
}

function claimConflict(message: string): Error {
	return Object.assign(new Error(message), { code: -32050 });
}

function fakeTab(options: FakeTabOptions): FakeTab {
	const sends: FakeTab["sends"] = [];
	const target = {
		_targetId: options.id,
		type: () => options.type ?? "page",
		url: () => options.url,
		_getTargetInfo: () => ({
			title: options.title,
			url: options.url,
			ompClaimedBy: options.claimedBy,
		}),
		page: async (): Promise<Page | null> => page,
	} as unknown as Target;
	const page = {
		url: () => options.url,
		evaluate: async () => options.visible === true,
		createCDPSession: async () => ({
			send: async (method: string, params?: { owner: string }) => {
				sends.push({ method, params });
				if (method === "OMP.claimTarget" && options.claim) {
					await options.claim(params?.owner ?? "");
				}
			},
			detach: async () => undefined,
		}),
		target: () => target,
	} as unknown as Page;
	return { target, sends };
}

function fakeBrowser(tabs: FakeTab[]): Browser {
	return {
		targets: () => tabs.map(tab => tab.target),
	} as unknown as Browser;
}

describe("pickAndClaimRelayTarget", () => {
	it("skips a claimed matcher hit and claims the first unclaimed match", async () => {
		const claimed = fakeTab({
			id: "PAGE1",
			url: "https://example.com/held",
			title: "Held",
			claimedBy: "omp:1:other",
		});
		const free = fakeTab({
			id: "PAGE2",
			url: "https://example.org/free",
			title: "Free",
		});
		const owner = "omp:2:main";
		const result = await pickAndClaimRelayTarget(fakeBrowser([claimed, free]), {
			matcher: "example",
			owner,
		});

		expect(result.targetId).toBe("PAGE2");
		expect(claimed.sends).toEqual([]);
		expect(free.sends).toEqual([{ method: "OMP.claimTarget", params: { owner } }]);
	});

	it("errors when every matcher hit is already driven", async () => {
		const holder = "omp:99:main";
		const first = fakeTab({
			id: "PAGE1",
			url: "https://example.com/a",
			title: "A",
			claimedBy: holder,
		});
		const second = fakeTab({
			id: "PAGE2",
			url: "https://example.com/b",
			title: "B",
			claimedBy: holder,
		});

		try {
			await pickAndClaimRelayTarget(fakeBrowser([first, second]), {
				matcher: "example.com",
				owner: "omp:2:probe",
			});
			expect.unreachable("should have thrown");
		} catch (error) {
			if (!(error instanceof ToolError)) throw error;
			expect(error.message).toContain("already driven by another omp session");
			expect(error.message).toContain(holder);
			expect(error.message).toContain("Pass a different target, or omit target and pass url to open your own tab.");
		}
		expect(first.sends).toEqual([]);
		expect(second.sends).toEqual([]);
	});

	it("errors when the visible tab is already driven and does not fall through", async () => {
		const holder = "omp:7:main";
		const visible = fakeTab({
			id: "PAGE1",
			url: "https://visible.example/",
			title: "Visible",
			claimedBy: holder,
			visible: true,
		});
		const hiddenFree = fakeTab({
			id: "PAGE2",
			url: "https://hidden.example/",
			title: "Hidden",
			visible: false,
		});

		try {
			await pickAndClaimRelayTarget(fakeBrowser([visible, hiddenFree]), { owner: "omp:8:probe" });
			expect.unreachable("should have thrown");
		} catch (error) {
			if (!(error instanceof ToolError)) throw error;
			expect(error.message).toContain("The visible tab (Visible https://visible.example/)");
			expect(error.message).toContain(holder);
		}
		expect(visible.sends).toEqual([]);
		expect(hiddenFree.sends).toEqual([]);
	});

	it("errors when no usable page targets exist", async () => {
		const devtools = fakeTab({
			id: "PAGE1",
			url: "devtools://devtools/bundled/inspector.html",
			title: "DevTools",
		});

		try {
			await pickAndClaimRelayTarget(fakeBrowser([devtools]), { owner: "omp:9:probe" });
			expect.unreachable("should have thrown");
		} catch (error) {
			if (!(error instanceof ToolError)) throw error;
			expect(error.message).toBe(
				"No free tab to adopt on the relay: no usable page targets. Pass url to open your own tab.",
			);
		}
		expect(devtools.sends).toEqual([]);
	});

	it("adopts the visible unclaimed tab when no matcher is given", async () => {
		const hidden = fakeTab({
			id: "PAGE1",
			url: "https://hidden.example/",
			title: "Hidden",
			visible: false,
		});
		const visible = fakeTab({
			id: "PAGE2",
			url: "https://visible.example/",
			title: "Visible",
			visible: true,
		});
		const owner = "omp:3:main";
		const result = await pickAndClaimRelayTarget(fakeBrowser([hidden, visible]), { owner });

		expect(result.targetId).toBe("PAGE2");
		expect(hidden.sends).toEqual([]);
		expect(visible.sends).toEqual([{ method: "OMP.claimTarget", params: { owner } }]);
	});

	it("retries the next candidate after a first-claim conflict", async () => {
		let attempts = 0;
		const first = fakeTab({
			id: "PAGE1",
			url: "https://example.com/one",
			title: "One",
			claim: async () => {
				attempts += 1;
				throw claimConflict("Tab 1 (https://example.com/one) is already driven by omp session omp:1:other");
			},
		});
		const second = fakeTab({
			id: "PAGE2",
			url: "https://example.com/two",
			title: "Two",
		});
		const owner = "omp:4:main";
		const result = await pickAndClaimRelayTarget(fakeBrowser([first, second]), {
			matcher: "example.com",
			owner,
		});

		expect(result.targetId).toBe("PAGE2");
		expect(attempts).toBe(1);
		expect(first.sends).toEqual([{ method: "OMP.claimTarget", params: { owner } }]);
		expect(second.sends).toEqual([{ method: "OMP.claimTarget", params: { owner } }]);
	});

	it("retries the next free tab when the visible tab races a claim conflict", async () => {
		const visible = fakeTab({
			id: "PAGE1",
			url: "https://visible.example/",
			title: "Visible",
			visible: true,
			claim: async () => {
				throw claimConflict("Tab PAGE1 is already driven by omp session omp:1:other");
			},
		});
		const hidden = fakeTab({
			id: "PAGE2",
			url: "https://hidden.example/",
			title: "Hidden",
			visible: false,
		});
		const owner = "omp:6:main";
		const result = await pickAndClaimRelayTarget(fakeBrowser([visible, hidden]), { owner });

		expect(result.targetId).toBe("PAGE2");
		expect(visible.sends).toEqual([{ method: "OMP.claimTarget", params: { owner } }]);
		expect(hidden.sends).toEqual([{ method: "OMP.claimTarget", params: { owner } }]);
	});

	it("surfaces ToolError after three claim conflicts", async () => {
		const first = fakeTab({
			id: "PAGE1",
			url: "https://example.com/one",
			title: "One",
			claim: async () => {
				throw claimConflict("Tab PAGE1 is already driven by omp session omp:1:other");
			},
		});
		const second = fakeTab({
			id: "PAGE2",
			url: "https://example.com/two",
			title: "Two",
			claim: async () => {
				throw claimConflict("Tab PAGE2 is already driven by omp session omp:1:other");
			},
		});
		const third = fakeTab({
			id: "PAGE3",
			url: "https://example.com/three",
			title: "Three",
			claim: async () => {
				throw claimConflict("Tab PAGE3 is already driven by omp session omp:1:other");
			},
		});

		try {
			await pickAndClaimRelayTarget(fakeBrowser([first, second, third]), {
				matcher: "example.com",
				owner: "omp:5:main",
			});
			expect.unreachable("should have thrown");
		} catch (error) {
			if (!(error instanceof ToolError)) throw error;
			expect(error.message).toBe("Tab PAGE3 is already driven by omp session omp:1:other");
		}
		expect(first.sends).toHaveLength(1);
		expect(second.sends).toHaveLength(1);
		expect(third.sends).toHaveLength(1);
	});
});
