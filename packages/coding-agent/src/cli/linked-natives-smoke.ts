import { parentPort, Worker } from "node:worker_threads";
import type * as Natives from "@oh-my-pi/pi-natives";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { LINKED_NATIVE_WORKER_ARG } from "./worker-selectors";

function checkBinding(): void {
	if (!Bun.isStandaloneExecutable) throw new Error("Linked native smoke requires a standalone executable");
	if (
		Bun.embeddedFiles.some(
			file => "name" in file && typeof file.name === "string" && /pi_natives\..*\.node\b/.test(file.name),
		)
	) {
		throw new Error("The executable still carries a separate pi-natives addon");
	}
	// A successful Rust call must not depend on a sidecar, even when the machine running the probe has one.
	const dlopen = process.dlopen;
	const self = process.platform === "linux" ? "/proc/self/exe" : process.execPath;
	process.dlopen = (module, filename, flags) => {
		if (filename !== self) throw new Error(`Linked native smoke attempted to load an addon from ${filename}`);
		return dlopen(module, filename, flags);
	};
	try {
		const native: typeof Natives = require("@oh-my-pi/pi-natives");
		if (native.visibleWidth("a界", 4) !== 3) throw new Error("Linked native visibleWidth returned the wrong width");
	} finally {
		process.dlopen = dlopen;
	}
}

/** Run the Rust call on the worker thread before letting its N-API environment tear down. */
export function runLinkedNativeWorker(): void {
	if (!parentPort) throw new Error("Linked binding worker has no parent port");
	checkBinding();
	parentPort.postMessage("ok");
	parentPort.close();
}

/** Prove that both VM-local export tables are backed by the executable, not an extracted addon. */
export async function smokeLinkedNatives(): Promise<void> {
	checkBinding();
	const entry = workerHostEntry();
	if (!entry) throw new Error("Linked native smoke requires the standalone CLI entrypoint");
	const worker = new Worker(entry, { argv: [LINKED_NATIVE_WORKER_ARG] });
	const done = Promise.withResolvers<void>();
	let replied = false;
	worker.once("message", (message: unknown) => {
		replied = message === "ok";
	});
	worker.once("error", done.reject);
	worker.once("exit", code => {
		if (code === 0 && replied) done.resolve();
		else done.reject(new Error(`Linked native worker exited ${code}; call completed: ${replied}`));
	});
	const timeout = setTimeout(
		() => done.reject(new Error("Timed out waiting for linked native worker teardown")),
		30_000,
	);
	try {
		await done.promise;
	} finally {
		clearTimeout(timeout);
		if (worker.threadId !== -1) await worker.terminate();
	}
}
