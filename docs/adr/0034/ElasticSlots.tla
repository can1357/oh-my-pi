---- MODULE ElasticSlots ----
\* =========================================================================
\* Elastic Speculative Slots: a formally verified rendering protocol for
\* streaming concurrent output blocks through a bounded terminal viewport
\* into append-only scrollback.
\*
\* Three decoupled layers, related by invariants (see ELASTIC_SLOTS2.tex):
\*   1. semantic block state   (phase/mode/want/final/emitted per block)
\*   2. logical history ledger (`history`: width-independent, exactly-once)
\*   3. physical native rows   (`native`: width-rendered, source-tagged)
\* =========================================================================
EXTENDS Naturals, Sequences, FiniteSets, TLC
\* Naturals: arithmetic; Sequences: <<>>/Len/SubSeq/\o; FiniteSets:
\* Cardinality/IsFiniteSet; TLC: model-checking utilities.

CONSTANTS N, H, MaxResizes, MaxLive, RowValues, SnapshotValues,
          NoFinal, Placeholder, Blank, OverflowMarker
\* N            : number of block identities (blocks are 1..N, in commit order)
\* H            : maximum viewport (live transcript) height, in rows
\* MaxResizes   : bound on resize events (keeps the state space finite)
\* MaxLive      : uncommitted-block count that constitutes "pressure"
\* RowValues    : finite row alphabet (what a semantic line of output "is")
\* SnapshotValues: finite universe of block contents (sequences of rows)
\* NoFinal      : sentinel "this block has no final snapshot yet"
\* Placeholder  : synthetic viewport row shown for an empty slot
\* Blank        : synthetic viewport row for unused screen space
\* OverflowMarker: synthetic viewport row summarizing hidden older blocks

ASSUME
    ∧ N ∈ ℕ \ {0}                                  \* at least one block
    ∧ H ∈ ℕ \ {0}                                  \* viewport can be nonempty
    ∧ MaxResizes ∈ ℕ                               \* zero resizes is allowed
    ∧ MaxLive ∈ ℕ \ {0}                            \* pressure threshold >= 1
    ∧ IsFiniteSet(RowValues)                           \* finite row alphabet
    ∧ RowValues ≠ {}                                   \* ... and nonempty
    ∧ IsFiniteSet(SnapshotValues)                      \* finite snapshot universe
    ∧ SnapshotValues ⊆ Seq(RowValues)          \* snapshots are row sequences
    ∧ ⟨⟩ ∈ SnapshotValues                          \* the empty snapshot exists
    ∧ (∃ snapshot ∈ SnapshotValues : Len(snapshot) = 1)  \* a length-1 snapshot exists
    ∧ (∃ snapshot ∈ SnapshotValues : Len(snapshot) > 1)  \* a longer one exists too
    ∧ NoFinal ∉ SnapshotValues                    \* sentinel distinct from real data
    ∧ Placeholder ∉ RowValues                     \* synthetic rows are not
    ∧ Blank ∉ RowValues                           \* ... confusable with
    ∧ OverflowMarker ∉ RowValues                  \* ... semantic rows,
    ∧ Placeholder ≠ Blank                              \* and are pairwise
    ∧ Placeholder ≠ OverflowMarker                     \* distinct from
    ∧ Blank ≠ OverflowMarker                           \* each other.

Blocks ≜ 1‥N                                          \* the block identities
ModelRows ≜ {"row-a", "row-b"}                         \* tiny concrete row alphabet for TLC
ModelSnapshots ≜                                       \* a richer snapshot universe (unused by the shipped cfg)
    {⟨⟩,                                              \* empty block
     ⟨"row-a"⟩,                                       \* one-liner
     ⟨"row-b"⟩,                                       \* one-liner, other row
     ⟨"row-a", "row-b"⟩,                              \* two distinct rows
     ⟨"row-b", "row-a"⟩,                              \* order matters
     ⟨"row-a", "row-b", "row-a"⟩}                     \* length three, with repeat
SmallModelSnapshots ≜ {⟨⟩, ⟨"row-a"⟩, ⟨"row-a", "row-b"⟩}  \* the cfg's universe: lengths 0, 1, 2

