# Browser Relay

The browser relay is on: `browser.open` without `app` drives the user's own Chrome, signed in as them. {{#if cdpUrl}}Pass `app: { relay: false }` to open in the browser at `browser.cdpUrl` ({{cdpUrl}}) instead.{{else if tern}}Pass `app: { relay: false }` for omp's own Tern picture-in-picture instead.{{else if cmux}}Pass `app: { relay: false }` for omp's own cmux browser surface instead.{{else}}Pass `app: { relay: false }` for a throwaway managed browser.{{/if}}
