import { type JSX, Show } from "solid-js";

import { CONFIG } from "../../config";
import { activeView, setActiveView, type View } from "../../view";
import { ThemeToggle } from "../ThemeToggle";
import { Vitals } from "./Vitals";

// Inline nav glyphs — robomp has no icon library.
function ActivityIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}
function OpsIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="6" rx="1.5" />
      <rect x="2" y="13" width="14" height="8" rx="1.5" />
      <path d="M20 17h2" />
    </svg>
  );
}
function TriageIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m14 4 6 6-10 10H4v-6L14 4Z" />
      <path d="m13 5 6 6" />
    </svg>
  );
}
function LockIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 1 1 8 0v4" />
    </svg>
  );
}

interface NavDef {
  id: View;
  label: string;
  icon: () => JSX.Element;
  locked: boolean;
}

const NAV: NavDef[] = [
  { id: "operations", label: "Operations", icon: OpsIcon, locked: false },
  { id: "activity", label: "Activity", icon: ActivityIcon, locked: false },
  { id: "triage", label: "Triage", icon: TriageIcon, locked: !CONFIG.replayEnabled },
];

export function Rail(): JSX.Element {
  return (
    <aside class="rmp-rail">
      {/* Brand lockup: gradient mark + wordmark + tag */}
      <div class="rmp-rail-brand">
        <span class="rmp-rail-mark" aria-hidden="true" />
        <span class="rmp-rail-wordmark">
          <span class="rmp-rail-name">robomp</span>
          <span class="rmp-rail-tag">triage · fix · ship</span>
        </span>
      </div>

      {/* Always-on vitals: health/sync + running# + failed# + 5 counts + runtime meta */}
      <Vitals />

      {/* Nav: Operations / Activity / Triage */}
      <nav class="rmp-nav">
        {NAV.map((item) => (
          <button
            type="button"
            class="rmp-nav-item"
            data-active={activeView() === item.id ? "true" : "false"}
            data-locked={item.locked ? "true" : "false"}
            aria-current={activeView() === item.id ? "page" : undefined}
            title={item.locked ? "Triage — locked (set ROBOMP_REPLAY_TOKEN to enable)" : item.label}
            onClick={() => setActiveView(item.id)}
          >
            <span class="rmp-nav-item-icon">{item.icon()}</span>
            <span class="rmp-nav-item-label">{item.label}</span>
            <Show when={item.locked}>
              <span class="rmp-nav-item-lock" title="read-only">
                <LockIcon />
              </span>
            </Show>
          </button>
        ))}
      </nav>

      {/* Footer: theme toggle + polling tag */}
      <div class="rmp-rail-footer">
        <ThemeToggle />
        <span class="rmp-rail-footer-tag">polling 3s</span>
      </div>
    </aside>
  );
}
