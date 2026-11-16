import { AsyncLocalStorage } from "node:async_hooks";

const requestIdentity = new AsyncLocalStorage<string | undefined>();
const EXTENSION_ID_PREFIX = "ext:v1:sha256:";

/** A bounded, opaque id for one registry-resolved extension source. */
export function extensionRequestIdentity(resolvedPath: string): string {
	return `${EXTENSION_ID_PREFIX}${new Bun.CryptoHasher("sha256").update(resolvedPath).digest("hex")}`;
}

/** Scope a UI request to its trusted registry owner; `undefined` clears an inherited extension scope. */
export function runWithExtensionRequestIdentity<T>(identity: string | undefined, action: () => T): T {
	return requestIdentity.run(identity, action);
}

/** The registry identity for the current asynchronous extension invocation, if any. */
export function currentExtensionRequestIdentity(): string | undefined {
	return requestIdentity.getStore();
}
