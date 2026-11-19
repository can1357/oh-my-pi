import { type JSX, onCleanup, onMount } from "solid-js";

import { Shell } from "./components/shell/Shell";
import { startPolling, stopPolling } from "./state";

// Thin root. Mounts the shell and keeps the polling lifecycle at the
// always-mounted root (load-bearing: views are pure readers — if
// startPolling/stopPolling moved into a view, switching away would stop the
// shared 3s poll). handleRetry now lives inside each view that owns retry
// buttons (Operations/Activity), reading the shared runTrigger passthrough.
export function App(): JSX.Element {
  onMount(() => {
    startPolling();
  });
  onCleanup(() => {
    stopPolling();
  });

  return <Shell />;
}
