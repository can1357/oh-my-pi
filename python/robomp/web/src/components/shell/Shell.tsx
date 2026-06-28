import { createEffect, createSignal, type JSX, Show } from "solid-js";

import { activeView } from "../../view";
import { Activity } from "../views/Activity";
import { Operations } from "../views/Operations";
import { Triage } from "../views/Triage";
import { Rail } from "./Rail";
import { TopBar } from "./TopBar";

export function Shell(): JSX.Element {
  const [drawerOpen, setDrawerOpen] = createSignal(false);

  // Close the mobile drawer whenever the active view changes (nav tap).
  createEffect(() => {
    activeView();
    setDrawerOpen(false);
  });

  const viewDisplay = (v: string): string => (activeView() === v ? "" : "none");

  return (
    <div class="rmp-app">
      {/* Desktop rail (hidden <1024px) */}
      <div class="rmp-desktop-nav">
        <Rail />
      </div>

      {/* Mobile drawer */}
      <Show when={drawerOpen()}>
        <div
          class="rmp-mobile-drawer-overlay"
          onClick={() => setDrawerOpen(false)}
          role="presentation"
        >
          <div
            class="rmp-mobile-drawer"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
          >
            <Rail />
          </div>
        </div>
      </Show>

      {/* Main pane */}
      <div class="rmp-main">
        <TopBar onMenuToggle={() => setDrawerOpen(true)} />
        <main class="rmp-content scrollable">
          <div class="rmp-content-inner">
            {/* All 3 views stay mounted; visibility toggled by activeView so
                view-local UI state (Logs/Browse filters) persists and Browse
                does not refetch on view switches. The enter animation
                (rmp-view-enter) restarts automatically when a view flips
                none→flex, firing on first paint + view-switch ONLY, never on
                the 3s data poll (polls never change display). */}
            <div class="rmp-view rmp-view-enter" style={{ display: viewDisplay("operations") }}>
              <Operations />
            </div>
            <div class="rmp-view rmp-view-enter" style={{ display: viewDisplay("activity") }}>
              <Activity />
            </div>
            <div class="rmp-view rmp-view-enter" style={{ display: viewDisplay("triage") }}>
              <Triage />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
