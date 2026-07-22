# Agent Hub Keybinding Optimization

## Status
**Implemented** — Agent Hub supports standard close, rename, filter, removal, and adaptive hint interactions.

## Summary
Redesign the Agent Hub keybindings to follow standard TUI conventions, add missing functionality (rename, filter), and improve discoverability through adaptive hints.

---

## 1. Current State

### Component Location
- **File**: `packages/coding-agent/src/modes/components/agent-hub.ts`
- **Class**: `AgentHubOverlayComponent`
- **Data model**: `AgentRef` from `packages/coding-agent/src/registry/agent-registry.ts`

### Current Keybindings

| Key | Action | Behavior |
|-----|--------|----------|
| `j` / `k` | Navigate | Move selection up/down the agent tree |
| `Enter` | Open/Focus | Live session → focus in main view; parked/advisor → open transcript viewer |
| `r` | Revive | Revive a parked agent |
| `ctrl+x` | Remove | Double-tap confirmation to remove agent |
| `Esc` | Close | Exit the hub overlay |
| `←←` | Close | Double-tap left arrow (within 500ms) |
| Hub key | Toggle | `alt+a`, `ctrl+s`, or `ctrl+shift+b` toggles hub open/closed |
| Composer `←←` | Open | Double-tap left arrow at the empty prompt opens the hub |

> **Intent Composer:** The execution rail always surfaces the Agent Hub action with its configured hub key and the stable `←←` fallback. The editor callback remains the source of truth for double-left detection, so the shortcut survives composer layout changes.

> **Background sessions (post-consolidation):** The hub also opens via `ctrl+shift+b` (`app.session.backgrounds`) and the `/backgrounds` slash command; `/background [name]` promotes the current session into a persistent named background agent and then opens the hub. The hub is one folder → session → subagent tree: the current session and persistent background instances are session lanes grouped under collapsible per-folder headers (keyed by working directory, folders expanded by default with the current folder first). `Space` toggles the selected folder or session lane; background lanes are collapsed by default and expand to reveal their nested subagents; `Enter` on a background lane resumes that session.

### Current Hint Bar
```
j/k:select  Enter:open  r:revive  ctrl+x:remove  Esc/←←:close
```
Static text, always shown regardless of context.

### AgentRef Structure
```typescript
interface AgentRef {
  id: string;
  displayName: string;      // ← Can be modified
  kind: "main" | "sub" | "advisor";
  parentId?: string;
  status: "running" | "idle" | "parked" | "aborted";
  color?: string;
  session: AgentSession | null;
  sessionFile: string | null;
  createdAt: number;
  lastActivity: number;
  activity?: string;
  cwd?: string;
}
```

---

## 2. Identified Issues

### 2.1 Non-standard conventions
- **No `q` to quit**: Every TUI uses `q` to close/quit. Users expect this.
- **`ctrl+x` is non-obvious**: Users don't discover it; they look for `x` or `d` (delete).
- **`r` for revive is low-frequency**: Reviving is rare compared to other actions, yet occupies a prime key.

### 2.2 Missing functionality
- **No rename capability**: Agents have `displayName` but no way to change it from the hub.
- **No filter/search**: Large agent lists are hard to navigate.
- **No dedicated chat key**: `Enter` conflates "focus live session" and "open transcript viewer".

### 2.3 Poor discoverability
- **Static hints**: Don't adapt to selected agent's state (parked vs running vs advisor).
- **No visual feedback**: Users don't know what's possible with the currently selected agent.

---

## 3. Proposed Changes

### 3.1 Keybinding Overhaul

| Key | Action | Rationale |
|-----|--------|-----------|
| `q` | **Close hub** | Standard TUI convention; intuitive |
| `r` | **Rename agent** | Prime key for common operation; inline input |
| `R` | **Revive** parked | Shift modifier for rarer action |
| `x` | **Remove** | Discoverable; `d` conflicts with navigation |
| `ctrl+x` | Remove (alias) | Backward compatibility |
| `c` | **Chat view** | Dedicated transcript viewer key |
| `/` | **Filter** | Standard search key (vim, less) |
| `Enter` | Focus (live only) | Clearer intent |
| `j` / `k` | Navigate | Unchanged |
| `Esc` | Close / clear filter | Context-aware |
| `←←` | Close | Unchanged |

### 3.2 Rename Flow

**Trigger**: Press `r` when an agent is selected.

**Input mode**:
1. Bottom bar becomes inline prompt: `Rename "AuthLoader" → [cursor]`
2. Current `displayName` is pre-filled
3. User types new name (or edits)
4. `Enter` commits the rename
5. `Esc` cancels and restores hint bar

**Validation**:
- Non-empty name required
- No duplicate `id` check (but `displayName` can collide)
- Advisor agents cannot be renamed (show error)

**Persistence**:
- Call `AgentRegistry.setDisplayName(id, newName)`
- Update `AgentRef.displayName` in memory
- Persist to session metadata (session file) for survival across restarts

**Registry changes**:
```typescript
// Add to RegistryEvent union
| { type: "renamed"; ref: AgentRef }

// Add method
setDisplayName(id: string, name: string): void {
  const ref = this.#refs.get(id);
  if (!ref || ref.displayName === name) return;
  ref.displayName = name;
  ref.lastActivity = Date.now();
  this.#emit({ type: "renamed", ref });
}
```

### 3.3 Adaptive Hint Bar

Replace static hints with context-aware text:

```typescript
// When selected agent is parked:
"j/k:select  Enter:open  c:chat  r:rename  R:revive  x:remove  q:close"

// When selected agent is running:
"j/k:select  Enter:focus  c:chat  r:rename  x:kill  q:close"

// When selected agent is advisor:
"j/k:select  Enter:view  q:close"

// When in filter mode:
"Type to filter  Esc:clear"

// When in rename mode:
"Type new name  Enter:save  Esc:cancel"
```

