export * from "./catalog";
export * from "./coercion";
export * from "./demotion";
export * from "./examples";
export * from "./factory";
export * from "./history";
export * from "./inventory";
export * from "./owned-stream";
// `./rendering` is a dialect-internal primitives module deliberately excluded
// from the barrel. `renderDelimitedThinking` is the one helper an external
// consumer needs (the legacy markdown `/dump` reuses its `<thinking>` envelope
// unwrap), so re-export only that symbol rather than `export *`-ing the rest.
export { renderDelimitedThinking } from "./rendering";
export * from "./thinking";
export * from "./types";
