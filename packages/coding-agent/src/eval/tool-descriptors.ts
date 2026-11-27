/**
 * The descriptor each eval-defined custom tool was built from on this thread, which a subagent's spawn spec stores.
 * A leaf module (type imports only), so the worker bridge can read it without importing the eval kernels.
 */
import type { EvalToolDescriptor } from "./types";

const evalToolDescriptors = new WeakMap<object, EvalToolDescriptor>();

export function recordEvalToolDescriptor(tool: object, descriptor: EvalToolDescriptor): void {
	evalToolDescriptors.set(tool, descriptor);
}

export function evalToolDescriptor(tool: object): EvalToolDescriptor | undefined {
	return evalToolDescriptors.get(tool);
}
