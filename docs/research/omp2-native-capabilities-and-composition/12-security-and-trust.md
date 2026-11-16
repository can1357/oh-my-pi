# Security and trust

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff`.

| Surface | Rule |
|---|---|
| Skills | Instruction material; never expand tool/network/fs authority |
| `allowed-tools` | Parse-only today; must not become a grant without intersect-only ADR |
| Hooks | May Deny/Modify/RequireApproval within phase legality; must not bypass ApprovalBook |
| Extensions / grants | Trust and capability grants stay envd/ext native |
| Shell / jq | PathPolicy + sandbox; structured input ≠ injection-free |
| sHEL | Reject embed — AGPL workstation + new trust plane |
| Evidence | Skills/checklists are not runtime proof; ADW/accept + cleanse own verification |

Least authority: manifests and Goldfish agreement do not authorize production behavior.