### 3.4 Filter Mode

**Trigger**: Press `/`.

**Input mode**:
1. Bottom bar becomes search prompt: `Filter: [cursor]`
2. User types filter string
3. Rows filter in real-time (case-insensitive substring match on `id`, `displayName`, `activity`)
4. Selection adjusts to nearest match
5. `Esc` clears filter and restores normal view
6. `Enter` in filter mode activates the first visible row

**Filter logic**:
```typescript
const matchesFilter = (row: HubRow, query: string): boolean => {
  const q = query.toLowerCase();
  return (
    row.ref.id.toLowerCase().includes(q) ||
    row.ref.displayName.toLowerCase().includes(q) ||
    (row.ref.activity?.toLowerCase().includes(q) ?? false)
  );
};
```

### 3.5 Chat Decoupling

**Current**: `Enter` opens transcript viewer for parked/advisor agents.

**Proposed**:
- `c` key → always opens transcript viewer (chat view)
- `Enter` on live session → focus in main view
- `Enter` on parked session → revive and focus
- `Enter` on advisor → open chat view (read-only transcript)

This makes `Enter` behavior more predictable: "make this agent active".

---

## 4. Implementation Plan

### Phase 1: Keybinding Overhaul
1. Add `q` key handler in `handleTableInput()`
2. Move revive from `r` to `R` (case-sensitive check)
3. Add `x` as alias for `ctrl+x` in remove handler
4. Update static hint bar to reflect new keys

**Files**:
- `packages/coding-agent/src/modes/components/agent-hub.ts`

**Tests**:
- Update `agent-hub-remove.test.ts` to verify both `x` and `ctrl+x` work
- Add test for `q` closing hub
- Add test for `R` reviving parked agent

### Phase 2: Rename Flow
1. Add `#renameInput` state to `AgentHubOverlayComponent`
2. Add `r` key handler to enter rename mode
3. Add input handling for rename buffer (character keys, backspace, enter, escape)
4. Call `registry.setDisplayName()` on commit
5. Render rename prompt in place of hint bar when active

**Files**:
- `packages/coding-agent/src/modes/components/agent-hub.ts`
- `packages/coding-agent/src/registry/agent-registry.ts`

**Tests**:
- Add `agent-hub-rename.test.ts`
- Verify rename commits on Enter
- Verify rename cancels on Esc
- Verify advisor cannot be renamed
- Verify empty name rejected

### Phase 3: Adaptive Hints
1. Extract hint bar rendering to helper method
2. Add conditional logic based on `selectedRef().status` and `kind`
3. Update all hint strings

**Files**:
- `packages/coding-agent/src/modes/components/agent-hub.ts`

**Tests**:
- Visual regression test (render output for each agent state)

### Phase 4: Filter Mode
1. Add `#filterQuery` state to component
2. Add `/` key handler to enter filter mode
3. Add input handling for filter buffer
4. Filter `#rows` based on query before rendering
5. Adjust `#selectedRow` to stay in bounds

**Files**:
- `packages/coding-agent/src/modes/components/agent-hub.ts`

**Tests**:
- Add `agent-hub-filter.test.ts`
- Verify filter reduces visible rows
- Verify Esc clears filter
- Verify Enter activates first match

### Phase 5: Chat Decoupling
1. Add `c` key handler to open transcript viewer
2. Modify `Enter` handler to only focus live sessions
3. Update hint bar to show `c:chat`

**Files**:
- `packages/coding-agent/src/modes/components/agent-hub.ts`

**Tests**:
- Update `agent-hub-activate.test.ts` to verify new behavior
- Add test for `c` key opening chat

---

## 5. Migration & Compatibility

### Backward Compatibility
- `ctrl+x` remains functional (alias for `x`)
- Hub toggle keys (`alt+a`, `ctrl+s`) unchanged
- `Esc` and `←←` close unchanged
- Existing tests must be updated, not broken

### User Migration
- No config migration needed (keybindings are hardcoded in component)
- Consider adding a "what's new" notice on first launch after update?
- Update documentation in `docs/agent-hub.md` (if exists)

---

## 6. Open Questions

1. **Rename persistence**: Should rename persist to session file immediately, or only on session save?
   - **Recommendation**: Immediate persist for consistency with other UI actions.

2. **Filter behavior**: Should filter be case-sensitive?
   - **Recommendation**: Case-insensitive (more forgiving).

3. **Rename conflicts**: What if user renames to an existing `displayName`?
   - **Recommendation**: Allow it (`displayName` is not unique; `id` is).

4. **Advisor rename**: Should advisors be renameable?
   - **Recommendation**: No (they're read-only transcripts, rename is meaningless).

5. **Filter persistence**: Should filter query persist across hub open/close?
   - **Recommendation**: No (fresh view each time).

---

## 7. Success Criteria

- [ ] All new keys work as specified
- [ ] Rename flow commits and persists correctly
- [ ] Filter mode reduces and restores row list correctly
- [ ] Adaptive hints show correct text for each agent state
- [ ] Existing tests updated and passing
- [ ] New tests added for all new functionality
- [ ] No regressions in hub behavior (visual, functional, or test)

---

## 8. References

- Component: `packages/coding-agent/src/modes/components/agent-hub.ts`
- Registry: `packages/coding-agent/src/registry/agent-registry.ts`
- Tests: `packages/coding-agent/test/agent-hub-*.test.ts`
- Theme: `packages/coding-agent/src/modes/theme/theme.ts`
- Keybindings: `packages/coding-agent/src/config/keybindings.ts`
