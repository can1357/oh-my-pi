/**
 * The progress protocol, as a type.
 *
 * "Exactly one progress protocol per tool call" is the phase-1 invariant that
 * stops direct events and a cumulative legacy snapshot from both delivering the
 * same output. It is expressed as a discriminated union rather than two optional
 * callbacks, so reaching either channel requires narrowing `kind`.
 *
 * The dispatcher constructs exactly one of these per call and hands it to the
 * tool. On the legacy arm, `update` is the *same function object* the tool also
 * receives as its `onUpdate` parameter — one callback surfaced two ways, not two
 * channels. On the presentation arm no legacy callback is passed at all.
 *
 * `TSnapshot` is generic so this contract does not have to import the (much
 * larger) result types; the agent loop instantiates it.
 */

import type { ToolPresentationProducer } from "./producer";

/** Discriminant of {@link ToolProgressProtocol}. */
export type ToolProgressProtocolKind = "legacy_snapshot" | "presentation_events";

/** The progress channel selected for one tool call. */
export type ToolProgressProtocol<TSnapshot> =
	| { readonly kind: "legacy_snapshot"; readonly update: (partialResult: TSnapshot) => void }
	| { readonly kind: "presentation_events"; readonly presentation: ToolPresentationProducer };

/** The presentation arm, for signatures that only accept a migrated route. */
export type PresentationProgress<TSnapshot> = Extract<ToolProgressProtocol<TSnapshot>, { kind: "presentation_events" }>;

/** The producer handle when this call is on the presentation protocol, else `undefined`. */
export function presentationProducerOf<TSnapshot>(
	protocol: ToolProgressProtocol<TSnapshot> | undefined,
): ToolPresentationProducer | undefined {
	return protocol !== undefined && protocol.kind === "presentation_events" ? protocol.presentation : undefined;
}
