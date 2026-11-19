import { untilAborted } from "@oh-my-pi/pi-utils";
import type { Page } from "puppeteer-core";
import { type ReactPageEnvelope, requireReactHookResult } from "./devtools-hook";

/** Render-recording lifecycle action. */
export type ReactRendersAction = "start" | "stop" | "status";

/** Aggregate render cost for one React component display name. */
export interface ReactRenderComponent {
	name: string;
	renders: number;
	totalMs: number;
}

/** React commit and component render counts collected by the hook. */
export interface ReactRendersResult {
	active?: boolean;
	commits: number;
	components: ReactRenderComponent[];
}

const RENDERS_SOURCE_PREFIX = `(() => {
	const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
	if (!hook || !hook.__ompReact) return { missingHook: true };
	const recording = hook.__ompReact.recording;
	const action = `;

const RENDERS_SOURCE_SUFFIX = `;
	if (action === "start") {
		recording.commits = 0;
		recording.components.clear();
		recording.active = true;
	}
	const components = Array.from(recording.components.values())
		.map(component => ({
			name: component.name,
			renders: component.renders,
			totalMs: Math.round(component.totalMs * 100) / 100,
		}))
		.sort((left, right) => right.totalMs - left.totalMs || right.renders - left.renders || left.name.localeCompare(right.name));
	const value = { commits: recording.commits, components };
	if (action === "status") value.active = recording.active === true;
	if (action === "stop") recording.active = false;
	return { value };
})()`;

/** Page expression applying `action` to commit recording; evaluates to a `ReactPageEnvelope<ReactRendersResult>`. */
export function reactRendersSource(action: ReactRendersAction): string {
	return `${RENDERS_SOURCE_PREFIX}${JSON.stringify(action)}${RENDERS_SOURCE_SUFFIX}`;
}

/** Start, stop, or inspect React commit recording for the current document. */
export async function collectReactRenders(
	page: Page,
	options: { action: ReactRendersAction },
	signal?: AbortSignal,
): Promise<ReactRendersResult> {
	const source = reactRendersSource(options.action);
	const result = (await untilAborted(signal, () =>
		page.mainFrame().mainRealm().evaluate(source),
	)) as ReactPageEnvelope<ReactRendersResult>;
	return requireReactHookResult(result);
}
