/**
 * Memory Fabric — session integration barrel.
 *
 * The lifecycle seam: event vocabulary, an in-process bus, a deadline guard, a
 * context renderer, the no-op participant, the guardian participant that
 * translates lifecycle events into guardian ones, the observe participant that
 * measures context hygiene without ever altering context, the resolver that
 * decides which of them a session gets, the composite that fans a single
 * lifecycle out to several participants, the bridge that drives all of it from
 * a session, and the flag-gated activation that assembles the whole stack.
 *
 * Like `context-hygiene/`, this is deliberately NOT re-exported from
 * `memory-fabric/index.ts`. Nothing here subscribes itself or installs itself
 * into a session; a caller must construct a bus and register participants
 * explicitly — or call `activateMemoryFabric`, which returns `null` unless the
 * flag is on — so the layer stays off the hot path until it is adopted on
 * purpose.
 */

export * from "./activation";
export * from "./bridge";
export * from "./composite-participant";
export * from "./context-injection";
export * from "./create-participant";
export * from "./deadline";
export * from "./event-bus";
export * from "./guardian-participant";
export * from "./noop-participant";
export * from "./observe-participant";
export * from "./types";
