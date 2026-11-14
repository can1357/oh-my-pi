# 0050. Extension-declared URL schemes

Status: accepted by the owner on 2026-11-11, with conditions (see Decision record 2026-11-11)
Date: 2026-11-10
Area: tools

## Context

[ADR 0027](0027-read-materializes-resources.md) makes `Read` the one materializer for resources, and [ADR 0049](0049-tiered-integration-architecture.md) D2.5 keeps `pr://` and `issue://` forge-neutral. The 2026-11-09 text of both records said the scheme vocabulary does not grow, and that an extension which needs a readable resource uses `mcp://` or a device. That overstates the code. This change softens those sentences to the built-in vocabulary and points the extension path here.

The built-in vocabulary is closed. Schemes an RPC host declares are already readable, through one unknown-scheme fallback, with line selection in core. An installed extension cannot declare a scheme today. This record is the missing declaration path. It does not add a built-in scheme, and it does not add a second resolver.

Prior product behavior being recovered: a read of a resource URI outside the built-in schemes could be served from a mounted MCP server. The omp1 sources for that fallback are not in this repository. This record cites no path or line for them.

### Evidence

Citations in the table are paths on this docs tip, `omp2` at `580d3fb9fb`. The same facts were re-checked at `bf39a439a0` (phase4-scheme, the envd-03 tip after #557). Where that tip moved a symbol, the later location is in the last column. Those split paths are not on this docs tip.

| Fact | This docs tip (`580d3fb9fb`) | At `bf39a439a0` |
|---|---|---|
| Built-in `Scheme` is a closed enum. `Http` accepts the `https` alias. `Unknown` is the variant for a syntactically valid name outside the vocabulary. `ALL` is the dense built-in list. `parse` maps an unrecognized name to `Unknown` | `crates/tools/src/read/resolver.rs:181-222` (`https` at 185-186, `Unknown` at 222); `ALL` at 227; `parse` at 231-232. Frozen copy: `crates/tools/url-vocab.json`, packed by `crates/py/build.rs` | Same lines |
| `install_unknown_fallback` installs one raw-scheme fallback and does not register `Scheme::Unknown` in the dense table | `crates/tools/src/read/resolver.rs:608-612` | Same lines |
| Production installs `HostUriResolver` as that fallback | `crates/envd/src/tool_url.rs:532-534` | `crates/envd/src/tool_url.rs:545-546` |
| `HostUriResolver` is documented as the resolver for schemes declared by the RPC host. Its read calls `resolve_read`, then `select_bytes` | `crates/envd/src/tool_url/host.rs:40-44` and 78-84 | Same lines |
| `HostResources::resolve_read` is the host broker | `crates/envd/src/tools.rs:3483` | `crates/envd/src/tools/bridges.rs:426-428` |
| `select_bytes` applies a line selector in core and returns the body unchanged for any other selector | `crates/envd/src/tool_url.rs:877-885` | `crates/envd/src/tool_url.rs:890-895` |
| A control read of `Scheme::Unknown` dispatches `read_unknown` | `crates/envd/src/server.rs:1494-1495` | `crates/envd/src/server/control_factories.rs:433-434` |
| An RPC host declares schemes from Python with `HostUri`. The bridge replaces one generation through `set_host_uri_schemes`. Names match `^[a-z][a-z0-9+.-]*$`, are unique after normalization, and a generation holds at most 32 | `crates/py/python/omp_rpc/host_uris.py:53-62`; `crates/rpc/src/client.rs:1387-1434`; `crates/rpc/src/protocol.rs:477` | `HostUri` at the same lines |
| Chat `/reload-plugins` posts `Mutation::ReloadExtensions`. `ExtensionReloadHandle::reload` drains idle extension hosts and starts the next generation. `quarantine_extensions` stops revoked hosts and keeps their static routes | `crates/chat/src/commands/tools.rs:543-547`; `crates/envd/src/lib.rs:677-681`; `crates/envd/src/server.rs:3405-3408` | Reload handle at `crates/envd/src/lib.rs:698-706`; quarantine at `crates/envd/src/server/session.rs:1102-1105` |
| Extensions cannot declare schemes. The deployment manifest has no `schemes` field. `omp.urls.schemes` returns the frozen built-in table | `crates/ext/src/config.rs:1356-1372`; `crates/py/python/omp/urls.py:114-124` | Same gap |

`Scheme::accepts_selectors` is false for `Mcp` and `Unknown` (`resolver.rs:236-238`). `parse_uri("custom://pending:raw")` therefore keeps `pending:raw` in the resource (`crates/tools/src/read/selector.rs:679-680` and the test at 887-889). `select_bytes` still runs for a host read, and it applies a range only when the parsed selector is already `Lines`. A declared scheme does not receive the shared line grammar until this record says it does.

## Decision

### D1. One canonical spelling; no aliases in v1

A declared scheme has one canonical spelling. The spelling matches the host-URI grammar already enforced by `set_host_uri_schemes`: `^[a-z][a-z0-9+.-]*$`, normalized to lowercase, at most `MAX_HOST_URI_SCHEME_BYTES`.

The only built-in alias pair is `http` / `https` (`Scheme::Http`). A declared spelling that collides with any built-in wire name in `url-vocab.json`, including `https`, is refused.

**Owner decision, 2026-11-11.** A declaration carries one spelling; v1 has no aliases. A declared spelling that collides with any built-in wire name in `url-vocab.json` is refused. The built-in wire names are `file`, `http`, `https`, `artifact`, `history`, `agent`, `local`, `memory`, `mcp`, `skill`, `rule`, `omp`, `issue`, `pr`, `ssh`, `security`, `vault`, `job`, `attachment` and `conflict` (`crates/tools/url-vocab.json`, the source of truth). An alias would be a second prompt surface and a second key in the frozen alias map (`omp/urls.py` `_SCHEME_ALIASES`); a later record may add aliases.

### D2. The built-in vocabulary does not grow

`Scheme`, `Scheme::ALL`, and `crates/tools/url-vocab.json` stay the closed built-in vocabulary. `Scheme::parse` keeps mapping every other syntactically valid name to `Unknown`.

No vendor concept adds a built-in scheme. A GitLab merge request stays `pr://…`, as [ADR 0049](0049-tiered-integration-architecture.md) D2.5 already requires. `gitlab://` and `mr://` are not built-ins. An extension may document its own resources under a scheme it declares; it may document a merge request as `pr://…`.

### D3. Declared schemes are served by the existing unknown-scheme fallback

Production keeps one fallback: `install_unknown_fallback` → `HostUriResolver`. A read of `Scheme::Unknown` keeps dispatching `read_unknown`. The handler result keeps passing through `select_bytes` in core.

An extension does not call `ResolverTableBuilder::register`, does not add a `Scheme` variant, and does not install a second fallback. `register` already rejects `Scheme::Unknown`.

The extension-facing registration is additive. The host bridge underneath stays the generation replace that `set_host_uri_schemes` already performs (`client.rs:1387-1388`). The environment publishes one generation that is the union of the RPC host's schemes and every live extension's schemes. One extension's registration does not erase another's.

### D4. Manifest field `schemes` and additive `omp.schemes`

An installed extension declares its schemes in the manifest field `schemes`. Each entry names the canonical spelling, a short description, whether the resource is immutable, and whether it is writable. Effects (fetch hosts, credentials) ride the manifest's existing capability declaration ([ADR 0049](0049-tiered-integration-architecture.md) D4).

At activation the extension registers those schemes through `omp.schemes`, an additive function on the frozen Python surface. Registration accepts a scheme only when the loaded manifest claimed it. A claim the manifest omitted is refused. The API adds a symbol; it does not break the ABI ([ADR 0036](0036-python-for-extensions.md)).

`omp.urls.schemes` continues to return the built-in table. Declared schemes are a separate listing, so the frozen `Scheme` enum stays closed.

### D5. Core owns selectors, the byte ceiling, and effect judgment

For a scheme this extension declared, core splits the shared line-selector grammar before dispatch and applies it with `select_bytes` after the handler returns the body. The handler sees the resource without that selector.

`mcp://` stays selector-opaque. An undeclared `Unknown` URI stays selector-opaque too: a trailing `:12` or `:raw` remains part of the resource, which is what `parse_uri` does today.

The byte ceiling is the central read bound ([ADR 0009](0009-bound-output-once.md)). An extension does not truncate the model-facing body itself.

Fetch and credential judgment uses the declaration. A declared scheme with no fetch and no credentials is a local read. Anything the declaration omits stays `Effects::unknown()`, which is the exec approval tier.

**Current behavior, verified 2026-11-11, differs from the paragraph above.** A read of a raw foreign scheme reaches `read_unknown_fetch` (`crates/tools/src/read.rs:971`, `crates/tools/src/read/resolver.rs:767`), which returns the installed fallback's `read_fetch`. The envd fallback is `UrlResolver::Host`, and `crates/envd/src/tool_url.rs:453` answers `Some(FetchEffects { credentials: false })` for every host URI: an approval-tier `Fetch` (anonymous network egress, above Read and below Write; `ApprovalTier::from_effects`, `crates/contract/src/posture.rs:365-405`), whatever the extension declared. It is neither `Effects::unknown()` nor a declaration-based judgment. **Condition:** replacing that blanket answer with the declaration-based judgment above is a prerequisite of S3, with a regression test that a declared scheme whose declaration omits fetch and credentials is judged `Effects::unknown()` and that an undeclared foreign scheme never receives a declared scheme's judgment. `read_fetch` returns `Option<FetchEffects>` and cannot express `Effects::unknown()`, which is produced at `crates/agent/src/dispatch.rs:2196`, so S3 must carry the declaration's judgment through a path that can express it; the stale doc comment at `crates/envd/src/tool_url.rs:440-443` ("the environment fetches nothing for it") is corrected in the same slice.

### D6. Lifetime is the extension generation

A declared scheme is live only while the extension generation that registered it is live.

`/reload-plugins` posts `Mutation::ReloadExtensions`. `ExtensionReloadHandle::reload` starts the next generation, and that generation re-registers the extension's manifest schemes. `quarantine_extensions` drops the quarantined extension's schemes and keeps static routes, including every built-in resolver and any scheme still owned by a live extension or the RPC host.

Two extensions claiming one spelling: the first claim stands, and the later claim is refused. The refusal names both extensions. A quarantined scheme does not fall through to another extension.

### D7. Native MCP resource URIs stay with the MCP manager

Mounted MCP resources stay readable as `mcp://`, via `omp.mcp.mount`, as ADR 0027 says. That path is unchanged.

**Owner decision, 2026-11-11.** Native MCP resource URIs stay an MCP-manager concern. An extension that wants them readable tells the model to use `mcp://…`. An extension does not declare a server's native scheme in v1: a native scheme would be a second grammar beside `mcp://`, and a declared native spelling could occupy a name the built-in vocabulary may later need.

### Completion

This record is complete when S1–S5 have landed. It was accepted by the owner on 2026-11-11 with the conditions in the Decision record; D1 and D7 are recorded.

### Non-goals

- No new built-in scheme, and no new `Scheme` variant, for a vendor concept or for an extension.
- No second resolver table and no second unknown-scheme fallback.
- No runtime mutation of the latched wire roster or of tool schemas ([ADR 0024](0024-small-permanent-roster.md)).
- No JavaScript or TypeScript plugin runtime ([ADR 0036](0036-python-for-extensions.md)).
- No extension-held raw provider tokens ([ADR 0049](0049-tiered-integration-architecture.md) D4).
- Declaring a scheme does not replace `pr://`, `issue://`, or `mcp://`.

### Phase placement

ADR 0049 Phase **2S**: after Phase 2 (locality, the table-driven roster) and before Phase 3 (capability features). Phase 2S does not satisfy a Phase 2 or Phase 3 exit criterion, and it does not wait on Phase 4's forge-neutral `pr://` / `issue://` work.

One PR per slice. Each slice lands under the owner acceptance of 2026-11-11 and its conditions.

| Slice | PR | Exit |
|---|---|---|
| S1 | Manifest field `schemes` and additive `omp.schemes`. The manifest parser (`crates/ext`, which has no dependency on the vocabulary) refuses an unclaimed name and a grammar miss; a built-in wire name is refused where the vocabulary is available, in `crates/py`, which packs `crates/tools/url-vocab.json` (`crates/py/build.rs:133`) | A fixture manifest round-trips; `https` and `pr` are refused; `omp.urls.schemes` is unchanged |
| S2 | Fold live claims into one `set_host_uri_schemes` generation served by `HostUriResolver`. Gate `omp.schemes.register` on the loaded manifest's claims, and refuse built-in wire names where claims are folded into the generation: S1 leaves the two unlinked, and `crates/ext` cannot refuse a built-in name | `read` of a declared scheme returns the handler body; a second extension's claim on the same spelling is refused; built-in `pr://` still resolves; the named test `declared_scheme_fold_refuses_builtin_and_unclaimed` shows that a manifest claiming `https` or `pr` is refused at the fold and that registering a name the manifest did not claim is refused |
| S3 | Core line-selector split for declared schemes only, plus effect judgment on the declaration | `widget://id:2-3` returns those lines from core; `custom://pending:raw` for an undeclared scheme still keeps `pending:raw`; `mcp://` stays opaque |
| S4 | Rebind on `ExtensionReloadHandle::reload`; drop on `quarantine_extensions` | After `/reload-plugins` the scheme still reads; after quarantine it does not, and a built-in route still reads |
| S5 | Model-facing listing of declared schemes, without a roster or schema change, plus the joined conformance test | The conformance test covers install, read, selector, reload, quarantine, and a stable built-in route |

D1 and D7 are recorded (2026-11-11). S1 may start. S2 starts after S1 lands. S3 depends on S2 and on the D5 prerequisite above. S4 depends on S2. S5 depends on S3 and S4.

### Acceptance tests

- A built-in spelling, including the `https` alias, is refused at declaration.
- A declared scheme is readable through `read` and through `omp.urls.read` of an `Unknown` scheme, and the body passes through `select_bytes`.
- A declared scheme's line selector is applied in core. An undeclared unknown URI and `mcp://` keep their current opaque grammar.
- Reload re-registers the scheme. Quarantine removes it and leaves static routes in place.
- Two extensions cannot own one spelling. One extension's registration cannot erase another's.
- The latched tool roster and the `Scheme` enum are unchanged by installing the fixture extension.
- With D7, a server-native MCP URI is not a declared scheme. `mcp://` still reads the mounted resource.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Grow `Scheme` and `url-vocab.json` for each extension | Reopens the closed built-in vocabulary, edits the frozen Python enum, and invalidates the prompt prefix that ADR 0024 latches |
| Vendor-specific built-in schemes (`mr://`, `gitlab://`) and vendor tools (`gitlab@1`) | The rejection in ADR 0049 stands. An adapter documents merge requests as `pr://…` |
| Leave extensions on `mcp://` and devices only | That remains available. It does not recover a scheme the extension owns and the model can `read` directly; the RPC host can already do that through `HostUri` |
| A second resolver table beside `HostUriResolver` | The production table already has one unknown-scheme fallback. A second table splits selector, effect, and byte-ceiling behavior |
| Extension-local reader tools | ADR 0027 prohibits a roster sibling for a format `Read` already projects |

## Consequences

**Easier:**

- An installed extension documents `widget://<id>` and `Read` materializes it, with line selection and the central byte ceiling.
- Adding that scheme edits no `Scheme` variant and no `url-vocab.json` row.
- Forge adapters keep documenting merge requests as `pr://…`.

**Prohibited:** a new built-in scheme for a vendor concept or an extension; registering a built-in wire name; a second unknown-scheme fallback; an extension replacing another extension's generation; raw provider tokens in the extension.

**Costs accepted:**

- A manifest field and one additive Python symbol, `omp.schemes`.
- A generation-scoped union published through `set_host_uri_schemes`.
- A line-selector split that applies to declared schemes and leaves undeclared `Unknown` URIs and `mcp://` opaque.
- Two owner decisions (D1 aliases, D7 native MCP URIs) recorded 2026-11-11, before S2.

## Decision record 2026-11-11

The owner accepted this record on 2026-11-11, on the recommendation of a three-lens council (requirements, risk, simplicity), with these conditions:

1. **D1:** one canonical spelling, no aliases in v1; built-in wire names are refused.
2. **D7:** extensions use `mcp://`; no declared native MCP URI schemes.
3. **D5 correction:** the record said an unreported foreign scheme stays `Effects::unknown()`. The code answers `FetchEffects { credentials: false }` for every host URI (`crates/envd/src/tool_url.rs:453`). Replacing that with the declaration-based judgment is a prerequisite of S3, with the regression test named in D5.
4. **S1 placement:** the built-in-name refusal belongs in `crates/py`, which packs the vocabulary; `crates/ext` has no dependency on it.

The five-slice plan is unchanged. One council reviewer argued that S2 and S4 could merge and that S3 and the S5 listing could be deferred; that is recorded as an option for the owner, not adopted. S2 to S5 stay gated as the sequencing above says.

**Unchanged:** the `Scheme` enum, `url-vocab.json`, the latched wire roster, journal schema, and `mcp://` via `omp.mcp.mount`.

## Implementation gate

- Status is accepted by the owner (2026-11-11) with the conditions in the Decision record. Production change is authorized slice by slice under that record.
- D1 and D7 are recorded; S2 waits for S1.
- S1–S5 each land as one PR under ADR 0049 Phase 2S, after Phase 2 and before Phase 3.
- Phase 2S does not start Phase 3 and does not close Phase 4.

## Status in omp

**Accepted; S1 landed inert (PR #593); S2 landed (scheme fold).** S1 adds manifest `schemes` parsing in `crates/ext` (`crates/ext/src/scheme.rs`) and the additive `omp.schemes` in `crates/py` (`crates/py/python/omp/schemes.py`). S2 folds live claims into an envd-owned `SchemeGeneration` that implements `HostResources` and is installed as the unknown-scheme broker for `HostUriResolver` (Option A: replace-map publish; RPC `set_host_uri_schemes` stub stays unused on chat compositions). Manifest claims carry through `ExtensionManifest` → `control_manifest_snapshot` → `configure_manifest`; `omp.schemes.register(*decls, read=None)` gates on those claims and keeps the Python builtin refuse; envd refuses built-in wire names again at fold. CONTROL `omp.schemes.read` invokes the registered read callable; `resolve_write` refuses with `declared scheme writes are not enabled`. `omp.urls.schemes` is unchanged. Named test `declared_scheme_fold_refuses_builtin_and_unclaimed` plus read-body, collision, and `pr://` intact proofs live in `crates/envd/tests/declared_scheme_fold.rs`. S3 to S5 are open.

## References

- ADRs 0009, 0024, 0027 (amendment 2026-11-09), 0036 (amendment 2026-11-09), 0049 D2.5 and Phase 2S.
- `crates/tools/src/read/resolver.rs`, `crates/tools/url-vocab.json`, `crates/envd/src/tool_url.rs`, `crates/envd/src/tool_url/host.rs`, `crates/py/python/omp_rpc/host_uris.py`, `crates/rpc/src/client.rs`.
