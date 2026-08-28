import { Show } from "solid-js";
import { CONFIG } from "../../config";
import { activeView } from "../../view";
const TITLES = {
    operations: "Operations",
    activity: "Activity",
    triage: "Triage",
};
function MenuIcon() {
    return (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 6h18M3 12h18M3 18h18"/>
    </svg>);
}
export function TopBar(props) {
    return (<header class="rmp-topbar">
      <div class="rmp-topbar-left">
        <button type="button" class="rmp-mobile-menu-btn" aria-label="Open navigation menu" onClick={() => props.onMenuToggle()}>
          <MenuIcon />
        </button>
        <h1 class="rmp-page-title">{TITLES[activeView()]}</h1>
      </div>

      <div class="rmp-topbar-right">
        {/* View-contextual slot. Operations → read-only/replay chip. Sync + vitals live in the rail. */}
        <Show when={activeView() === "operations"}>
          <Show when={CONFIG.replayEnabled} fallback={<span class="rmp-readonly-chip">read-only · replay off</span>}>
            <span class="rmp-readonly-chip">replay on</span>
          </Show>
        </Show>
      </div>
    </header>);
}
