import type { JSX } from "solid-js";

import {
  type ThemePreference,
  preference,
  setPreference,
} from "../theme";

// 3-way system → light → dark → system toggle. robomp has no icon library, so
// each preference renders an inline 16px SVG (monitor / sun / moon) styled with
// the existing `.btn.ghost.tiny` chrome.

const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const PREFERENCE_LABEL: Record<ThemePreference, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};

function MonitorIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
  );
}

function SunIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

export function ThemeToggle(): JSX.Element {
  const icon = (): JSX.Element => {
    const p = preference();
    if (p === "light") return <SunIcon />;
    if (p === "dark") return <MoonIcon />;
    return <MonitorIcon />;
  };

  const label = (): string => `${PREFERENCE_LABEL[preference()]} — click to switch`;

  return (
    <button
      type="button"
      class="btn ghost tiny"
      onClick={() => setPreference(NEXT_PREFERENCE[preference()])}
      aria-label={label()}
      title={label()}
    >
      {icon()}
    </button>
  );
}
