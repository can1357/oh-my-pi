# Fork Surface Boundaries

These boundaries keep the fork's built-in collaboration feature, extension-owned remote gateway, public identity, and hosting surfaces distinct.

| Boundary | Rule |
|---|---|
| **1. Command namespace** | Built-in reserved names must not claim short generic verbs that extensions own. `/collab` is the primary sharing command; `/remote-control` is a compatibility alias; `/remote` belongs to the pk-speak extension. |
| **2. Product identity** | Fork-owned user-facing outbound identifiers use `oh-my-pk` through `APP_NAME` from `@pk-nerdsaver-ai/pi-utils`, not `Oh-My-Pi` or `omp.sh`. Upstream issue and pull-request links remain as factual attribution. |
| **3. Hosting domains** | `oh-my-pk.pkking.computer` hosts the CLI/install landing and may host a future remote client; `collab.pkking.computer` hosts the collab relay and web client; `pkking.computer` is the apex landing. |
| **4. Surface capability** | `/collab` provides ephemeral end-to-end encrypted session sharing for browser and TUI guests. `/remote` provides the pk-speak extension's persistent paired operator gateway for voice, routing, sessions, workspace access, and approvals. |

## Command ownership

- `/collab`: built-in primary command for ephemeral encrypted session sharing.
- `/remote-control`: built-in compatibility command for the same collab transport.
- `/remote`: pk-speak extension command for its persistent operator gateway.
- `/join`: built-in command for joining a collab session as a guest.
- `/leave`: built-in command for leaving a collab session or stopping a hosted share.

## Domain map

- `oh-my-pk.pkking.computer`: CLI/install landing and possible future hosted remote client.
- `collab.pkking.computer`: collab relay and zero-install web client.
- `pkking.computer`: apex landing.

## Why these boundaries exist

**Command namespace:** Generic extension verbs must remain available so built-ins cannot silently shadow an installed extension. The explicit `/remote-control` name also tells users they are starting collab sharing rather than the persistent gateway.

**Product identity:** Consistent outbound names and links make it clear which product is making a request and prevent fork-owned traffic from presenting itself as upstream. Historical upstream links remain unchanged because they identify the source of an issue, pull request, schema, or documentation reference.

**Hosting domains:** Separating the product landing, collab relay/client, and apex landing keeps deployment ownership and trust surfaces understandable. A link's hostname should accurately identify the service receiving traffic.

**Surface capability:** Ephemeral sharing and a persistent operator gateway have different lifetimes, permissions, and user expectations. Keeping them distinct avoids implying that a temporary browser/TUI share includes pk-speak's paired voice, routing, session, workspace, or approval capabilities.

A future hosted `/remote` at `oh-my-pk.pkking.computer/remote` is out of scope. It requires a real static client route, an expanded encrypted protocol, and scoped capability tokens; substituting that URL into existing output without those pieces would create a broken link.
