import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorsRoute } from "../src/client/routes/ErrorsRoute";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | null = null;

function installGlobal(name: string, value: unknown): void {
	originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

function restoreGlobals(): void {
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) {
			Object.defineProperty(globalThis, name, descriptor);
		} else {
			Reflect.deleteProperty(globalThis, name);
		}
	}
	originalGlobals.clear();
}

afterEach(async () => {
	const activeRoot = root;
	if (activeRoot) {
		await act(async () => {
			activeRoot.unmount();
		});
		root = null;
	}
	vi.restoreAllMocks();
	restoreGlobals();
});

describe("ErrorsRoute range", () => {
	it("requests the selected range again when the range changes", async () => {
		const domWindow = parseHTML('<html><body><div id="root"></div></body></html>').window;
		installGlobal("window", domWindow);
		installGlobal("document", domWindow.document);
		installGlobal("navigator", domWindow.navigator);
		installGlobal("Node", domWindow.Node);
		installGlobal("Element", domWindow.Element);
		installGlobal("HTMLElement", domWindow.HTMLElement);
		installGlobal("HTMLSelectElement", Reflect.get(domWindow, "HTMLSelectElement"));
		installGlobal("HTMLOptionElement", Reflect.get(domWindow, "HTMLOptionElement"));
		installGlobal("HTMLIFrameElement", domWindow.HTMLIFrameElement);
		installGlobal("SVGElement", domWindow.SVGElement);
		installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		const requestedUrls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput, _init?: FetchInit) => {
				requestedUrls.push(input instanceof Request ? input.url : input.toString());
				return Response.json([]);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const container = domWindow.document.getElementById("root");
		if (!container) throw new Error("Expected test root");
		root = createRoot(container as unknown as Element);

		await act(async () => {
			root?.render(<ErrorsRoute active range="24h" refreshTrigger={0} onRequestClick={() => {}} />);
		});
		expect(requestedUrls).toEqual(["/api/v1/errors?range=24h&limit=50"]);

		await act(async () => {
			root?.render(<ErrorsRoute active range="7d" refreshTrigger={0} onRequestClick={() => {}} />);
		});
		expect(requestedUrls).toEqual([
			"/api/v1/errors?range=24h&limit=50",
			"/api/v1/errors?range=7d&limit=50",
		]);
	});
});
