import { expect, test, vi } from "bun:test";
import { connectRelay } from "../extension/worker/relay";
import { type FakePort, installChromeStub } from "./relay-link-fixture";

test("a silent native host is disconnected and a new host receives the link request", () => {
	const chromeBefore = Object.getOwnPropertyDescriptor(globalThis, "chrome");
	const ports: FakePort[] = [];
	vi.useFakeTimers();
	try {
		installChromeStub(ports);
		connectRelay();
		vi.advanceTimersByTime(16_001);
		expect(ports[0]?.disconnected).toBe(true);
		expect(ports[1]?.sent).toEqual([{ t: "link", extensionId: "test-extension" }]);
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
		if (chromeBefore) Object.defineProperty(globalThis, "chrome", chromeBefore);
		else Reflect.deleteProperty(globalThis, "chrome");
	}
});