WidthValues ≜ {"Wide", "Narrow"}                       \* two-point abstraction of terminal width
ResizeModes ≜ {"Preserve", "Append", "Rebuild"}        \* policy chosen at a width-changing resize
ReplayModes ≜ {"None", "Append", "Rebuild"}            \* pending replay (None = no replay in flight)
BlockModes ≜ {"Undeclared", "Mutable", "AppendOnly"}   \* presentation contract, fixed at Create
Phases ≜ {"Absent", "Queued", "Active", "Finalized", "Committed"}  \* block lifecycle, monotone left-to-right
StopReasons ≜ {"Running", "Graceful", "Detach", "WriteFailure"}    \* why the host stopped (Running = it hasn't)
NativeSources ≜ {"Append", "Retire", "Replay", "Resize", "FailedWrite", "Exit"}  \* provenance tag on every native row
CellRows ≜ RowValues ∪ {Placeholder, Blank, OverflowMarker}     \* what a viewport cell may display
Cells ≜ [owner : 0‥N, row : CellRows]                 \* a viewport cell: owning block (0 = chrome) + row
TaggedRows ≜ [owner : Blocks, row : RowValues]         \* a ledger row: semantic, width-independent
NativeRows ≜ [source : NativeSources, owner : 0‥N, row : CellRows, width : WidthValues]
\* a native row: provenance source, owner, rendered row, and the width it was rendered at

SnapshotLengths ≜ {Len(snapshot) : snapshot ∈ SnapshotValues}  \* set of occurring snapshot lengths
MaxSnapshotLength ≜                                    \* L_max: the longest snapshot length
    CHOOSE maximum ∈ SnapshotLengths :                \* (CHOOSE is fine here: the maximum
        ∀ length ∈ SnapshotLengths : length ≤ maximum  \*  of a finite set is unique)
MaxFailureRows ≜ 2 * N * MaxSnapshotLength             \* K_max: upper bound on one physical write batch
                                                        \* (factor 2 = worst-case Narrow doubling)

BlankCell ≜ [owner ↦ 0, row ↦ Blank]               \* the unused-screen-space cell
OverflowCell ≜ [owner ↦ 0, row ↦ OverflowMarker]   \* the "N older blocks hidden" summary cell

\* -------------------------------------------------------------------------
\* State variables (one tuple entry per column of Table 1 in the paper).
\* -------------------------------------------------------------------------
VARIABLES c, phase, mode, want, final, emitted, alloc, target,
          history, native, width, height, resizes, epoch,
          replayMode, replayCursor, replayEnd, replayPartial,
          replayPrepared, replayCut,
          flush, shutdown, running, stopReason
\* c              : commit frontier -- blocks 1..c are committed (retired)
\* phase          : lifecycle phase per block
\* mode           : Mutable / AppendOnly contract per block
\* want           : current speculative snapshot per block
\* final          : frozen final snapshot per block (NoFinal until finalized)
\* emitted        : rows of the head block already streamed into history
\* alloc          : painted slot height per block (rows on screen now)
\* target         : requested slot height per block (animation target)
\* history        : the logical ledger (layer 2)
\* native         : the physical scrollback of the current epoch (layer 3)
\* width, height  : current terminal geometry
\* resizes        : how many resizes happened (bounded by MaxResizes)
\* epoch          : display epoch; Rebuild resets native and bumps this
\* replayMode     : pending replay policy (None / Append / Rebuild)
\* replayCursor   : first committed block to replay (invariantly 1 while replaying)
\* replayEnd      : last committed block to replay (= c at replay start)
\* replayPartial  : how many stable head rows to replay
\* replayPrepared : replay frame computed and cut fixed (gates the scheduler)
\* replayCut      : rows of the replay frame that must scroll into native
\* flush          : explicit "retire everything" request (never reset)
\* shutdown       : graceful shutdown initiated
\* running        : host still alive; every action requires it
\* stopReason     : why we stopped (Running while alive)

vars ≜ ⟨c, phase, mode, want, final, emitted, alloc, target,
          history, native, width, height, resizes, epoch,
          replayMode, replayCursor, replayEnd, replayPartial,
          replayPrepared, replayCut,
          flush, shutdown, running, stopReason⟩
\* the full variable tuple, used for stuttering ([Next]_vars) and UNCHANGED

Maximum(left, right) ≜ IF left ≥ right THEN left ELSE right  \* max of two naturals

\* -------------------------------------------------------------------------
\* Width rendering: the two-point abstraction of soft-wrap reflow.
\* -------------------------------------------------------------------------
RECURSIVE DoubleRows(_)
DoubleRows(snapshot) ≜                                 \* Narrow rendering:
    IF Len(snapshot) = 0 THEN ⟨⟩                      \* empty stays empty;
    ELSE ⟨Head(snapshot), Head(snapshot)⟩ ∘ DoubleRows(Tail(snapshot))
    \* every semantic row occupies TWO physical rows (models a wrapped line)

Render(snapshot, wx) ≜ IF wx = "Wide" THEN snapshot ELSE DoubleRows(snapshot)
\* rho_omega: Wide = identity, Narrow = row doubling; prefix-monotone by construction

Tag(i, snapshot) ≜                                     \* tg_i: stamp each row with its owner
    [j ∈ 1‥Len(snapshot) ↦ [owner ↦ i, row ↦ snapshot[j]]]

SnapshotSlice(snapshot, lo, hi) ≜                      \* s[lo..hi], empty when lo > hi
    IF lo > hi THEN ⟨⟩ ELSE SubSeq(snapshot, lo, hi)

TagSlice(i, snapshot, lo, hi) ≜ Tag(i, SnapshotSlice(snapshot, lo, hi))  \* owner-tagged slice

NativeTag(source, i, snapshot, wx) ≜                   \* ntg: render at width wx, then tag
    [j ∈ 1‥Len(Render(snapshot, wx)) ↦             \* one native row per RENDERED row
        [source ↦ source, owner ↦ i,                \* provenance + owner
         row ↦ Render(snapshot, wx)[j], width ↦ wx]]  \* rendered row + width it used
NativeTagSlice(source, i, snapshot, lo, hi, wx) ≜      \* native-tag a semantic slice
    NativeTag(source, i, SnapshotSlice(snapshot, lo, hi), wx)

NativeCells(source, cells, wx) ≜                       \* lift screen cells to native rows
    [j ∈ 1‥Len(cells) ↦                            \* (used when the emulator itself
        [source ↦ source, owner ↦ cells[j].owner,   \*  pushes viewport rows into
         row ↦ cells[j].row, width ↦ wx]]           \*  scrollback, e.g. on resize/exit)

PrefixOf(sequence, count) ≜ [j ∈ 1‥count ↦ sequence[j]]  \* first `count` elements

\* -------------------------------------------------------------------------
\* The logical ledger as a FUNCTION of state (invariant ECH says
\* `history` always equals CommittedRows(c, final) \o PartialHeadRows).
\* -------------------------------------------------------------------------
RECURSIVE CommittedRows(_, _)
CommittedRows(k, finals) ≜                             \* C(k): finals of blocks 1..k,
    IF k = 0 THEN ⟨⟩                                  \* tagged, concatenated in
    ELSE CommittedRows(k - 1, finals) ∘ Tag(k, finals[k])  \* block (= commit) order

RECURSIVE TaggedRange(_, _, _)
TaggedRange(lo, hi, finals) ≜                          \* tagged finals of blocks lo..hi
    IF lo > hi THEN ⟨⟩                                \* (empty range allowed)
    ELSE Tag(lo, finals[lo]) ∘ TaggedRange(lo + 1, hi, finals)

RECURSIVE NativeRange(_, _, _, _, _)
NativeRange(source, lo, hi, finals, wx) ≜              \* same, but width-rendered and
    IF lo > hi THEN ⟨⟩                                \* source-tagged for `native`
    ELSE NativeTag(source, lo, finals[lo], wx)
         ∘ NativeRange(source, lo + 1, hi, finals, wx)

RetirementRows(lo, hi, finals, firstEmitted) ≜         \* logical retirement batch:
    IF lo > hi THEN ⟨⟩                                \* head block lo contributes only
    ELSE TagSlice(lo, finals[lo], firstEmitted + 1, Len(finals[lo]))  \* its UNstreamed suffix,
         ∘ TaggedRange(lo + 1, hi, finals)             \* later blocks contribute in full

NativeRetirementRows(source, lo, hi, finals, firstEmitted, wx) ≜
    IF lo > hi THEN ⟨⟩                                \* physical twin of RetirementRows:
    ELSE NativeTagSlice(                                \* the same rows,
             source,                                    \* provenance-tagged
             lo,                                        \* (Retire on success,
             finals[lo],                                \*  FailedWrite on failure),
             firstEmitted + 1,                          \* starting after the already-
             Len(finals[lo]),                           \* streamed head prefix,
             wx                                         \* rendered at the current width
         )
         ∘ NativeRange(source, lo + 1, hi, finals, wx) \* then full later finals

FinalizedRange(lo, hi) ≜                               \* "blocks lo..hi are all Finalized"
    ∀ i ∈ lo‥hi : phase[i] = "Finalized"            \* (a retirement batch precondition)

Unemitted(snapshot, i, emission) ≜                     \* U_i(s): the part of s not yet
    IF mode[i] = "AppendOnly"                           \* streamed into history --
    THEN SnapshotSlice(snapshot, emission[i] + 1, Len(snapshot))  \* suffix for append-only,
    ELSE snapshot                                       \* everything for mutable blocks

\* -------------------------------------------------------------------------
\* Live-viewport geometry: who is presented, who is visible, how much
\* space is reserved. All operators take the ambient tuple explicitly so
\* that action guards can evaluate them at SUCCESSOR values.
\* -------------------------------------------------------------------------
Presented(ph, finals, emission, i, wx) ≜               \* block i occupies viewport iff
    ∨ ph[i] = "Active"                                 \* it is actively producing, or
    ∨ ∧ ph[i] = "Finalized"                           \* it is finalized AND still has
     ∧ Len(Render(Unemitted(finals[i], i, emission), wx)) > 0  \* unstreamed content to show

PresentedSet(ph, finals, emission, wx) ≜               \* the set of presented blocks
    {i ∈ Blocks : Presented(ph, finals, emission, i, wx)}
PresentedCount(ph, finals, emission, wx) ≜             \* pi: how many are presented
    Cardinality(PresentedSet(ph, finals, emission, wx))
Overflow(ph, finals, emission, wx, hx) ≜               \* ovf: more presented blocks
    PresentedCount(ph, finals, emission, wx) > hx       \* than viewport rows
SummaryRows(ph, finals, emission, wx, hx) ≜            \* sigma: one summary row is
    IF hx > 0 ∧ Overflow(ph, finals, emission, wx, hx) THEN 1 ELSE 0  \* shown iff overflowing (and h>0)

NewerPresented(ph, finals, emission, wx, i) ≜          \* how many presented blocks are
    Cardinality({                                       \* NEWER (higher index) than i --
        j ∈ Blocks :                                  \* used to privilege recency
            j > i ∧ Presented(ph, finals, emission, j, wx)
    })

VisiblePresented(ph, finals, emission, wx, hx, i) ≜    \* vis(i): presented AND, under
    ∧ Presented(ph, finals, emission, i, wx)           \* overflow, among the hx-1
    ∧ IF Overflow(ph, finals, emission, wx, hx)        \* newest presented blocks
       THEN ∧ hx > 0                                   \* (one row is sacrificed to
            ∧ NewerPresented(ph, finals, emission, wx, i) < hx - 1  \* the summary marker)
       ELSE TRUE                                        \* no overflow: presented = visible

RECURSIVE AllocationTotal(_, _)
AllocationTotal(al, i) ≜                               \* sum of painted heights,
    IF i > N THEN 0 ELSE al[i] + AllocationTotal(al, i + 1)  \* blocks i..N

RECURSIVE ReservationTotal(_, _, _)
ReservationTotal(al, requested, i) ≜                   \* Res: each block is charged
    IF i > N THEN 0                                     \* max(painted, requested) --
    ELSE Maximum(al[i], requested[i]) + ReservationTotal(al, requested, i + 1)
    \* growth pays up front, shrink keeps its old charge until painted

AllocationStateOK(al, requested, ph, finals, emission, wx, hx) ≜  \* A_OK: allocation admissibility
    ∧ al ∈ [Blocks → 0‥H]                          \* painted heights in range
    ∧ requested ∈ [Blocks → 0‥H]                   \* requested heights in range
    ∧ ∀ i ∈ Blocks :
           IF VisiblePresented(ph, finals, emission, wx, hx, i)
           THEN IF ph[i] = "Active"
                THEN ∧ al[i] ∈ 1‥H                  \* visible active: painted >= 1,
                     ∧ requested[i] ∈ 1‥H           \* target >= 1 (may differ: animating)
                ELSE ∧ al[i] ∈ 1‥H                  \* visible finalized: painted >= 1,
                     ∧ requested[i] = al[i]            \* and frozen (no more animation)
           ELSE ∧ al[i] = 0                            \* invisible blocks hold
                ∧ requested[i] = 0                     \* no space at all
    ∧ ReservationTotal(al, requested, 1)               \* reservation invariant:
       + SummaryRows(ph, finals, emission, wx, hx) ≤ hx  \* reservations + summary fit in h

CanonicalAllocation(ph, finals, emission, wx, hx) ≜    \* kappa: the safe default --
    [i ∈ Blocks ↦                                   \* one row per visible block,
        IF VisiblePresented(ph, finals, emission, wx, hx, i) THEN 1 ELSE 0]  \* zero otherwise

SnapshotHeight(ph, wants, finals, i, wx) ≜             \* dm(i): row demand of block i
    CASE ph[i] = "Active" →
             Maximum(1, Len(Render(Unemitted(wants[i], i, emitted), wx)))  \* live: >= 1 row
      □ ph[i] = "Queued" →
             Maximum(1, Len(Render(Unemitted(wants[i], i, emitted), wx)))  \* queued demands space too
      □ ph[i] = "Finalized" →
             Len(Render(Unemitted(finals[i], i, emitted), wx))  \* finalized: exactly its unstreamed rows
      □ OTHER → 0                                     \* absent/committed demand nothing

RECURSIVE FullRows(_, _, _, _, _)
FullRows(ph, wants, finals, wx, i) ≜                   \* D: total row demand of
    IF i > N THEN 0                                     \* blocks i..N
    ELSE SnapshotHeight(ph, wants, finals, i, wx)
         + FullRows(ph, wants, finals, wx, i + 1)

CreatedCount ≜ Cardinality({i ∈ Blocks : phase[i] ≠ "Absent"})  \* gamma: how many blocks exist

PartialHeadExists ≜                                    \* PH: the head block (c+1) has
    ∧ c < CreatedCount                                 \* been created,
    ∧ mode[c + 1] = "AppendOnly"                       \* is append-only,
    ∧ phase[c + 1] ∈ {"Active", "Finalized"}         \* is live,
    ∧ emitted[c + 1] > 0                               \* and has streamed some rows

PartialHeadRows ≜                                      \* A(c): the head's streamed
    IF PartialHeadExists                                \* prefix as tagged ledger rows
    THEN TagSlice(c + 1, want[c + 1], 1, emitted[c + 1])  \* (prefix of `want`, stable by
    ELSE ⟨⟩                                           \*  the append-only contract)

RowPressure ≜ FullRows(phase, want, final, width, 1) > height  \* demand exceeds viewport
Pressure ≜                                             \* pressure = row pressure OR
    ∨ RowPressure                                      \* too many uncommitted
    ∨ CreatedCount - c ≥ MaxLive                      \* blocks piling up
RetirementRequested ≜ flush ∨ Pressure                \* Req: when retirement may fire
Replaying ≜ replayMode ≠ "None"                        \* a replay is in flight

PreviewSource(i) ≜                                     \* what a slot displays:
    IF phase[i] = "Active"                              \* live blocks show their
    THEN Unemitted(want[i], i, emitted)                 \* unstreamed speculation,
    ELSE Unemitted(final[i], i, emitted)                \* others their unstreamed final

PreviewCell(i, snapshot) ≜                             \* the representative cell of a slot:
    LET rendered ≜ Render(snapshot, width) IN          \* render at current width;
    [owner ↦ i,
     row ↦ IF Len(rendered) = 0                       \* empty content shows the
             THEN Placeholder                           \* placeholder row, otherwise
             ELSE rendered[Len(rendered)]]              \* the LAST rendered row (tail view)

Repeat(value, count) ≜ [j ∈ 1‥count ↦ value]      \* value^count as a sequence
Slot(i, snapshot, allocation) ≜ Repeat(PreviewCell(i, snapshot), allocation)
\* a slot = its preview cell repeated alloc[i] times (abstracting the real tail window)

RECURSIVE PresentedCells(_)
PresentedCells(i) ≜                                    \* all slots, ascending block
    IF i > N THEN ⟨⟩                                  \* order (newest at the bottom,
    ELSE (IF alloc[i] = 0 THEN ⟨⟩ ELSE Slot(i, PreviewSource(i), alloc[i]))  \* next to the cursor);
         ∘ PresentedCells(i + 1)                       \* zero-alloc blocks contribute nothing

Screen ≜                                               \* Q: the whole viewport, top to bottom:
    Repeat(
        BlankCell,                                      \* blank filler first,
        height - AllocationTotal(alloc, 1) - SummaryRows(phase, final, emitted, width, height)
    )                                                   \* (exactly the unclaimed rows)
    ∘ (IF SummaryRows(phase, final, emitted, width, height) = 1
        THEN ⟨OverflowCell⟩                           \* then the overflow summary if any,
        ELSE ⟨⟩)
    ∘ PresentedCells(1)                                \* then the block slots

\* -------------------------------------------------------------------------
\* Replay geometry: what a width-changing resize must re-render.
\* -------------------------------------------------------------------------
ReplayRows ≜                                           \* R: the full replay frame --
    IF ¬Replaying
    THEN ⟨⟩                                           \* nothing when no replay pending
    ELSE NativeRange("Replay", replayCursor, replayEnd, final, width)  \* committed finals 1..c
         ∘ (IF replayPartial = 0                       \* re-rendered at the NEW width,
             THEN ⟨⟩                                  \* plus the head's already-
             ELSE NativeTagSlice(                       \* streamed stable prefix
                     "Replay",                          \* (if it had streamed rows
                     replayEnd + 1,                     \*  at resize time) --
                     want[replayEnd + 1],               \* prefix of want, immutable
                     1,                                 \* under the append-only
                     replayPartial,                     \* contract, so stable while
                     width                              \* the replay is in flight
                  ))

ReplayRoom ≜                                           \* how many blank rows the
    Cardinality({j ∈ 1‥height : Screen[j] = BlankCell})  \* viewport can absorb scroll-free

RequiredReplayCut ≜                                    \* cut*: replay rows that do NOT
    IF Len(ReplayRows) > ReplayRoom THEN Len(ReplayRows) - ReplayRoom ELSE 0
    \* fit in the blank region and must scroll into native scrollback

PreparedReplayTail ≜                                   \* the part painted bottom-first
    IF replayPrepared                                   \* into blank rows (no scroll);
    THEN SnapshotSlice(ReplayRows, replayCut + 1, Len(ReplayRows))  \* only meaningful once
    ELSE ⟨⟩                                           \* the frame is prepared

Prefix(left, right) ≜                                  \* left is a prefix of right
    ∧ Len(left) ≤ Len(right)                          \* (the partial order behind the
    ∧ ∀ j ∈ 1‥Len(left) : left[j] = right[j]       \*  append-only contract)

NoEarlierQueued(i) ≜ ∀ j ∈ 1‥(i - 1) : phase[j] ≠ "Queued"  \* FIFO admission guard

\* =========================================================================
\* Initial state: nothing created, full-height wide viewport, empty
\* histories, no replay, host running.
\* =========================================================================
Init ≜
    ∧ c = 0                                            \* nothing committed
    ∧ phase = [i ∈ Blocks ↦ "Absent"]              \* no block exists
    ∧ mode = [i ∈ Blocks ↦ "Undeclared"]           \* no contract chosen
    ∧ want = [i ∈ Blocks ↦ ⟨⟩]                   \* empty speculation
    ∧ final = [i ∈ Blocks ↦ NoFinal]               \* nothing finalized
    ∧ emitted = [i ∈ Blocks ↦ 0]                   \* nothing streamed
    ∧ alloc = [i ∈ Blocks ↦ 0]                     \* no slot painted
    ∧ target = [i ∈ Blocks ↦ 0]                    \* no slot requested
    ∧ history = ⟨⟩                                   \* empty ledger (= CommittedRows(0,...))
    ∧ native = ⟨⟩                                    \* empty scrollback
    ∧ width = "Wide"                                   \* initial geometry:
    ∧ height = H                                       \* wide, full height
    ∧ resizes = 0                                      \* no resizes yet
    ∧ epoch = 0                                        \* first display epoch
    ∧ replayMode = "None"                              \* no replay pending
    ∧ replayCursor = 0                                 \* replay window empty
    ∧ replayEnd = 0
    ∧ replayPartial = 0
    ∧ replayPrepared = FALSE                           \* no frame prepared
    ∧ replayCut = 0
    ∧ flush = FALSE                                    \* no flush requested
    ∧ shutdown = FALSE                                 \* not shutting down
    ∧ running = TRUE                                   \* host alive
    ∧ stopReason = "Running"                           \* ... and not stopped

\* =========================================================================
\* Actions. Every guard conjoins `running`; most also require ~shutdown.
\* =========================================================================

Create(declaration) ≜                                  \* a new block is declared
    ∧ running                                          \* host alive
    ∧ ¬shutdown                                        \* no new work during shutdown
    ∧ CreatedCount < N                                 \* an identity is still free
    ∧ phase[CreatedCount + 1] = "Absent"               \* blocks are created contiguously
    ∧ declaration ∈ {"Mutable", "AppendOnly"}        \* contract chosen now, forever
    ∧ phase' = [phase EXCEPT ![CreatedCount + 1] = "Queued"]  \* enters the queue
    ∧ mode' = [mode EXCEPT ![CreatedCount + 1] = declaration] \* contract recorded
    ∧ UNCHANGED ⟨c, want, final, emitted, alloc, target, history, native,
                   width, height, resizes, epoch,
                   replayMode, replayCursor, replayEnd, replayPartial,
                   replayPrepared, replayCut,
                   flush, shutdown, running, stopReason⟩  \* pure bookkeeping: no paint, no history

Admit(i) ≜                                             \* a queued block gets a live slot
    ∧ running                                          \* host alive
    ∧ ¬shutdown                                        \* not during shutdown
    ∧ phase[i] = "Queued"                              \* must be waiting
    ∧ NoEarlierQueued(i)                               \* FIFO: no older block still queued
    ∧ LET newPhase ≜ [phase EXCEPT ![i] = "Active"]   \* candidate successor phase,
           newAlloc ≜ [alloc EXCEPT ![i] = 1]          \* with a fresh 1-row slot
           newTarget ≜ [target EXCEPT ![i] = 1]        \* painted and requested
       IN ∧ ¬Overflow(newPhase, final, emitted, width, height)  \* admission may NOT overflow --
          ∧ AllocationStateOK(newAlloc, newTarget, newPhase, final, emitted, width, height)
          \* ... and the new slot must fit the reservation invariant; otherwise the
          \* block simply stays queued (denied, not summarized)
          ∧ phase' = newPhase                          \* commit the candidate state
          ∧ alloc' = newAlloc
          ∧ target' = newTarget
    ∧ UNCHANGED ⟨c, mode, want, final, emitted, history, native, width, height,
                   resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial,
                   replayPrepared, replayCut,
                   flush, shutdown, running, stopReason⟩  \* repaint only: histories untouched

Update(i, snapshot) ≜                                  \* speculation evolves
    ∧ running                                          \* host alive
    ∧ ¬shutdown                                        \* not during shutdown
    ∧ phase[i] ∈ {"Queued", "Active"}                \* only unfinalized blocks change
    ∧ (mode[i] = "Mutable" ∨ Prefix(want[i], snapshot))  \* THE append-only contract:
    \* mutable blocks may replace their content arbitrarily; append-only
    \* blocks may only extend it (old rows are immutable)
    ∧ snapshot ≠ want[i]                               \* no stuttering updates
    ∧ want' = [want EXCEPT ![i] = snapshot]            \* the only writer of speculation
    ∧ UNCHANGED ⟨c, phase, mode, final, emitted, alloc, target, history, native,
                   width, height, resizes, epoch,
                   replayMode, replayCursor, replayEnd, replayPartial,
                   replayPrepared, replayCut,
                   flush, shutdown, running, stopReason⟩  \* repaint only

RequestAllocation(newTarget) ≜                         \* the app asks for new slot heights
    ∧ running                                          \* host alive
    ∧ ¬shutdown                                        \* not during shutdown
    ∧ AllocationStateOK(alloc, newTarget, phase, final, emitted, width, height)
    \* admissible against the CURRENT paint: max(painted, newly-requested)
    \* must fit, so every later animation frame is pre-paid (dominance)
    ∧ newTarget ≠ target                               \* no stuttering requests
    ∧ target' = newTarget                              \* targets change; paint doesn't yet
    ∧ UNCHANGED ⟨c, phase, mode, want, final, emitted, alloc, history, native,
                   width, height, resizes, epoch,
                   replayMode, replayCursor, replayEnd, replayPartial,
                   replayPrepared, replayCut,
                   flush, shutdown, running, stopReason⟩  \* nothing visible happens yet

BridgeHeight(sampled, requested) ≜                     \* B(a,t): next painted height
    IF sampled < requested THEN requested               \* growth jumps straight to target;
    ELSE IF sampled > 2 ∧ requested = 1 THEN 2         \* a deep shrink (>2 -> 1) pauses at 2
    ELSE requested                                      \* all other shrinks are direct
    \* the 2-row bridge frame makes deep collapses read as contractions, not snaps

ApplyAllocation(i) ≜                                   \* one animation frame is painted
    ∧ running                                          \* host alive
    ∧ ¬shutdown                                        \* not during shutdown
    ∧ phase[i] = "Active"                              \* only active slots animate
    ∧ alloc[i] ≠ target[i]                             \* something to do
    ∧ LET nextHeight ≜ BridgeHeight(alloc[i], target[i])  \* bridged next height
           newAlloc ≜ [alloc EXCEPT ![i] = nextHeight]
       IN ∧ AllocationStateOK(newAlloc, target, phase, final, emitted, width, height)
          \* always satisfiable along a bridge: B never raises max(alloc, target)
          ∧ alloc' = newAlloc                          \* paint the frame
    ∧ UNCHANGED ⟨c, phase, mode, want, final, emitted, target, history, native,
                   width, height, resizes, epoch,
                   replayMode, replayCursor, replayEnd, replayPartial,
                   replayPrepared, replayCut,
                   flush, shutdown, running, stopReason⟩  \* repaint only

FinalizeActive(i, snapshot) ≜                          \* a live block completes
    ∧ running                                          \* host alive
    ∧ ¬shutdown                                        \* not during shutdown
    ∧ phase[i] = "Active"                              \* it was producing
    ∧ (mode[i] = "Mutable" ∨ Prefix(want[i], snapshot))  \* final must honor the contract
    ∧ LET newPhase ≜ [phase EXCEPT ![i] = "Finalized"]
           newFinal ≜ [final EXCEPT ![i] = snapshot]   \* the final value, frozen forever
           newAlloc ≜ CanonicalAllocation(newPhase, newFinal, emitted, width, height)
       IN ∧ phase' = newPhase                          \* lifecycle advances
          ∧ want' = [want EXCEPT ![i] = snapshot]      \* want converges to final
          ∧ final' = newFinal                          \* (invariant: final = want)
          ∧ alloc' = newAlloc                          \* ALL slots collapse to canonical
          ∧ target' = newAlloc                         \* 1-row previews: finished content
    ∧ UNCHANGED ⟨c, mode, emitted, history, native, width, height,  \* no longer animates
                   resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial,
                   replayPrepared, replayCut,
                   flush, shutdown, running, stopReason⟩  \* repaint only: nothing retires yet

FinalizeQueued(i, snapshot) ≜                          \* a block completes WITHOUT ever
    ∧ running                                          \* having held a slot (finished
    ∧ ¬shutdown                                        \* before space freed up)
    ∧ phase[i] = "Queued"                              \* straight from the queue
    ∧ (mode[i] = "Mutable" ∨ Prefix(want[i], snapshot))  \* same contract check
    ∧ LET newPhase ≜ [phase EXCEPT ![i] = "Finalized"]
           newWant ≜ [want EXCEPT ![i] = snapshot]
           newFinal ≜ [final EXCEPT ![i] = snapshot]
           newAlloc ≜ CanonicalAllocation(newPhase, newFinal, emitted, width, height)
       IN ∧ phase' = newPhase                          \* note: THIS transition may cause
          ∧ want' = newWant                            \* overflow (a hidden block becomes
          ∧ final' = newFinal                          \* presented) -- summarization, not
          ∧ alloc' = newAlloc                          \* denial, handles it here
          ∧ target' = newAlloc
    ∧ UNCHANGED ⟨c, mode, emitted, history, native, width, height,
                   resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial,
                   replayPrepared, replayCut,
                   flush, shutdown, running, stopReason⟩  \* repaint only

AppendStable ≜                                         \* natural streaming: ONE stable row
    ∧ running                                          \* of the append-only HEAD block
    ∧ ¬shutdown                                        \* scrolls into both histories
    ∧ ¬Replaying                                       \* never interleaves with replay
    ∧ c < CreatedCount                                 \* a head block exists
    ∧ mode[c + 1] = "AppendOnly"                       \* only append-only blocks stream
    ∧ phase[c + 1] ∈ {"Active", "Finalized"}         \* and only while live
    ∧ RowPressure                                      \* only under ROW pressure: with
    \* room to spare, stable rows stay in the viewport (still repositionable)
    ∧ emitted[c + 1] < Len(want[c + 1])                \* a stable row remains to stream
    ∧ LET next ≜ emitted[c + 1] + 1                   \* index of the row to emit
           newEmitted ≜ [emitted EXCEPT ![c + 1] = next]
           newAlloc ≜ CanonicalAllocation(phase, final, newEmitted, width, height)
       IN ∧ history' = history ∘ TagSlice(c + 1, want[c + 1], next, next)  \* ledger += 1 semantic row
          ∧ native' =
                 native
                 ∘ NativeTagSlice("Append", c + 1, want[c + 1], next, next, width)
          \* native += the same row, rendered (1 or 2 physical rows), tagged Append
          ∧ emitted' = newEmitted                      \* the stable frontier advances
          ∧ alloc' = newAlloc                          \* layout recanonicalizes (the
          ∧ target' = newAlloc                         \* streamed row left the viewport)
    ∧ UNCHANGED ⟨c, phase, mode, want, final,
                   width, height, resizes, epoch,
                   replayMode, replayCursor, replayEnd, replayPartial,
                   replayPrepared, replayCut,
                   flush, shutdown, running, stopReason⟩  \* frontier c itself does not move

CompleteAppendOnly ≜                                   \* the fully-streamed head commits
    ∧ running                                          \* host alive
    \* (deliberately NO ~shutdown: draining the head stays possible while
    \*  shutting down)
    ∧ ¬Replaying                                       \* never during replay
    ∧ c < CreatedCount                                 \* head exists
    ∧ mode[c + 1] = "AppendOnly"                       \* head is append-only
    ∧ phase[c + 1] = "Finalized"                       \* head is done
    ∧ emitted[c + 1] = Len(final[c + 1])               \* every row already streamed
    ∧ LET newPhase ≜ [phase EXCEPT ![c + 1] = "Committed"]
           newEmitted ≜ [emitted EXCEPT ![c + 1] = 0]  \* emitted counter retires with it
           newAlloc ≜ CanonicalAllocation(newPhase, final, newEmitted, width, height)
       IN ∧ c' = c + 1                                 \* frontier advances: PURE
          ∧ phase' = newPhase                          \* bookkeeping -- every row is
          ∧ emitted' = newEmitted                      \* already in both histories,
          ∧ alloc' = newAlloc                          \* so nothing is written
          ∧ target' = newAlloc
    ∧ UNCHANGED ⟨mode, want, final, history, native, width, height,
                   resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial,
                   replayPrepared, replayCut,
                   flush, shutdown, running, stopReason⟩  \* note: history unchanged!

BeginFlush ≜                                           \* someone asks for full retirement
    ∧ running                                          \* host alive
    ∧ ¬flush                                           \* idempotent: set once,
    ∧ flush' = TRUE                                    \* never reset
    ∧ UNCHANGED ⟨c, phase, mode, want, final, emitted, alloc, target,
                   history, native, width, height, resizes, epoch,
                   replayMode, replayCursor, replayEnd, replayPartial,
                   replayPrepared, replayCut,
                   shutdown, running, stopReason⟩      \* a pure request: no effect yet

RetireSuccess(batchEnd) ≜                              \* in-order retirement of a batch
    ∧ running                                          \* host alive
    ∧ ¬Replaying                                       \* never during replay
    ∧ batchEnd ∈ (c + 1)‥N                          \* batch = blocks c+1 .. batchEnd
    ∧ FinalizedRange(c + 1, batchEnd)                  \* ... ALL of them finalized
    ∧ RetirementRequested                              \* only under flush or pressure
    ∧ history' =
           history ∘ RetirementRows(c + 1, batchEnd, final, emitted[c + 1])
    \* ledger += head's unstreamed suffix, then later finals in full
    \* (emitted[c+1] is the only possibly-nonzero emitted counter)
    ∧ native' =
           native
           ∘ NativeRetirementRows(                     \* native += the same rows,
                  "Retire",                             \* tagged Retire, rendered at
                  c + 1,                                \* the current width; realized
                  batchEnd,                             \* on a real terminal as ONE
                  final,                                \* streamed write (paper,
                  emitted[c + 1],                       \* Lemma "streaming
                  width                                 \* realization")
              )
    ∧ LET newPhase ≜ [i ∈ Blocks ↦
                            IF i ≤ batchEnd THEN "Committed" ELSE phase[i]]  \* batch commits
           newEmitted ≜ [i ∈ Blocks ↦
                              IF i ≤ batchEnd THEN 0 ELSE emitted[i]]  \* counters reset
           newAlloc ≜ CanonicalAllocation(newPhase, final, newEmitted, width, height)
       IN ∧ c' = batchEnd                              \* frontier jumps to batch end
          ∧ phase' = newPhase
          ∧ emitted' = newEmitted
          ∧ alloc' = newAlloc                          \* retired slots disappear;
          ∧ target' = newAlloc                         \* survivors recanonicalize
    ∧ UNCHANGED ⟨mode, want, final, width, height, resizes, epoch,
                   replayMode, replayCursor, replayEnd, replayPartial,
                   replayPrepared, replayCut,
                   flush, shutdown, running, stopReason⟩  \* finals themselves are untouched

RetireFailure(batchEnd, count) ≜                       \* the SAME write, torn partway:
    ∧ running                                          \* same enabling conditions
    ∧ ¬Replaying                                       \* as RetireSuccess ...
    ∧ batchEnd ∈ (c + 1)‥N
    ∧ FinalizedRange(c + 1, batchEnd)
    ∧ RetirementRequested
    ∧ LET rows ≜
              NativeRetirementRows(                     \* the batch that WOULD have
                  "FailedWrite",                        \* been written, tagged
                  c + 1,                                \* FailedWrite for forensics
                  batchEnd,
                  final,
                  emitted[c + 1],
                  width
              )
       IN ∧ count ∈ 0‥Len(rows)                     \* the terminal accepted `count`
          ∧ native' = native ∘ PrefixOf(rows, count)  \* rows: an arbitrary PREFIX --
          \* never reordered, never a row from outside the batch
    ∧ running' = FALSE                                 \* fail-stop: the host halts;
    ∧ stopReason' = "WriteFailure"                     \* no retry path exists, so
    ∧ UNCHANGED ⟨c, phase, mode, want, final, emitted, alloc, target, history,
                   width, height, resizes, epoch,
                   replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, flush, shutdown⟩
    \* CRITICAL: c and history do NOT advance -- the ledger never lies about
    \* what committed, so duplication/reordering after failure is impossible

Resize(newWidth, newHeight, resizePolicy, pushed) ≜    \* terminal geometry changes
    ∧ running                                          \* host alive
    ∧ ¬shutdown                                        \* not during shutdown
    ∧ resizes < MaxResizes                             \* bounded (finite model)
    ∧ newWidth ∈ WidthValues                         \* new geometry and the
    ∧ newHeight ∈ 0‥H                               \* policy for native history
    ∧ resizePolicy ∈ ResizeModes
    ∧ newWidth ≠ width ∨ newHeight ≠ height           \* an actual change
    ∧ pushed ∈ 0‥Len(Screen)                        \* emulator may scroll 0..h top
    \* viewport rows into scrollback during the resize (e.g. height shrink)
    ∧ LET widthChanged ≜ newWidth ≠ width
           effectiveMode ≜ IF widthChanged THEN resizePolicy ELSE "Preserve"
           \* height-only resizes never replay: rendered rows are still valid
           pushedRows ≜ NativeCells("Resize", PrefixOf(Screen, pushed), width)
           \* rows pushed by the emulator, tagged Resize, at the OLD width
           beginReplay ≜ effectiveMode ≠ "Preserve" ∧ (c > 0 ∨ PartialHeadExists)
           \* replay only if there is committed/streamed content to re-render
           newPhase ≜ phase                            \* lifecycle is untouched
           newAlloc ≜ CanonicalAllocation(newPhase, final, emitted, newWidth, newHeight)
       IN ∧ width' = newWidth                          \* adopt the new geometry
          ∧ height' = newHeight
          ∧ resizes' = resizes + 1                     \* burn one resize budget
          ∧ alloc' = newAlloc                          \* layout recanonicalizes at
          ∧ target' = newAlloc                         \* the new geometry
          ∧ native' = IF effectiveMode = "Rebuild"
                        THEN ⟨⟩                       \* Rebuild: native display is wiped ...
                        ELSE native ∘ pushedRows       \* else: record what the emulator pushed
          ∧ epoch' = IF effectiveMode = "Rebuild" THEN epoch + 1 ELSE epoch
          \* ... and the display epoch increments (native monotonicity is epoch-scoped)
          ∧ replayMode' =
                 IF beginReplay THEN effectiveMode      \* start a replay,
                 ELSE IF Replaying THEN replayMode ELSE "None"  \* or keep/clear the old one
          ∧ replayCursor' =
                 IF beginReplay THEN 1                  \* replay window = committed
                 ELSE IF Replaying THEN replayCursor ELSE 0     \* blocks 1..c
          ∧ replayEnd' =
                 IF beginReplay THEN c
                 ELSE IF Replaying THEN replayEnd ELSE 0
          ∧ replayPartial' =
                 IF beginReplay
                 THEN IF PartialHeadExists THEN emitted[c + 1] ELSE 0  \* plus the streamed head prefix
                 ELSE IF Replaying THEN replayPartial ELSE 0
          ∧ replayPrepared' = FALSE                    \* ANY resize invalidates a
          ∧ replayCut' = 0                             \* previously prepared frame
    ∧ UNCHANGED ⟨c, phase, mode, want, final, emitted, history,
                   flush, shutdown, running, stopReason⟩
    \* resize logical-neutrality: ledger, frontier, and semantics never move

PrepareReplay ≜                                        \* compute the replay frame
    ∧ running                                          \* host alive
    ∧ Replaying                                        \* a replay is pending
    ∧ ¬replayPrepared                                  \* and not yet prepared
    ∧ replayPrepared' = TRUE                           \* freeze the frame NOW:
    ∧ replayCut' = RequiredReplayCut                   \* cut = rows that must scroll
    \* from here the scheduler gate (see Next) admits ONLY the two replay
    \* writes, so the sampled cut cannot be invalidated by interleaving
    ∧ UNCHANGED ⟨c, phase, mode, want, final, emitted, alloc, target,
                   history, native, width, height, resizes, epoch,
                   replayMode, replayCursor, replayEnd, replayPartial,
                   flush, shutdown, running, stopReason⟩  \* pure computation: no write yet

ReplaySynchronousSuccess ≜                             \* the single buffered write lands
    ∧ running                                          \* host alive
    ∧ Replaying                                        \* replay pending
    ∧ replayPrepared                                   \* frame prepared (gate open)
    ∧ native' = native ∘ PrefixOf(ReplayRows, replayCut)  \* exactly `cut` rows scroll into
    \* native; the tail was painted into blank rows (no scroll, no history)
    ∧ replayMode' = "None"                             \* replay fully drains:
    ∧ replayCursor' = 0                                \* all replay state returns
    ∧ replayEnd' = 0                                   \* to its idle shape
    ∧ replayPartial' = 0
    ∧ replayPrepared' = FALSE
    ∧ replayCut' = 0
    ∧ UNCHANGED ⟨c, phase, mode, want, final, emitted, alloc, target,
                   history, width, height, resizes, epoch,
                   flush, shutdown, running, stopReason⟩  \* logically neutral: ledger untouched

ReplaySynchronousFailure(count) ≜                      \* the same write, torn partway
    ∧ running                                          \* host alive
    ∧ Replaying                                        \* replay pending
    ∧ replayPrepared                                   \* frame prepared
    ∧ count ∈ 0‥replayCut                           \* an arbitrary prefix of the
    ∧ native' = native ∘ PrefixOf(ReplayRows, count)  \* scrolled portion landed
    ∧ running' = FALSE                                 \* fail-stop, as with
    ∧ stopReason' = "WriteFailure"                     \* RetireFailure: halt, no retry
    ∧ UNCHANGED ⟨c, phase, mode, want, final, emitted, alloc, target, history,
                   width, height, resizes, epoch,
                   replayMode, replayCursor, replayEnd, replayPartial,
                   replayPrepared, replayCut,
                   flush, shutdown⟩                    \* ledger and frontier still truthful

BeginGracefulShutdown ≜                                \* wind-down begins
    ∧ running                                          \* host alive
    ∧ ¬shutdown                                        \* only once
    ∧ LET newPhase ≜ [i ∈ Blocks ↦
                            IF phase[i] = "Absent" THEN "Absent"     \* never-created stay absent;
                            ELSE IF i ≤ c THEN "Committed" ELSE "Finalized"]  \* all live work freezes
           newFinal ≜ [i ∈ Blocks ↦
                            IF phase[i] = "Absent" THEN NoFinal      \* absent: still no final;
                            ELSE IF i ≤ c ∨ phase[i] = "Finalized"
                            THEN final[i]               \* already-frozen finals kept;
                            ELSE want[i]]               \* queued/active freeze AT their
           newAlloc ≜ CanonicalAllocation(newPhase, newFinal, emitted, width, height)
       IN ∧ phase' = newPhase                          \* current speculation (f := w)
          ∧ final' = newFinal
          ∧ alloc' = newAlloc                          \* layout collapses to canonical
          ∧ target' = newAlloc
    ∧ flush' = TRUE                                    \* permanent flush: everything
    ∧ shutdown' = TRUE                                 \* must drain, then exit
    ∧ UNCHANGED ⟨c, mode, want, emitted, history, native, width, height,
                   resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial,
                   replayPrepared, replayCut,
                   running, stopReason⟩                \* nothing retires in this step itself

GracefulExit(push) ≜                                   \* clean exit after full drain
    ∧ running                                          \* host alive
    ∧ shutdown                                         \* shutdown was initiated,
    ∧ ¬Replaying                                       \* replay has drained,
    ∧ c = CreatedCount                                 \* and EVERY block committed
    ∧ push ∈ 0‥1                                    \* optionally scroll one last row
    ∧ push = 0 ∨ height > 0                           \* (only if a viewport row exists)
    ∧ running' = FALSE                                 \* host stops
    ∧ stopReason' = "Graceful"                         \* ... cleanly
    ∧ native' = IF push = 0
                 THEN native                            \* either no final scroll, or the
                 ELSE native ∘ NativeCells("Exit", ⟨Screen[1]⟩, width)
                 \* top viewport row scrolls out (restoring the shell prompt),
                 \* tagged Exit
    ∧ UNCHANGED ⟨c, phase, mode, want, final, emitted, alloc, target, history,
                   width, height, resizes, epoch,
                   replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, flush, shutdown⟩

DetachExit(push) ≜                                     \* abandon ship: exit NOW,
    ∧ running                                          \* uncommitted work is dropped
    ∧ ¬shutdown                                        \* (a detach, not a shutdown)
    ∧ push ∈ 0‥1                                    \* same optional final scroll
    ∧ push = 0 ∨ height > 0
    ∧ running' = FALSE                                 \* host stops
    ∧ stopReason' = "Detach"
    ∧ native' = IF push = 0
                 THEN native
                 ELSE native ∘ NativeCells("Exit", ⟨Screen[1]⟩, width)
    ∧ UNCHANGED ⟨c, phase, mode, want, final, emitted, alloc, target, history,
                   width, height, resizes, epoch,
                   replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, flush, shutdown⟩
    \* ECH guarantees `history` holds exactly the committed content at detach

\* -------------------------------------------------------------------------
\* Existentially closed action wrappers (for fairness and Next).
\* -------------------------------------------------------------------------
RetireSuccessAction ≜ ∃ batchEnd ∈ Blocks : RetireSuccess(batchEnd)  \* some batch retires
RetireFailureAction ≜                                  \* some batch write fails at
    ∃ batchEnd ∈ Blocks :                            \* some prefix length
        ∃ count ∈ 0‥MaxFailureRows : RetireFailure(batchEnd, count)
ReplaySynchronousFailureAction ≜                       \* replay write fails at some
    ∃ count ∈ 0‥MaxFailureRows : ReplaySynchronousFailure(count)  \* prefix length

\* -------------------------------------------------------------------------
\* The scheduler gate: once a replay frame is prepared, the ONLY possible
\* steps are the replay write landing or failing. This is what the word
\* "synchronous" means, and it is what keeps replayCut = RequiredReplayCut
\* stable (nothing may repaint in between).
\* -------------------------------------------------------------------------
Next ≜
    IF replayPrepared
    THEN ReplaySynchronousSuccess ∨ ReplaySynchronousFailureAction  \* gate closed: write or die
    ELSE ∨ ∃ declaration ∈ {"Mutable", "AppendOnly"} : Create(declaration)  \* gate open:
         ∨ ∃ i ∈ Blocks : Admit(i)                                          \* any protocol
         ∨ ∃ i ∈ Blocks, snapshot ∈ SnapshotValues : Update(i, snapshot)  \* step may fire
         ∨ ∃ newTarget ∈ [Blocks → 0‥H] : RequestAllocation(newTarget)
         ∨ ∃ i ∈ Blocks : ApplyAllocation(i)
         ∨ ∃ i ∈ Blocks, snapshot ∈ SnapshotValues : FinalizeActive(i, snapshot)
         ∨ ∃ i ∈ Blocks, snapshot ∈ SnapshotValues : FinalizeQueued(i, snapshot)
         ∨ AppendStable
         ∨ CompleteAppendOnly
         ∨ BeginFlush
         ∨ RetireSuccessAction
         ∨ RetireFailureAction
         ∨ ∃ newWidth ∈ WidthValues, newHeight ∈ 0‥H,
               resizePolicy ∈ ResizeModes, pushed ∈ 0‥H :
                Resize(newWidth, newHeight, resizePolicy, pushed)
         ∨ PrepareReplay
         ∨ BeginGracefulShutdown
         ∨ ∃ push ∈ 0‥1 : GracefulExit(push)
         ∨ ∃ push ∈ 0‥1 : DetachExit(push)

Spec ≜
    ∧ Init                                             \* start in the initial state,
    ∧ □[Next]_vars                                    \* take Next steps (or stutter),
    ∧ WF_vars(RetireSuccessAction)                     \* and don't ignore forever:
    ∧ WF_vars(PrepareReplay)                           \* retirement, replay preparation,
    ∧ WF_vars(ReplaySynchronousSuccess)                \* the replay write,
    ∧ WF_vars(AppendStable)                            \* head streaming,
    ∧ WF_vars(CompleteAppendOnly)                      \* and head commitment.
    \* Weak fairness: an action enabled forever is eventually taken. Failures
    \* and exits are NOT fair -- they may happen, but are never forced.

\* =========================================================================
\* Invariants (checked by TLC in every reachable state).
\* =========================================================================

TypeOK ≜                                               \* T: every variable in range
    ∧ c ∈ 0‥N                                       \* frontier within block ids
    ∧ phase ∈ [Blocks → Phases]                     \* valid phase per block
    ∧ mode ∈ [Blocks → BlockModes]                  \* valid mode per block
    ∧ want ∈ [Blocks → SnapshotValues]              \* speculation from the universe
    ∧ final ∈ [Blocks → SnapshotValues ∪ {NoFinal}]  \* final or the sentinel
    ∧ emitted ∈ [Blocks → 0‥MaxSnapshotLength]     \* emitted counter bounded
    ∧ alloc ∈ [Blocks → 0‥H]                       \* painted heights bounded
    ∧ target ∈ [Blocks → 0‥H]                      \* requested heights bounded
    ∧ history ∈ Seq(TaggedRows)                      \* ledger rows well-formed
    ∧ native ∈ Seq(NativeRows)                       \* native rows well-formed
    ∧ width ∈ WidthValues                            \* geometry in range
    ∧ height ∈ 0‥H
    ∧ resizes ∈ 0‥MaxResizes                        \* resize budget respected
    ∧ epoch ∈ 0‥MaxResizes                          \* epochs only at resizes
    ∧ replayMode ∈ ReplayModes                       \* replay state in range
    ∧ replayCursor ∈ 0‥(N + 1)                      \* (loose bound; really 0 or 1)
    ∧ replayEnd ∈ 0‥N
    ∧ replayPartial ∈ 0‥MaxSnapshotLength
    ∧ replayPrepared ∈ BOOLEAN
    ∧ replayCut ∈ 0‥MaxFailureRows                  \* cut bounded by max batch size
    ∧ flush ∈ BOOLEAN
    ∧ shutdown ∈ BOOLEAN
    ∧ running ∈ BOOLEAN
    ∧ stopReason ∈ StopReasons

LifecycleShape ≜                                       \* LS: blocks form three bands --
    ∧ c ≤ CreatedCount                                \* can't commit the uncreated
    ∧ ∀ i ∈ 1‥c :                                  \* band 1: 1..c
           ∧ phase[i] = "Committed"                    \* all committed,
           ∧ mode[i] ∈ {"Mutable", "AppendOnly"}     \* with a declared mode
    ∧ ∀ i ∈ (c + 1)‥CreatedCount :                 \* band 2: live blocks
           ∧ phase[i] ∈ {"Queued", "Active", "Finalized"}
           ∧ mode[i] ∈ {"Mutable", "AppendOnly"}
    ∧ ∀ i ∈ (CreatedCount + 1)‥N :                 \* band 3: not yet created
           ∧ phase[i] = "Absent"
           ∧ mode[i] = "Undeclared"

SnapshotDiscipline ≜                                   \* SD: finals exist exactly for
    ∀ i ∈ Blocks :                                   \* finalized/committed blocks,
        IF phase[i] ∈ {"Finalized", "Committed"}
        THEN ∧ final[i] ∈ SnapshotValues             \* are real snapshots,
             ∧ final[i] = want[i]                      \* and equal the last speculation
        ELSE final[i] = NoFinal                         \* everyone else: the sentinel

EmissionDiscipline ≜                                   \* ED: streaming is head-only --
    ∧ ∀ i ∈ Blocks :
           ∧ emitted[i] ≤ Len(want[i])                \* never emitted more than exists
           ∧ (mode[i] ≠ "AppendOnly" ⇒ emitted[i] = 0)  \* mutable blocks never stream
           ∧ (emitted[i] > 0 ⇒
                  ∧ i = c + 1                          \* only the HEAD may have
                  ∧ phase[i] ∈ {"Active", "Finalized"})  \* streamed rows, and only live
    ∧ (PartialHeadExists ⇒ emitted[c + 1] ≤ Len(want[c + 1]))  \* (redundant safety belt)

Capacity ≜ AllocationStateOK(alloc, target, phase, final, emitted, width, height)
\* CAP: the reservation invariant holds of the ACTUAL alloc/target at all times

ExactCommittedHistory ≜ history = CommittedRows(c, final) ∘ PartialHeadRows
\* ECH, the central equation: the ledger IS the committed finals in block
\* order, plus the head's streamed prefix -- no dupes, no gaps, no reorders

NoPrematureHistory ≜                                   \* every ledger row is owned by
    ∀ j ∈ 1‥Len(history) :
        LET owner ≜ history[j].owner IN
        ∨ ∧ owner ∈ 1‥c                            \* a committed block, or
         ∧ phase[owner] = "Committed"
        ∨ ∧ PartialHeadExists                         \* the streaming head --
         ∧ owner = c + 1                              \* speculation NEVER leaks

ScreenCapacity ≜                                       \* the screen is exactly right:
    ∧ Screen ∈ Seq(Cells)                            \* well-formed cells,
    ∧ Len(Screen) = height                             \* exactly `height` of them,
    ∧ ∀ i ∈ Blocks :
           Cardinality({j ∈ 1‥height : Screen[j].owner = i}) = alloc[i]  \* each block owns alloc[i] rows,
    ∧ Cardinality({j ∈ 1‥height : Screen[j] = OverflowCell})
       = SummaryRows(phase, final, emitted, width, height)  \* the summary row appears iff overflowing,
    ∧ Cardinality({j ∈ 1‥height : Screen[j] = BlankCell})
       = height - AllocationTotal(alloc, 1)
         - SummaryRows(phase, final, emitted, width, height)  \* the rest is blank -- accounts balance

ReplayShape ≜                                          \* RS: replay bookkeeping is sane
    ∧ (replayMode = "None" ⇒                          \* idle: all replay state zeroed
           ∧ replayCursor = 0
           ∧ replayEnd = 0
                     ∧ replayPartial = 0
          ∧ ¬replayPrepared
          ∧ replayCut = 0)
    ∧ (replayMode ≠ "None" ⇒                          \* in flight: window is 1..replayEnd
                     ∧ replayCursor = 1
           ∧ replayEnd ∈ 0‥c                        \* over COMMITTED blocks only,
                     ∧ replayPartial ≤ MaxSnapshotLength
          ∧ IF replayPrepared
             THEN ∧ replayCut = RequiredReplayCut      \* prepared: the sampled cut is
                  ∧ Len(PreparedReplayTail) ≤ ReplayRoom  \* still exact (the gate!) and
             ELSE replayCut = 0)                        \* the tail fits the blank region

NativeSourceSafety ≜                                   \* NSS: provenance never lies --
    ∀ j ∈ 1‥Len(native) :
        LET owner ≜ native[j].owner IN
        ∧ (native[j].source = "Retire" ⇒              \* Retire rows: from blocks that
               ∧ owner ∈ 1‥c                        \* really are committed
               ∧ phase[owner] = "Committed")
        ∧ (native[j].source ∈ {"Append", "Replay"} ⇒  \* streamed/replayed rows: from
               ∧ owner ∈ Blocks                        \* committed blocks or the
               ∧ (∨ owner ∈ 1‥c                      \* append-only head -- never
                  ∨ ∧ owner = c + 1                    \* from mutable speculation
                    ∧ mode[owner] = "AppendOnly"))
        ∧ (native[j].source = "FailedWrite" ⇒ stopReason = "WriteFailure")  \* failure rows only after failing
        ∧ (native[j].source = "Exit" ⇒ ¬running)      \* exit rows only after exiting

\* =========================================================================
\* Temporal (action and liveness) properties.
\* =========================================================================

HistoryExtension ≜ Prefix(history, history')           \* one step never rewrites the ledger
HistoryMonotonicity ≜ □[HistoryExtension]_vars        \* ... in ANY step: append-only forever

NativeEpochStep ≜                                      \* per step, native either
    IF epoch' = epoch
    THEN Prefix(native, native')                        \* grows at the end (same epoch)
    ELSE ∧ epoch' = epoch + 1                          \* or is wiped exactly when the
         ∧ native' = ⟨⟩                              \* epoch increments (Rebuild)
NativeEpochDiscipline ≜ □[NativeEpochStep]_vars       \* holds of every step

FinalsStayFixed ≜                                      \* finals are immutable:
    ∀ i ∈ Blocks :
        phase[i] ∈ {"Finalized", "Committed"} ⇒ final'[i] = final[i]
FinalImmutability ≜ □[FinalsStayFixed]_vars           \* once frozen, frozen forever

AppendOnlyPrefixStep ≜                                 \* the append-only contract as
    ∀ i ∈ Blocks :                                   \* an action property:
        (mode[i] = "AppendOnly" ∧ phase[i] ∈ {"Queued", "Active"})
        ⇒ Prefix(want[i], want'[i])                    \* want only ever extends
AppendOnlyMonotonicity ≜ □[AppendOnlyPrefixStep]_vars

ResizeKeepsLogicalHistoryStep ≜                        \* resize logical-neutrality:
    (width' ≠ width ∨ height' ≠ height) ⇒             \* a geometry change moves
        ∧ history' = history                           \* NONE of the semantic state --
        ∧ c' = c                                       \* not the ledger, not the
        ∧ mode' = mode                                 \* frontier, not modes,
        ∧ want' = want                                 \* speculation,
        ∧ final' = final                               \* finals,
        ∧ emitted' = emitted                           \* or streamed counters
ResizeKeepsLogicalHistory ≜ □[ResizeKeepsLogicalHistoryStep]_vars

FailedWriteStops ≜ □(                                 \* fail-stop: a write failure
    stopReason = "WriteFailure" ⇒ ¬running             \* and a live host never coexist
)

StoppedStep ≜ ¬running ⇒ UNCHANGED vars               \* a stopped host is frozen:
StoppedQuiescence ≜ □[StoppedStep]_vars               \* every later step stutters

AllFinalized ≜                                         \* every created block is done
    ∀ i ∈ 1‥CreatedCount : phase[i] ∈ {"Finalized", "Committed"}
AllCommitted ≜                                         \* everything retired, and the
    ∧ c = CreatedCount                                 \* ledger is exactly the
    ∧ history = CommittedRows(c, final)                \* committed finals

FlushLiveness ≜                                        \* drain guarantee: finalized +
    (AllFinalized ∧ flush ∧ shutdown ∧ running ∧ ¬Replaying)  \* flushing + shutting down
    ↝ (AllCommitted ∨ ¬running)                       \* eventually fully commits (or halts)

ReplayLiveness ≜ (Replaying ∧ running) ↝ (¬Replaying ∨ ¬running)
\* every replay eventually drains (or the host halts trying)

QueuedDemand ≜ ∃ i ∈ Blocks : phase[i] = "Queued"   \* someone is waiting for space
QueuedPressureRetirement ≜                             \* pressure + queued demand
    ∀ i ∈ Blocks :                                   \* eventually sweeps a finalized
        (∧ running                                     \* head block into history:
         ∧ ¬Replaying
         ∧ c = i - 1                                   \* i is the head,
         ∧ phase[i] = "Finalized"                      \* it is done,
         ∧ Pressure                                    \* space is scarce,
         ∧ QueuedDemand)                               \* and someone needs it
        ↝ (c ≥ i ∨ ¬running)                         \* => i eventually commits (or halt)
    \* NB: this needs MaxLive small enough that queued demand implies
    \* PERSISTENT count pressure; pure row pressure alone can evaporate
    \* (see the paper's sharpness remark)

====
