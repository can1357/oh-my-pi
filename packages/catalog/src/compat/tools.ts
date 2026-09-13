import { toModelSpec } from "../provider-models/bundled-references";
import type { Model } from "../types";
import { resolveModelPolicy } from "./resolve";

/** Whether the transport exposes native tools that an empty caller catalog cannot disable. */
export function requiresNativeTools(model: Model): boolean {
	return resolveModelPolicy(toModelSpec(model)).catalog.requiresNativeTools === true;
}
