import { untilAborted } from "@oh-my-pi/pi-utils";
import type { Page } from "puppeteer-core";
import { requireReactHookResult } from "./devtools-hook";

/** Options controlling React Suspense boundary filtering. */
export interface ReactSuspenseOptions {
	onlyDynamic?: boolean;
}

/** Current and historical state for one React Suspense boundary. */
export interface ReactSuspenseBoundary {
	id: number;
	name?: string;
	state: "pending" | "resolved";
	fallback?: unknown;
	classification: "static" | "dynamic";
}

interface ReactSuspenseEnvelope {
	missingHook?: boolean;
	value?: ReactSuspenseBoundary[];
}

const SUSPENSE_SOURCE_PREFIX = `(() => {
	const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
	if (!hook || !hook.__ompReact) return { missingHook: true };
	const internals = hook.__ompReact;
	const onlyDynamic = `;

const SUSPENSE_SOURCE_SUFFIX = `;
	const fallbackSummary = value => {
		if (value == null || typeof value === "boolean" || typeof value === "number") return value;
		if (typeof value === "string") return value.length > 160 ? value.slice(0, 157) + "..." : value;
		if (Array.isArray(value)) return "[Array(" + value.length + ")]";
		if (typeof value === "object" && value.type) {
			const type = value.type;
			if (typeof type === "string") return "<" + type + ">";
			if (typeof type === "function") return "<" + (type.displayName || type.name || "Anonymous") + ">";
			if (type && typeof type === "object") {
				const inner = type.type || type.render;
				return "<" + (type.displayName || (inner && (inner.displayName || inner.name)) || "Component") + ">";
			}
		}
		return "[Object]";
	};
	const value = [];
	for (const rendererRoots of internals.roots.values()) {
		for (const root of rendererRoots) {
			const stack = root && root.current ? [root.current] : [];
			while (stack.length > 0) {
				const fiber = stack.pop();
				if (fiber.tag === 13) {
					const id = internals.getFiberId(fiber);
					const dynamic = internals.dynamicSuspenseIds.has(id);
					if (!onlyDynamic || dynamic) {
						const boundary = {
							id,
							state: fiber.memoizedState == null ? "resolved" : "pending",
							classification: dynamic ? "dynamic" : "static",
						};
						const ownerName = internals.fiberName(fiber._debugOwner);
						if (ownerName) boundary.name = ownerName;
						if (fiber.memoizedProps && "fallback" in fiber.memoizedProps) {
							boundary.fallback = fallbackSummary(fiber.memoizedProps.fallback);
						}
						value.push(boundary);
					}
				}
				if (fiber.sibling) stack.push(fiber.sibling);
				if (fiber.child) stack.push(fiber.child);
			}
		}
	}
	return { value };
})()`;

/** List mounted React Suspense boundaries and whether each has ever suspended. */
export async function readReactSuspense(
	page: Page,
	options: ReactSuspenseOptions = {},
	signal?: AbortSignal,
): Promise<ReactSuspenseBoundary[]> {
	const source = `${SUSPENSE_SOURCE_PREFIX}${JSON.stringify(options.onlyDynamic === true)}${SUSPENSE_SOURCE_SUFFIX}`;
	const result = (await untilAborted(signal, () =>
		page.mainFrame().mainRealm().evaluate(source),
	)) as ReactSuspenseEnvelope;
	return requireReactHookResult(result);
}
