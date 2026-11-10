/**
 * Worker half of the worker-silence case in `../stale-addon-export.test.ts`.
 *
 * Calls the real `reportStaleWorkspaceAddon` from inside a real worker thread,
 * with its own write sink and latch so the answer comes from the thread guard
 * and nothing else, and reports what the call did. Also constructs a missing
 * class, because silencing the notice must not silence the per-symbol
 * diagnostic a worker still needs.
 */
import { parentPort } from "node:worker_threads";
import type { NativeAddonStatus } from "../../native/loader-state.js";
import { missingNativeClass, reportStaleWorkspaceAddon } from "../../native/loader-state.js";

const addon: NativeAddonStatus = {
	path: "/w/packages/natives/native/pi_natives.linux-x64-modern.node",
	version: "18.1.18",
	packageVersion: "18.2.6",
	stale: true,
};

const written: string[] = [];
const wrote = reportStaleWorkspaceAddon({ isWorkspaceLoad: true }, addon, {
	write: text => written.push(text),
	state: { reported: false },
});

const Stub = missingNativeClass("RunTrace", addon);
let symbolDiagnostic = "";
try {
	new Stub!("echo hi");
} catch (error) {
	symbolDiagnostic = error instanceof Error ? error.message : String(error);
}

parentPort?.postMessage({ wrote, writes: written.length, symbolDiagnostic });
