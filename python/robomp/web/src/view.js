import { createSignal } from "solid-js";
const [activeView, setActiveView] = createSignal("operations");
export { activeView, setActiveView };
