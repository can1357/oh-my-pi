import { createSignal } from "solid-js";

// Active-view module signal. Mirrors the existing state.ts / theme.ts idiom:
// rail + topbar + views all read/write through one source — no prop-drilling.
// Views stay mounted; Shell toggles visibility so filter state + Browse's
// createResource survive view switches.

export type View = "operations" | "activity" | "triage";

const [activeView, setActiveView] = createSignal<View>("operations");

export { activeView, setActiveView };
