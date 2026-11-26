/**
 * Whether a link whose scheme an extension registered (`pi.registerLinkScheme`) can be picked
 * now to raise `link_activate`. The interactive mode installs the answer (schemes registered, a
 * plain terminal, a bound hint key or mouse clicks); without it nothing in this process can pick
 * a link. Process-wide, so a UI-less extension runner (a subagent's, whose transcript the user may
 * focus) answers like the interactive one.
 */
let provider: (() => boolean) | undefined;

/** Install (or with `undefined`, remove) the interactive mode's answer. */
export function setExtensionLinkClicksProvider(next: (() => boolean) | undefined): void {
	provider = next;
}

/** See the module docs. */
export function extensionLinkClicksAvailable(): boolean {
	return provider?.() === true;
}
