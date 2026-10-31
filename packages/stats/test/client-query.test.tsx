import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getSessionTrace } from "../src/client/api";
import { type QueryResult, useQuery } from "../src/client/data/query";
import { inflightRequest, loadQuery, releaseQuery } from "../src/client/data/query-store";
import type { SessionTrace } from "../src/client/types";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | null = null;
let keySeq = 0;

function installGlobal(name: string, value: unknown): void {
	originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

function mount(): Root {
	const domWindow = parseHTML('<html><body><div id="root"></div></body></html>').window;
	installGlobal("window", domWindow);
	installGlobal("document", domWindow.document);
	installGlobal("navigator", domWindow.navigator);
	installGlobal("Node", domWindow.Node);
	installGlobal("Element", domWindow.Element);
	installGlobal("HTMLElement", domWindow.HTMLElement);
	installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = domWindow.document.getElementById("root");
	if (!container) throw new Error("Expected test root");
	root = createRoot(container as unknown as Element);
	return root;
}

/** A unique key per test: the query cache is module-global. */
function freshKey(): string {
	keySeq++;
	return `query-test-${keySeq}`;
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
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals.clear();
});

describe("query store shared requests", () => {
	it("aborts a shared request only when its last waiter leaves", () => {
		const key = JSON.stringify([freshKey()]);
		const signals: AbortSignal[] = [];
		const fetcher = ({ signal }: { signal: AbortSignal }) => {
			signals.push(signal);
			return Promise.withResolvers<number>().promise;
		};
		const first = loadQuery(key, 1, fetcher);
		const second = loadQuery(key, 1, fetcher);
		expect(second).toBe(first);
		expect(signals).toHaveLength(1);

		releaseQuery(key, first);
		expect(signals[0].aborted).toBe(false);
		expect(inflightRequest(key)).toBe(first);

		releaseQuery(key, second);
		expect(signals[0].aborted).toBe(true);
		expect(inflightRequest(key)).toBeUndefined();
	});
});

interface ProbeProps {
	queryKey: string;
	enabled: boolean;
	fetcher: (context: { signal: AbortSignal }) => Promise<number>;
}

function Probe({ queryKey, enabled, fetcher }: ProbeProps) {
	useQuery([queryKey], fetcher, { enabled });
	return null;
}

describe("useQuery request release", () => {
	it("aborts the in-flight request when the query is disabled", async () => {
		const signals: AbortSignal[] = [];
		const fetcher = ({ signal }: { signal: AbortSignal }) => {
			signals.push(signal);
			return Promise.withResolvers<number>().promise;
		};
		const key = freshKey();
		const view = mount();
		await act(async () => view.render(<Probe queryKey={key} enabled fetcher={fetcher} />));
		expect(signals).toHaveLength(1);
		expect(signals[0].aborted).toBe(false);

		await act(async () => view.render(<Probe queryKey={key} enabled={false} fetcher={fetcher} />));
		expect(signals[0].aborted).toBe(true);
	});

	it("keeps a shared request alive until the last consumer is disabled", async () => {
		const signals: AbortSignal[] = [];
		const fetcher = ({ signal }: { signal: AbortSignal }) => {
			signals.push(signal);
			return Promise.withResolvers<number>().promise;
		};
		const key = freshKey();
		const view = mount();
		const render = (a: boolean, b: boolean) =>
			act(async () =>
				view.render(
					<>
						<Probe queryKey={key} enabled={a} fetcher={fetcher} />
						<Probe queryKey={key} enabled={b} fetcher={fetcher} />
					</>,
				),
			);
		await render(true, true);
		expect(signals).toHaveLength(1);

		await render(false, true);
		expect(signals[0].aborted).toBe(false);

		await render(false, false);
		expect(signals[0].aborted).toBe(true);
	});

	it("aborts the old key's request when the key changes to a cached one", async () => {
		const signals: AbortSignal[] = [];
		const cachedKey = freshKey();
		const pendingKey = freshKey();
		const fetcher = ({ signal }: { signal: AbortSignal }) => {
			signals.push(signal);
			return signals.length === 1 ? Promise.resolve(1) : Promise.withResolvers<number>().promise;
		};
		const view = mount();
		await act(async () => view.render(<Probe queryKey={cachedKey} enabled fetcher={fetcher} />));
		await act(async () => view.render(<Probe queryKey={pendingKey} enabled fetcher={fetcher} />));
		expect(signals).toHaveLength(2);
		expect(signals[1].aborted).toBe(false);

		// Cached and current: switching back fetches nothing, but must still leave the pending request.
		await act(async () => view.render(<Probe queryKey={cachedKey} enabled fetcher={fetcher} />));
		expect(signals).toHaveLength(2);
		expect(signals[1].aborted).toBe(true);
	});
});

describe("trace revalidation", () => {
	it("reuses the previous trace object on 304 without parsing a body", async () => {
		const trace = { file: "/s.jsonl", tracks: [] };
		const ifNoneMatch: (string | null)[] = [];
		const jsonSpy = vi.spyOn(Response.prototype, "json");
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				const tag = new Headers(init?.headers).get("If-None-Match");
				ifNoneMatch.push(tag);
				if (tag === '"v1"') return new Response(null, { status: 304 });
				return Response.json(trace, { headers: { ETag: '"v1"' } });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const results: QueryResult<SessionTrace>[] = [];
		function TraceProbe({ file }: { file: string }) {
			results.push(
				useQuery<SessionTrace>(
					["trace", file],
					({ signal }, previous) => getSessionTrace(file, signal, previous),
					{},
				),
			);
			return null;
		}
		const file = freshKey();
		const view = mount();
		await act(async () => view.render(<TraceProbe file={file} />));
		const first = results.at(-1)?.data;
		expect(first).not.toBeNull();
		expect(jsonSpy).toHaveBeenCalledTimes(1);

		await act(async () => results.at(-1)?.refetch());
		expect(ifNoneMatch).toEqual([null, '"v1"']);
		expect(jsonSpy).toHaveBeenCalledTimes(1);
		expect(results.at(-1)?.data).toBe(first);
	});
});
