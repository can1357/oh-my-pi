---- MODULE ElasticSlotsPlusCal ----
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS N, H, MaxResizes, MaxLive, RowValues, SnapshotValues,
          NoFinal, Placeholder, Blank, OverflowMarker

ASSUME
    /\ N \in Nat \ {0}
    /\ H \in Nat \ {0}
    /\ MaxResizes \in Nat
    /\ MaxLive \in Nat \ {0}
    /\ IsFiniteSet(RowValues)
    /\ RowValues # {}
    /\ IsFiniteSet(SnapshotValues)
    /\ SnapshotValues \subseteq Seq(RowValues)
    /\ <<>> \in SnapshotValues
    /\ (\E snapshot \in SnapshotValues : Len(snapshot) = 1)
    /\ (\E snapshot \in SnapshotValues : Len(snapshot) > 1)
    /\ NoFinal \notin SnapshotValues
    /\ Placeholder \notin RowValues
    /\ Blank \notin RowValues
    /\ OverflowMarker \notin RowValues
    /\ Placeholder # Blank
    /\ Placeholder # OverflowMarker
    /\ Blank # OverflowMarker

Blocks == 1..N
ModelRows == {"row-a", "row-b"}
ModelSnapshots ==
    {<<>>,
     <<"row-a">>,
     <<"row-b">>,
     <<"row-a", "row-b">>,
     <<"row-b", "row-a">>,
     <<"row-a", "row-b", "row-a">>}
SmallModelSnapshots == {<<>>, <<"row-a">>, <<"row-a", "row-b">>}

WidthValues == {"Wide", "Narrow"}
ResizeModes == {"Preserve", "Append", "Rebuild"}
ReplayModes == {"None", "Append", "Rebuild"}
BlockModes == {"Undeclared", "Mutable", "AppendOnly"}
Phases == {"Absent", "Queued", "Active", "Finalized", "Committed"}
StopReasons == {"Running", "Graceful", "Detach", "WriteFailure"}
NativeSources == {"Append", "Retire", "Replay", "Resize", "FailedWrite", "Exit"}
CellRows == RowValues \cup {Placeholder, Blank, OverflowMarker}
Cells == [owner : 0..N, row : CellRows]
TaggedRows == [owner : Blocks, row : RowValues]
NativeRows == [source : NativeSources, owner : 0..N, row : CellRows, width : WidthValues]

SnapshotLengths == {Len(snapshot) : snapshot \in SnapshotValues}
MaxSnapshotLength ==
    CHOOSE maximum \in SnapshotLengths :
        \A length \in SnapshotLengths : length <= maximum
MaxFailureRows == 2 * N * MaxSnapshotLength

BlankCell == [owner |-> 0, row |-> Blank]
OverflowCell == [owner |-> 0, row |-> OverflowMarker]

(* --algorithm ElasticSlotsC {
variables
  c = 0,
  phase = [i \in Blocks |-> "Absent"],
  mode = [i \in Blocks |-> "Undeclared"],
  want = [i \in Blocks |-> <<>>],
  final = [i \in Blocks |-> NoFinal],
  emitted = [i \in Blocks |-> 0],
  alloc = [i \in Blocks |-> 0],
  target = [i \in Blocks |-> 0],
  history = <<>>,
  native = <<>>,
  width = "Wide",
  height = H,
  resizes = 0,
  epoch = 0,
  replayMode = "None",
  replayCursor = 0,
  replayEnd = 0,
  replayPartial = 0,
  replayPrepared = FALSE,
  replayCut = 0,
  flush = FALSE,
  shutdown = FALSE,
  running = TRUE,
  stopReason = "Running";

define {
  Maximum(left, right) == IF left >= right THEN left ELSE right

  RECURSIVE DoubleRows(_)
  DoubleRows(snapshot) ==
      IF Len(snapshot) = 0 THEN <<>>
      ELSE <<Head(snapshot), Head(snapshot)>> \o DoubleRows(Tail(snapshot))

  Render(snapshot, wx) == IF wx = "Wide" THEN snapshot ELSE DoubleRows(snapshot)

  Tag(i, snapshot) ==
      [j \in 1..Len(snapshot) |-> [owner |-> i, row |-> snapshot[j]]]

  SnapshotSlice(snapshot, lo, hi) ==
      IF lo > hi THEN <<>> ELSE SubSeq(snapshot, lo, hi)

  TagSlice(i, snapshot, lo, hi) == Tag(i, SnapshotSlice(snapshot, lo, hi))

  NativeTag(source, i, snapshot, wx) ==
      [j \in 1..Len(Render(snapshot, wx)) |->
          [source |-> source, owner |-> i,
           row |-> Render(snapshot, wx)[j], width |-> wx]]
  NativeTagSlice(source, i, snapshot, lo, hi, wx) ==
      NativeTag(source, i, SnapshotSlice(snapshot, lo, hi), wx)

  NativeCells(source, cells, wx) ==
      [j \in 1..Len(cells) |->
          [source |-> source, owner |-> cells[j].owner,
           row |-> cells[j].row, width |-> wx]]

  PrefixOf(sequence, count) == [j \in 1..count |-> sequence[j]]

  RECURSIVE CommittedRows(_, _)
  CommittedRows(k, finals) ==
      IF k = 0 THEN <<>>
      ELSE CommittedRows(k - 1, finals) \o Tag(k, finals[k])

  RECURSIVE TaggedRange(_, _, _)
  TaggedRange(lo, hi, finals) ==
      IF lo > hi THEN <<>>
      ELSE Tag(lo, finals[lo]) \o TaggedRange(lo + 1, hi, finals)

  RECURSIVE NativeRange(_, _, _, _, _)
  NativeRange(source, lo, hi, finals, wx) ==
      IF lo > hi THEN <<>>
      ELSE NativeTag(source, lo, finals[lo], wx)
           \o NativeRange(source, lo + 1, hi, finals, wx)

  RetirementRows(lo, hi, finals, firstEmitted) ==
      IF lo > hi THEN <<>>
      ELSE TagSlice(lo, finals[lo], firstEmitted + 1, Len(finals[lo]))
           \o TaggedRange(lo + 1, hi, finals)

  NativeRetirementRows(source, lo, hi, finals, firstEmitted, wx) ==
      IF lo > hi THEN <<>>
      ELSE NativeTagSlice(
               source,
               lo,
               finals[lo],
               firstEmitted + 1,
               Len(finals[lo]),
               wx
           )
           \o NativeRange(source, lo + 1, hi, finals, wx)

  FinalizedRange(lo, hi) ==
      \A i \in lo..hi : phase[i] = "Finalized"

  Unemitted(snapshot, i, emission) ==
      IF mode[i] = "AppendOnly"
      THEN SnapshotSlice(snapshot, emission[i] + 1, Len(snapshot))
      ELSE snapshot

  Presented(ph, finals, emission, i, wx) ==
      \/ ph[i] = "Active"
      \/ /\ ph[i] = "Finalized"
         /\ Len(Render(Unemitted(finals[i], i, emission), wx)) > 0

  PresentedSet(ph, finals, emission, wx) ==
      {i \in Blocks : Presented(ph, finals, emission, i, wx)}
  PresentedCount(ph, finals, emission, wx) ==
      Cardinality(PresentedSet(ph, finals, emission, wx))
  Overflow(ph, finals, emission, wx, hx) ==
      PresentedCount(ph, finals, emission, wx) > hx
  SummaryRows(ph, finals, emission, wx, hx) ==
      IF hx > 0 /\ Overflow(ph, finals, emission, wx, hx) THEN 1 ELSE 0

  NewerPresented(ph, finals, emission, wx, i) ==
      Cardinality({
          j \in Blocks :
              j > i /\ Presented(ph, finals, emission, j, wx)
      })

  VisiblePresented(ph, finals, emission, wx, hx, i) ==
      /\ Presented(ph, finals, emission, i, wx)
      /\ IF Overflow(ph, finals, emission, wx, hx)
         THEN /\ hx > 0
              /\ NewerPresented(ph, finals, emission, wx, i) < hx - 1
         ELSE TRUE

  RECURSIVE AllocationTotal(_, _)
  AllocationTotal(al, i) ==
      IF i > N THEN 0 ELSE al[i] + AllocationTotal(al, i + 1)

  RECURSIVE ReservationTotal(_, _, _)
  ReservationTotal(al, requested, i) ==
      IF i > N THEN 0
      ELSE Maximum(al[i], requested[i]) + ReservationTotal(al, requested, i + 1)

  AllocationStateOK(al, requested, ph, finals, emission, wx, hx) ==
      /\ al \in [Blocks -> 0..H]
      /\ requested \in [Blocks -> 0..H]
      /\ \A i \in Blocks :
             IF VisiblePresented(ph, finals, emission, wx, hx, i)
             THEN IF ph[i] = "Active"
                  THEN /\ al[i] \in 1..H
                       /\ requested[i] \in 1..H
                  ELSE /\ al[i] \in 1..H
                       /\ requested[i] = al[i]
             ELSE /\ al[i] = 0
                  /\ requested[i] = 0
      /\ ReservationTotal(al, requested, 1)
         + SummaryRows(ph, finals, emission, wx, hx) <= hx

  CanonicalAllocation(ph, finals, emission, wx, hx) ==
      [i \in Blocks |->
          IF VisiblePresented(ph, finals, emission, wx, hx, i) THEN 1 ELSE 0]

  SnapshotHeight(ph, wants, finals, i, wx) ==
      CASE ph[i] = "Active" ->
               Maximum(1, Len(Render(Unemitted(wants[i], i, emitted), wx)))
        [] ph[i] = "Queued" ->
               Maximum(1, Len(Render(Unemitted(wants[i], i, emitted), wx)))
        [] ph[i] = "Finalized" ->
               Len(Render(Unemitted(finals[i], i, emitted), wx))
        [] OTHER -> 0

  RECURSIVE FullRows(_, _, _, _, _)
  FullRows(ph, wants, finals, wx, i) ==
      IF i > N THEN 0
      ELSE SnapshotHeight(ph, wants, finals, i, wx)
           + FullRows(ph, wants, finals, wx, i + 1)

  CreatedCount == Cardinality({i \in Blocks : phase[i] # "Absent"})

  PartialHeadExists ==
      /\ c < CreatedCount
      /\ mode[c + 1] = "AppendOnly"
      /\ phase[c + 1] \in {"Active", "Finalized"}
      /\ emitted[c + 1] > 0

  PartialHeadRows ==
      IF PartialHeadExists
      THEN TagSlice(c + 1, want[c + 1], 1, emitted[c + 1])
      ELSE <<>>

  Pressure ==
      \/ FullRows(phase, want, final, width, 1) > height
      \/ CreatedCount - c >= MaxLive
  RetirementRequested == flush \/ Pressure
  Replaying == replayMode # "None"

  PreviewSource(i) ==
      IF phase[i] = "Active"
      THEN Unemitted(want[i], i, emitted)
      ELSE Unemitted(final[i], i, emitted)

  PreviewCell(i, snapshot) ==
      LET rendered == Render(snapshot, width) IN
      [owner |-> i,
       row |-> IF Len(rendered) = 0
               THEN Placeholder
               ELSE rendered[Len(rendered)]]

  Repeat(value, count) == [j \in 1..count |-> value]
  Slot(i, snapshot, allocation) == Repeat(PreviewCell(i, snapshot), allocation)

  RECURSIVE PresentedCells(_)
  PresentedCells(i) ==
      IF i > N THEN <<>>
      ELSE (IF alloc[i] = 0 THEN <<>> ELSE Slot(i, PreviewSource(i), alloc[i]))
           \o PresentedCells(i + 1)

  Screen ==
      Repeat(
          BlankCell,
          height - AllocationTotal(alloc, 1) - SummaryRows(phase, final, emitted, width, height)
      )
      \o (IF SummaryRows(phase, final, emitted, width, height) = 1
          THEN <<OverflowCell>>
          ELSE <<>>)
      \o PresentedCells(1)

  ReplayRows ==
      IF ~Replaying
      THEN <<>>
      ELSE NativeRange("Replay", replayCursor, replayEnd, final, width)
           \o (IF replayPartial = 0
               THEN <<>>
               ELSE NativeTagSlice(
                       "Replay",
                       replayEnd + 1,
                       want[replayEnd + 1],
                       1,
                       replayPartial,
                       width
                    ))

  ReplayRoom ==
      Cardinality({j \in 1..height : Screen[j] = BlankCell})

  RequiredReplayCut ==
      IF Len(ReplayRows) > ReplayRoom THEN Len(ReplayRows) - ReplayRoom ELSE 0

  PreparedReplayTail ==
      IF replayPrepared
      THEN SnapshotSlice(ReplayRows, replayCut + 1, Len(ReplayRows))
      ELSE <<>>

  Prefix(left, right) ==
      /\ Len(left) <= Len(right)
      /\ \A j \in 1..Len(left) : left[j] = right[j]

  NoEarlierQueued(i) == \A j \in 1..(i - 1) : phase[j] # "Queued"
  BridgeHeight(sampled, requested) ==
      IF sampled < requested THEN requested
      ELSE IF sampled > 2 /\ requested = 1 THEN 2
      ELSE requested

  TypeOK ==
      /\ c \in 0..N
      /\ phase \in [Blocks -> Phases]
      /\ mode \in [Blocks -> BlockModes]
      /\ want \in [Blocks -> SnapshotValues]
      /\ final \in [Blocks -> SnapshotValues \cup {NoFinal}]
      /\ emitted \in [Blocks -> 0..MaxSnapshotLength]
      /\ alloc \in [Blocks -> 0..H]
      /\ target \in [Blocks -> 0..H]
      /\ history \in Seq(TaggedRows)
      /\ native \in Seq(NativeRows)
      /\ width \in WidthValues
      /\ height \in 0..H
      /\ resizes \in 0..MaxResizes
      /\ epoch \in 0..MaxResizes
      /\ replayMode \in ReplayModes
      /\ replayCursor \in 0..(N + 1)
      /\ replayEnd \in 0..N
      /\ replayPartial \in 0..MaxSnapshotLength
      /\ replayPrepared \in BOOLEAN
      /\ replayCut \in 0..MaxFailureRows
      /\ flush \in BOOLEAN
      /\ shutdown \in BOOLEAN
      /\ running \in BOOLEAN
      /\ stopReason \in StopReasons

  LifecycleShape ==
      /\ c <= CreatedCount
      /\ \A i \in 1..c :
             /\ phase[i] = "Committed"
             /\ mode[i] \in {"Mutable", "AppendOnly"}
      /\ \A i \in (c + 1)..CreatedCount :
             /\ phase[i] \in {"Queued", "Active", "Finalized"}
             /\ mode[i] \in {"Mutable", "AppendOnly"}
      /\ \A i \in (CreatedCount + 1)..N :
             /\ phase[i] = "Absent"
             /\ mode[i] = "Undeclared"

  SnapshotDiscipline ==
      \A i \in Blocks :
          IF phase[i] \in {"Finalized", "Committed"}
          THEN /\ final[i] \in SnapshotValues
               /\ final[i] = want[i]
          ELSE final[i] = NoFinal

  EmissionDiscipline ==
      /\ \A i \in Blocks :
             /\ emitted[i] <= Len(want[i])
             /\ (mode[i] # "AppendOnly" => emitted[i] = 0)
             /\ (emitted[i] > 0 =>
                    /\ i = c + 1
                    /\ phase[i] \in {"Active", "Finalized"})
      /\ (PartialHeadExists => emitted[c + 1] <= Len(want[c + 1]))

  Capacity == AllocationStateOK(alloc, target, phase, final, emitted, width, height)
  ExactCommittedHistory == history = CommittedRows(c, final) \o PartialHeadRows

  NoPrematureHistory ==
      \A j \in 1..Len(history) :
          LET owner == history[j].owner IN
          \/ /\ owner \in 1..c
             /\ phase[owner] = "Committed"
          \/ /\ PartialHeadExists
             /\ owner = c + 1

  ScreenCapacity ==
      /\ Screen \in Seq(Cells)
      /\ Len(Screen) = height
      /\ \A i \in Blocks :
             Cardinality({j \in 1..height : Screen[j].owner = i}) = alloc[i]
      /\ Cardinality({j \in 1..height : Screen[j] = OverflowCell})
         = SummaryRows(phase, final, emitted, width, height)
      /\ Cardinality({j \in 1..height : Screen[j] = BlankCell})
         = height - AllocationTotal(alloc, 1)
           - SummaryRows(phase, final, emitted, width, height)

  ReplayShape ==
      /\ (replayMode = "None" =>
             /\ replayCursor = 0
             /\ replayEnd = 0
                       /\ replayPartial = 0
            /\ ~replayPrepared
            /\ replayCut = 0)
      /\ (replayMode # "None" =>
                       /\ replayCursor = 1
             /\ replayEnd \in 0..c
                       /\ replayPartial <= MaxSnapshotLength
            /\ IF replayPrepared
               THEN /\ replayCut = RequiredReplayCut
                    /\ Len(PreparedReplayTail) <= ReplayRoom
               ELSE replayCut = 0)

  NativeSourceSafety ==
      \A j \in 1..Len(native) :
          LET owner == native[j].owner IN
          /\ (native[j].source = "Retire" =>
                 /\ owner \in 1..c
                 /\ phase[owner] = "Committed")
          /\ (native[j].source \in {"Append", "Replay"} =>
                 /\ owner \in Blocks
                 /\ \/ owner \in 1..c
                    \/ /\ owner = c + 1
                       /\ mode[owner] = "AppendOnly")
          /\ (native[j].source = "FailedWrite" => stopReason = "WriteFailure")
          /\ (native[j].source = "Exit" => ~running)
}

\* Separate fair processes preserve the source Spec's action-local weak fairness.
fair process (retireSuccess = "RetireSuccess") {
RetireSuccessLoop:
  while (TRUE) {
    with (batchEnd \in Blocks) {
      await ~replayPrepared
            /\ running
            /\ ~Replaying
            /\ batchEnd \in (c + 1)..N
            /\ FinalizedRange(c + 1, batchEnd)
            /\ RetirementRequested;
      with (newPhase = [i \in Blocks |->
                            IF i <= batchEnd THEN "Committed" ELSE phase[i]],
            newEmitted = [i \in Blocks |->
                              IF i <= batchEnd THEN 0 ELSE emitted[i]],
            newAlloc = CanonicalAllocation(
                newPhase,
                final,
                newEmitted,
                width,
                height
            )) {
        history := history
                   \o RetirementRows(c + 1, batchEnd, final, emitted[c + 1]) ||
        native := native
                  \o NativeRetirementRows(
                         "Retire",
                         c + 1,
                         batchEnd,
                         final,
                         emitted[c + 1],
                         width
                     ) ||
        c := batchEnd ||
        phase := newPhase ||
        emitted := newEmitted ||
        alloc := newAlloc ||
        target := newAlloc;
      };
    };
  }
}

fair process (prepareReplay = "PrepareReplay") {
PrepareReplayLoop:
  while (TRUE) {
    await ~replayPrepared /\ running /\ Replaying;
    replayPrepared := TRUE || replayCut := RequiredReplayCut;
  }
}

fair process (replaySuccess = "ReplaySynchronousSuccess") {
ReplaySynchronousSuccessLoop:
  while (TRUE) {
    await replayPrepared /\ running /\ Replaying;
    native := native \o PrefixOf(ReplayRows, replayCut) ||
    replayMode := "None" ||
    replayCursor := 0 ||
    replayEnd := 0 ||
    replayPartial := 0 ||
    replayPrepared := FALSE ||
    replayCut := 0;
  }
}

fair process (appendStable = "AppendStable") {
AppendStableLoop:
  while (TRUE) {
    await ~replayPrepared
          /\ running
          /\ ~shutdown
          /\ ~Replaying
          /\ c < CreatedCount
          /\ mode[c + 1] = "AppendOnly"
          /\ phase[c + 1] \in {"Active", "Finalized"}
          /\ emitted[c + 1] < Len(want[c + 1]);
    with (next = emitted[c + 1] + 1,
          newEmitted = [emitted EXCEPT ![c + 1] = next],
          newAlloc = CanonicalAllocation(
              phase,
              final,
              newEmitted,
              width,
              height
          )) {
      history := history \o TagSlice(c + 1, want[c + 1], next, next) ||
      native := native
                \o NativeTagSlice(
                       "Append",
                       c + 1,
                       want[c + 1],
                       next,
                       next,
                       width
                   ) ||
      emitted := newEmitted ||
      alloc := newAlloc ||
      target := newAlloc;
    };
  }
}

fair process (completeAppendOnly = "CompleteAppendOnly") {
CompleteAppendOnlyLoop:
  while (TRUE) {
    await ~replayPrepared
          /\ running
          /\ ~Replaying
          /\ c < CreatedCount
          /\ mode[c + 1] = "AppendOnly"
          /\ phase[c + 1] = "Finalized"
          /\ emitted[c + 1] = Len(final[c + 1]);
    with (newPhase = [phase EXCEPT ![c + 1] = "Committed"],
          newEmitted = [emitted EXCEPT ![c + 1] = 0],
          newAlloc = CanonicalAllocation(
              newPhase,
              final,
              newEmitted,
              width,
              height
          )) {
      c := c + 1 ||
      phase := newPhase ||
      emitted := newEmitted ||
      alloc := newAlloc ||
      target := newAlloc;
    };
  }
}

process (environment = "Environment") {
EnvironmentLoop:
  while (TRUE) {
    if (replayPrepared) {
      with (count \in 0..MaxFailureRows) {
        await running /\ Replaying /\ count \in 0..replayCut;
        native := native \o PrefixOf(ReplayRows, count) ||
        running := FALSE ||
        stopReason := "WriteFailure";
      };
    } else {
      either {
        with (declaration \in {"Mutable", "AppendOnly"}) {
          await running
                /\ ~shutdown
                /\ CreatedCount < N
                /\ phase[CreatedCount + 1] = "Absent";
          phase[CreatedCount + 1] := "Queued" ||
          mode[CreatedCount + 1] := declaration;
        };
      } or {
        with (i \in Blocks) {
          await running
                /\ ~shutdown
                /\ phase[i] = "Queued"
                /\ NoEarlierQueued(i);
          with (newPhase = [phase EXCEPT ![i] = "Active"],
                newAlloc = [alloc EXCEPT ![i] = 1],
                newTarget = [target EXCEPT ![i] = 1]) {
            await ~Overflow(newPhase, final, emitted, width, height)
                  /\ AllocationStateOK(
                         newAlloc,
                         newTarget,
                         newPhase,
                         final,
                         emitted,
                         width,
                         height
                     );
            phase := newPhase ||
            alloc := newAlloc ||
            target := newTarget;
          };
        };
      } or {
        with (i \in Blocks, snapshot \in SnapshotValues) {
          await running
                /\ ~shutdown
                /\ phase[i] \in {"Queued", "Active"}
                /\ (mode[i] = "Mutable" \/ Prefix(want[i], snapshot))
                /\ snapshot # want[i];
          want[i] := snapshot;
        };
      } or {
        with (newTarget \in [Blocks -> 0..H]) {
          await running
                /\ ~shutdown
                /\ AllocationStateOK(
                       alloc,
                       newTarget,
                       phase,
                       final,
                       emitted,
                       width,
                       height
                   )
                /\ newTarget # target;
          target := newTarget;
        };
      } or {
        with (i \in Blocks) {
          await running
                /\ ~shutdown
                /\ phase[i] = "Active"
                /\ alloc[i] # target[i];
          with (nextHeight = BridgeHeight(alloc[i], target[i]),
                newAlloc = [alloc EXCEPT ![i] = nextHeight]) {
            await AllocationStateOK(
                newAlloc,
                target,
                phase,
                final,
                emitted,
                width,
                height
            );
            alloc := newAlloc;
          };
        };
      } or {
        with (i \in Blocks, snapshot \in SnapshotValues) {
          await running
                /\ ~shutdown
                /\ phase[i] = "Active"
                /\ (mode[i] = "Mutable" \/ Prefix(want[i], snapshot));
          with (newPhase = [phase EXCEPT ![i] = "Finalized"],
                newFinal = [final EXCEPT ![i] = snapshot],
                newAlloc = CanonicalAllocation(
                    newPhase,
                    newFinal,
                    emitted,
                    width,
                    height
                )) {
            phase := newPhase ||
            want[i] := snapshot ||
            final := newFinal ||
            alloc := newAlloc ||
            target := newAlloc;
          };
        };
      } or {
        with (i \in Blocks, snapshot \in SnapshotValues) {
          await running
                /\ ~shutdown
                /\ phase[i] = "Queued"
                /\ (mode[i] = "Mutable" \/ Prefix(want[i], snapshot));
          with (newPhase = [phase EXCEPT ![i] = "Finalized"],
                newWant = [want EXCEPT ![i] = snapshot],
                newFinal = [final EXCEPT ![i] = snapshot],
                newAlloc = CanonicalAllocation(
                    newPhase,
                    newFinal,
                    emitted,
                    width,
                    height
                )) {
            phase := newPhase ||
            want := newWant ||
            final := newFinal ||
            alloc := newAlloc ||
            target := newAlloc;
          };
        };
      } or {
        await running /\ ~flush;
        flush := TRUE;
      } or {
        with (batchEnd \in Blocks) {
          await running
                /\ ~Replaying
                /\ batchEnd \in (c + 1)..N
                /\ FinalizedRange(c + 1, batchEnd)
                /\ RetirementRequested;
          with (rows = NativeRetirementRows(
                           "FailedWrite",
                           c + 1,
                           batchEnd,
                           final,
                           emitted[c + 1],
                           width
                       )) {
            with (count \in 0..MaxFailureRows) {
              await count \in 0..Len(rows);
              native := native \o PrefixOf(rows, count) ||
              running := FALSE ||
              stopReason := "WriteFailure";
            };
          };
        };
      } or {
        with (newWidth \in WidthValues,
              newHeight \in 0..H,
              resizePolicy \in ResizeModes,
              pushed \in 0..H) {
          await running
                /\ ~shutdown
                /\ resizes < MaxResizes
                /\ (newWidth # width \/ newHeight # height)
                /\ pushed \in 0..Len(Screen);
          with (widthChanged = newWidth # width,
                effectiveMode = IF widthChanged
                                THEN resizePolicy
                                ELSE "Preserve",
                pushedRows = NativeCells(
                    "Resize",
                    PrefixOf(Screen, pushed),
                    width
                ),
                beginReplay = effectiveMode # "Preserve"
                              /\ (c > 0 \/ PartialHeadExists),
                newPhase = phase,
                newAlloc = CanonicalAllocation(
                    newPhase,
                    final,
                    emitted,
                    newWidth,
                    newHeight
                )) {
            width := newWidth ||
            height := newHeight ||
            resizes := resizes + 1 ||
            alloc := newAlloc ||
            target := newAlloc ||
            native := IF effectiveMode = "Rebuild"
                      THEN <<>>
                      ELSE native \o pushedRows ||
            epoch := IF effectiveMode = "Rebuild" THEN epoch + 1 ELSE epoch ||
            replayMode := IF beginReplay
                          THEN effectiveMode
                          ELSE IF Replaying THEN replayMode ELSE "None" ||
            replayCursor := IF beginReplay
                            THEN 1
                            ELSE IF Replaying THEN replayCursor ELSE 0 ||
            replayEnd := IF beginReplay
                         THEN c
                         ELSE IF Replaying THEN replayEnd ELSE 0 ||
            replayPartial := IF beginReplay
                             THEN IF PartialHeadExists THEN emitted[c + 1] ELSE 0
                             ELSE IF Replaying THEN replayPartial ELSE 0 ||
            replayPrepared := FALSE ||
            replayCut := 0;
          };
        };
      } or {
        await running /\ ~shutdown;
        with (newPhase = [i \in Blocks |->
                              IF phase[i] = "Absent"
                              THEN "Absent"
                              ELSE IF i <= c THEN "Committed" ELSE "Finalized"],
              newFinal = [i \in Blocks |->
                              IF phase[i] = "Absent"
                              THEN NoFinal
                              ELSE IF i <= c \/ phase[i] = "Finalized"
                              THEN final[i]
                              ELSE want[i]],
              newAlloc = CanonicalAllocation(
                  newPhase,
                  newFinal,
                  emitted,
                  width,
                  height
              )) {
          phase := newPhase ||
          final := newFinal ||
          alloc := newAlloc ||
          target := newAlloc ||
          flush := TRUE ||
          shutdown := TRUE;
        };
      } or {
        with (push \in 0..1) {
          await running
                /\ shutdown
                /\ ~Replaying
                /\ c = CreatedCount
                /\ (push = 0 \/ height > 0);
          running := FALSE ||
          stopReason := "Graceful" ||
          native := IF push = 0
                    THEN native
                    ELSE native \o NativeCells("Exit", <<Screen[1]>>, width);
        };
      } or {
        with (push \in 0..1) {
          await running
                /\ ~shutdown
                /\ (push = 0 \/ height > 0);
          running := FALSE ||
          stopReason := "Detach" ||
          native := IF push = 0
                    THEN native
                    ELSE native \o NativeCells("Exit", <<Screen[1]>>, width);
        };
      };
    };
  }
}
} *)
\* BEGIN TRANSLATION (chksum(pcal) = "8b391dd3" /\ chksum(tla) = "a5bf9e80")
VARIABLES c, phase, mode, want, final, emitted, alloc, target, history, 
          native, width, height, resizes, epoch, replayMode, replayCursor, 
          replayEnd, replayPartial, replayPrepared, replayCut, flush, 
          shutdown, running, stopReason

(* define statement *)
Maximum(left, right) == IF left >= right THEN left ELSE right

RECURSIVE DoubleRows(_)
DoubleRows(snapshot) ==
    IF Len(snapshot) = 0 THEN <<>>
    ELSE <<Head(snapshot), Head(snapshot)>> \o DoubleRows(Tail(snapshot))

Render(snapshot, wx) == IF wx = "Wide" THEN snapshot ELSE DoubleRows(snapshot)

Tag(i, snapshot) ==
    [j \in 1..Len(snapshot) |-> [owner |-> i, row |-> snapshot[j]]]

SnapshotSlice(snapshot, lo, hi) ==
    IF lo > hi THEN <<>> ELSE SubSeq(snapshot, lo, hi)

TagSlice(i, snapshot, lo, hi) == Tag(i, SnapshotSlice(snapshot, lo, hi))

NativeTag(source, i, snapshot, wx) ==
    [j \in 1..Len(Render(snapshot, wx)) |->
        [source |-> source, owner |-> i,
         row |-> Render(snapshot, wx)[j], width |-> wx]]
NativeTagSlice(source, i, snapshot, lo, hi, wx) ==
    NativeTag(source, i, SnapshotSlice(snapshot, lo, hi), wx)

NativeCells(source, cells, wx) ==
    [j \in 1..Len(cells) |->
        [source |-> source, owner |-> cells[j].owner,
         row |-> cells[j].row, width |-> wx]]

PrefixOf(sequence, count) == [j \in 1..count |-> sequence[j]]

RECURSIVE CommittedRows(_, _)
CommittedRows(k, finals) ==
    IF k = 0 THEN <<>>
    ELSE CommittedRows(k - 1, finals) \o Tag(k, finals[k])

RECURSIVE TaggedRange(_, _, _)
TaggedRange(lo, hi, finals) ==
    IF lo > hi THEN <<>>
    ELSE Tag(lo, finals[lo]) \o TaggedRange(lo + 1, hi, finals)

RECURSIVE NativeRange(_, _, _, _, _)
NativeRange(source, lo, hi, finals, wx) ==
    IF lo > hi THEN <<>>
    ELSE NativeTag(source, lo, finals[lo], wx)
         \o NativeRange(source, lo + 1, hi, finals, wx)

RetirementRows(lo, hi, finals, firstEmitted) ==
    IF lo > hi THEN <<>>
    ELSE TagSlice(lo, finals[lo], firstEmitted + 1, Len(finals[lo]))
         \o TaggedRange(lo + 1, hi, finals)

NativeRetirementRows(source, lo, hi, finals, firstEmitted, wx) ==
    IF lo > hi THEN <<>>
    ELSE NativeTagSlice(
             source,
             lo,
             finals[lo],
             firstEmitted + 1,
             Len(finals[lo]),
             wx
         )
         \o NativeRange(source, lo + 1, hi, finals, wx)

FinalizedRange(lo, hi) ==
    \A i \in lo..hi : phase[i] = "Finalized"

Unemitted(snapshot, i, emission) ==
    IF mode[i] = "AppendOnly"
    THEN SnapshotSlice(snapshot, emission[i] + 1, Len(snapshot))
    ELSE snapshot

Presented(ph, finals, emission, i, wx) ==
    \/ ph[i] = "Active"
    \/ /\ ph[i] = "Finalized"
       /\ Len(Render(Unemitted(finals[i], i, emission), wx)) > 0

PresentedSet(ph, finals, emission, wx) ==
    {i \in Blocks : Presented(ph, finals, emission, i, wx)}
PresentedCount(ph, finals, emission, wx) ==
    Cardinality(PresentedSet(ph, finals, emission, wx))
Overflow(ph, finals, emission, wx, hx) ==
    PresentedCount(ph, finals, emission, wx) > hx
SummaryRows(ph, finals, emission, wx, hx) ==
    IF hx > 0 /\ Overflow(ph, finals, emission, wx, hx) THEN 1 ELSE 0

NewerPresented(ph, finals, emission, wx, i) ==
    Cardinality({
        j \in Blocks :
            j > i /\ Presented(ph, finals, emission, j, wx)
    })

VisiblePresented(ph, finals, emission, wx, hx, i) ==
    /\ Presented(ph, finals, emission, i, wx)
    /\ IF Overflow(ph, finals, emission, wx, hx)
       THEN /\ hx > 0
            /\ NewerPresented(ph, finals, emission, wx, i) < hx - 1
       ELSE TRUE

RECURSIVE AllocationTotal(_, _)
AllocationTotal(al, i) ==
    IF i > N THEN 0 ELSE al[i] + AllocationTotal(al, i + 1)

RECURSIVE ReservationTotal(_, _, _)
ReservationTotal(al, requested, i) ==
    IF i > N THEN 0
    ELSE Maximum(al[i], requested[i]) + ReservationTotal(al, requested, i + 1)

AllocationStateOK(al, requested, ph, finals, emission, wx, hx) ==
    /\ al \in [Blocks -> 0..H]
    /\ requested \in [Blocks -> 0..H]
    /\ \A i \in Blocks :
           IF VisiblePresented(ph, finals, emission, wx, hx, i)
           THEN IF ph[i] = "Active"
                THEN /\ al[i] \in 1..H
                     /\ requested[i] \in 1..H
                ELSE /\ al[i] \in 1..H
                     /\ requested[i] = al[i]
           ELSE /\ al[i] = 0
                /\ requested[i] = 0
    /\ ReservationTotal(al, requested, 1)
       + SummaryRows(ph, finals, emission, wx, hx) <= hx

CanonicalAllocation(ph, finals, emission, wx, hx) ==
    [i \in Blocks |->
        IF VisiblePresented(ph, finals, emission, wx, hx, i) THEN 1 ELSE 0]

SnapshotHeight(ph, wants, finals, i, wx) ==
    CASE ph[i] = "Active" ->
             Maximum(1, Len(Render(Unemitted(wants[i], i, emitted), wx)))
      [] ph[i] = "Queued" ->
             Maximum(1, Len(Render(Unemitted(wants[i], i, emitted), wx)))
      [] ph[i] = "Finalized" ->
             Len(Render(Unemitted(finals[i], i, emitted), wx))
      [] OTHER -> 0

RECURSIVE FullRows(_, _, _, _, _)
FullRows(ph, wants, finals, wx, i) ==
    IF i > N THEN 0
    ELSE SnapshotHeight(ph, wants, finals, i, wx)
         + FullRows(ph, wants, finals, wx, i + 1)

CreatedCount == Cardinality({i \in Blocks : phase[i] # "Absent"})

PartialHeadExists ==
    /\ c < CreatedCount
    /\ mode[c + 1] = "AppendOnly"
    /\ phase[c + 1] \in {"Active", "Finalized"}
    /\ emitted[c + 1] > 0

PartialHeadRows ==
    IF PartialHeadExists
    THEN TagSlice(c + 1, want[c + 1], 1, emitted[c + 1])
    ELSE <<>>

Pressure ==
    \/ FullRows(phase, want, final, width, 1) > height
    \/ CreatedCount - c >= MaxLive
RetirementRequested == flush \/ Pressure
Replaying == replayMode # "None"

PreviewSource(i) ==
    IF phase[i] = "Active"
    THEN Unemitted(want[i], i, emitted)
    ELSE Unemitted(final[i], i, emitted)

PreviewCell(i, snapshot) ==
    LET rendered == Render(snapshot, width) IN
    [owner |-> i,
     row |-> IF Len(rendered) = 0
             THEN Placeholder
             ELSE rendered[Len(rendered)]]

Repeat(value, count) == [j \in 1..count |-> value]
Slot(i, snapshot, allocation) == Repeat(PreviewCell(i, snapshot), allocation)

RECURSIVE PresentedCells(_)
PresentedCells(i) ==
    IF i > N THEN <<>>
    ELSE (IF alloc[i] = 0 THEN <<>> ELSE Slot(i, PreviewSource(i), alloc[i]))
         \o PresentedCells(i + 1)

Screen ==
    Repeat(
        BlankCell,
        height - AllocationTotal(alloc, 1) - SummaryRows(phase, final, emitted, width, height)
    )
    \o (IF SummaryRows(phase, final, emitted, width, height) = 1
        THEN <<OverflowCell>>
        ELSE <<>>)
    \o PresentedCells(1)

ReplayRows ==
    IF ~Replaying
    THEN <<>>
    ELSE NativeRange("Replay", replayCursor, replayEnd, final, width)
         \o (IF replayPartial = 0
             THEN <<>>
             ELSE NativeTagSlice(
                     "Replay",
                     replayEnd + 1,
                     want[replayEnd + 1],
                     1,
                     replayPartial,
                     width
                  ))

ReplayRoom ==
    Cardinality({j \in 1..height : Screen[j] = BlankCell})

RequiredReplayCut ==
    IF Len(ReplayRows) > ReplayRoom THEN Len(ReplayRows) - ReplayRoom ELSE 0

PreparedReplayTail ==
    IF replayPrepared
    THEN SnapshotSlice(ReplayRows, replayCut + 1, Len(ReplayRows))
    ELSE <<>>

Prefix(left, right) ==
    /\ Len(left) <= Len(right)
    /\ \A j \in 1..Len(left) : left[j] = right[j]

NoEarlierQueued(i) == \A j \in 1..(i - 1) : phase[j] # "Queued"
BridgeHeight(sampled, requested) ==
    IF sampled < requested THEN requested
    ELSE IF sampled > 2 /\ requested = 1 THEN 2
    ELSE requested

TypeOK ==
    /\ c \in 0..N
    /\ phase \in [Blocks -> Phases]
    /\ mode \in [Blocks -> BlockModes]
    /\ want \in [Blocks -> SnapshotValues]
    /\ final \in [Blocks -> SnapshotValues \cup {NoFinal}]
    /\ emitted \in [Blocks -> 0..MaxSnapshotLength]
    /\ alloc \in [Blocks -> 0..H]
    /\ target \in [Blocks -> 0..H]
    /\ history \in Seq(TaggedRows)
    /\ native \in Seq(NativeRows)
    /\ width \in WidthValues
    /\ height \in 0..H
    /\ resizes \in 0..MaxResizes
    /\ epoch \in 0..MaxResizes
    /\ replayMode \in ReplayModes
    /\ replayCursor \in 0..(N + 1)
    /\ replayEnd \in 0..N
    /\ replayPartial \in 0..MaxSnapshotLength
    /\ replayPrepared \in BOOLEAN
    /\ replayCut \in 0..MaxFailureRows
    /\ flush \in BOOLEAN
    /\ shutdown \in BOOLEAN
    /\ running \in BOOLEAN
    /\ stopReason \in StopReasons

LifecycleShape ==
    /\ c <= CreatedCount
    /\ \A i \in 1..c :
           /\ phase[i] = "Committed"
           /\ mode[i] \in {"Mutable", "AppendOnly"}
    /\ \A i \in (c + 1)..CreatedCount :
           /\ phase[i] \in {"Queued", "Active", "Finalized"}
           /\ mode[i] \in {"Mutable", "AppendOnly"}
    /\ \A i \in (CreatedCount + 1)..N :
           /\ phase[i] = "Absent"
           /\ mode[i] = "Undeclared"

SnapshotDiscipline ==
    \A i \in Blocks :
        IF phase[i] \in {"Finalized", "Committed"}
        THEN /\ final[i] \in SnapshotValues
             /\ final[i] = want[i]
        ELSE final[i] = NoFinal

EmissionDiscipline ==
    /\ \A i \in Blocks :
           /\ emitted[i] <= Len(want[i])
           /\ (mode[i] # "AppendOnly" => emitted[i] = 0)
           /\ (emitted[i] > 0 =>
                  /\ i = c + 1
                  /\ phase[i] \in {"Active", "Finalized"})
    /\ (PartialHeadExists => emitted[c + 1] <= Len(want[c + 1]))

Capacity == AllocationStateOK(alloc, target, phase, final, emitted, width, height)
ExactCommittedHistory == history = CommittedRows(c, final) \o PartialHeadRows

NoPrematureHistory ==
    \A j \in 1..Len(history) :
        LET owner == history[j].owner IN
        \/ /\ owner \in 1..c
           /\ phase[owner] = "Committed"
        \/ /\ PartialHeadExists
           /\ owner = c + 1

ScreenCapacity ==
    /\ Screen \in Seq(Cells)
    /\ Len(Screen) = height
    /\ \A i \in Blocks :
           Cardinality({j \in 1..height : Screen[j].owner = i}) = alloc[i]
    /\ Cardinality({j \in 1..height : Screen[j] = OverflowCell})
       = SummaryRows(phase, final, emitted, width, height)
    /\ Cardinality({j \in 1..height : Screen[j] = BlankCell})
       = height - AllocationTotal(alloc, 1)
         - SummaryRows(phase, final, emitted, width, height)

ReplayShape ==
    /\ (replayMode = "None" =>
           /\ replayCursor = 0
           /\ replayEnd = 0
                     /\ replayPartial = 0
          /\ ~replayPrepared
          /\ replayCut = 0)
    /\ (replayMode # "None" =>
                     /\ replayCursor = 1
           /\ replayEnd \in 0..c
                     /\ replayPartial <= MaxSnapshotLength
          /\ IF replayPrepared
             THEN /\ replayCut = RequiredReplayCut
                  /\ Len(PreparedReplayTail) <= ReplayRoom
             ELSE replayCut = 0)

NativeSourceSafety ==
    \A j \in 1..Len(native) :
        LET owner == native[j].owner IN
        /\ (native[j].source = "Retire" =>
               /\ owner \in 1..c
               /\ phase[owner] = "Committed")
        /\ (native[j].source \in {"Append", "Replay"} =>
               /\ owner \in Blocks
               /\ \/ owner \in 1..c
                  \/ /\ owner = c + 1
                     /\ mode[owner] = "AppendOnly")
        /\ (native[j].source = "FailedWrite" => stopReason = "WriteFailure")
        /\ (native[j].source = "Exit" => ~running)


vars == << c, phase, mode, want, final, emitted, alloc, target, history, 
           native, width, height, resizes, epoch, replayMode, replayCursor, 
           replayEnd, replayPartial, replayPrepared, replayCut, flush, 
           shutdown, running, stopReason >>

ProcSet == {"RetireSuccess"} \cup {"PrepareReplay"} \cup {"ReplaySynchronousSuccess"} \cup {"AppendStable"} \cup {"CompleteAppendOnly"} \cup {"Environment"}

Init == (* Global variables *)
        /\ c = 0
        /\ phase = [i \in Blocks |-> "Absent"]
        /\ mode = [i \in Blocks |-> "Undeclared"]
        /\ want = [i \in Blocks |-> <<>>]
        /\ final = [i \in Blocks |-> NoFinal]
        /\ emitted = [i \in Blocks |-> 0]
        /\ alloc = [i \in Blocks |-> 0]
        /\ target = [i \in Blocks |-> 0]
        /\ history = <<>>
        /\ native = <<>>
        /\ width = "Wide"
        /\ height = H
        /\ resizes = 0
        /\ epoch = 0
        /\ replayMode = "None"
        /\ replayCursor = 0
        /\ replayEnd = 0
        /\ replayPartial = 0
        /\ replayPrepared = FALSE
        /\ replayCut = 0
        /\ flush = FALSE
        /\ shutdown = FALSE
        /\ running = TRUE
        /\ stopReason = "Running"

retireSuccess == /\ \E batchEnd \in Blocks:
                      /\ ~replayPrepared
                         /\ running
                         /\ ~Replaying
                         /\ batchEnd \in (c + 1)..N
                         /\ FinalizedRange(c + 1, batchEnd)
                         /\ RetirementRequested
                      /\ LET newPhase == [i \in Blocks |->
                                              IF i <= batchEnd THEN "Committed" ELSE phase[i]] IN
                           LET newEmitted == [i \in Blocks |->
                                                  IF i <= batchEnd THEN 0 ELSE emitted[i]] IN
                             LET newAlloc ==            CanonicalAllocation(
                                                 newPhase,
                                                 final,
                                                 newEmitted,
                                                 width,
                                                 height
                                             ) IN
                               /\ alloc' = newAlloc
                               /\ c' = batchEnd
                               /\ emitted' = newEmitted
                               /\ history' = history
                                             \o RetirementRows(c + 1, batchEnd, final, emitted[c + 1])
                               /\ native' = native
                                            \o NativeRetirementRows(
                                                   "Retire",
                                                   c + 1,
                                                   batchEnd,
                                                   final,
                                                   emitted[c + 1],
                                                   width
                                               )
                               /\ phase' = newPhase
                               /\ target' = newAlloc
                 /\ UNCHANGED << mode, want, final, width, height, resizes, 
                                 epoch, replayMode, replayCursor, replayEnd, 
                                 replayPartial, replayPrepared, replayCut, 
                                 flush, shutdown, running, stopReason >>

prepareReplay == /\ ~replayPrepared /\ running /\ Replaying
                 /\ /\ replayCut' = RequiredReplayCut
                    /\ replayPrepared' = TRUE
                 /\ UNCHANGED << c, phase, mode, want, final, emitted, alloc, 
                                 target, history, native, width, height, 
                                 resizes, epoch, replayMode, replayCursor, 
                                 replayEnd, replayPartial, flush, shutdown, 
                                 running, stopReason >>

replaySuccess == /\ replayPrepared /\ running /\ Replaying
                 /\ /\ native' = native \o PrefixOf(ReplayRows, replayCut)
                    /\ replayCursor' = 0
                    /\ replayCut' = 0
                    /\ replayEnd' = 0
                    /\ replayMode' = "None"
                    /\ replayPartial' = 0
                    /\ replayPrepared' = FALSE
                 /\ UNCHANGED << c, phase, mode, want, final, emitted, alloc, 
                                 target, history, width, height, resizes, 
                                 epoch, flush, shutdown, running, stopReason >>

appendStable == /\ ~replayPrepared
                   /\ running
                   /\ ~shutdown
                   /\ ~Replaying
                   /\ c < CreatedCount
                   /\ mode[c + 1] = "AppendOnly"
                   /\ phase[c + 1] \in {"Active", "Finalized"}
                   /\ emitted[c + 1] < Len(want[c + 1])
                /\ LET next == emitted[c + 1] + 1 IN
                     LET newEmitted == [emitted EXCEPT ![c + 1] = next] IN
                       LET newAlloc ==            CanonicalAllocation(
                                           phase,
                                           final,
                                           newEmitted,
                                           width,
                                           height
                                       ) IN
                         /\ alloc' = newAlloc
                         /\ emitted' = newEmitted
                         /\ history' = history \o TagSlice(c + 1, want[c + 1], next, next)
                         /\ native' = native
                                      \o NativeTagSlice(
                                             "Append",
                                             c + 1,
                                             want[c + 1],
                                             next,
                                             next,
                                             width
                                         )
                         /\ target' = newAlloc
                /\ UNCHANGED << c, phase, mode, want, final, width, height, 
                                resizes, epoch, replayMode, replayCursor, 
                                replayEnd, replayPartial, replayPrepared, 
                                replayCut, flush, shutdown, running, 
                                stopReason >>

completeAppendOnly == /\ ~replayPrepared
                         /\ running
                         /\ ~Replaying
                         /\ c < CreatedCount
                         /\ mode[c + 1] = "AppendOnly"
                         /\ phase[c + 1] = "Finalized"
                         /\ emitted[c + 1] = Len(final[c + 1])
                      /\ LET newPhase == [phase EXCEPT ![c + 1] = "Committed"] IN
                           LET newEmitted == [emitted EXCEPT ![c + 1] = 0] IN
                             LET newAlloc ==            CanonicalAllocation(
                                                 newPhase,
                                                 final,
                                                 newEmitted,
                                                 width,
                                                 height
                                             ) IN
                               /\ alloc' = newAlloc
                               /\ c' = c + 1
                               /\ emitted' = newEmitted
                               /\ phase' = newPhase
                               /\ target' = newAlloc
                      /\ UNCHANGED << mode, want, final, history, native, 
                                      width, height, resizes, epoch, 
                                      replayMode, replayCursor, replayEnd, 
                                      replayPartial, replayPrepared, replayCut, 
                                      flush, shutdown, running, stopReason >>

environment == /\ IF replayPrepared
                     THEN /\ \E count \in 0..MaxFailureRows:
                               /\ running /\ Replaying /\ count \in 0..replayCut
                               /\ /\ native' = native \o PrefixOf(ReplayRows, count)
                                  /\ running' = FALSE
                                  /\ stopReason' = "WriteFailure"
                          /\ UNCHANGED << phase, mode, want, final, alloc, 
                                          target, width, height, resizes, 
                                          epoch, replayMode, replayCursor, 
                                          replayEnd, replayPartial, 
                                          replayPrepared, replayCut, flush, 
                                          shutdown >>
                     ELSE /\ \/ /\ \E declaration \in {"Mutable", "AppendOnly"}:
                                     /\ running
                                        /\ ~shutdown
                                        /\ CreatedCount < N
                                        /\ phase[CreatedCount + 1] = "Absent"
                                     /\ /\ mode' = [mode EXCEPT ![CreatedCount + 1] = declaration]
                                        /\ phase' = [phase EXCEPT ![CreatedCount + 1] = "Queued"]
                                /\ UNCHANGED <<want, final, alloc, target, native, width, height, resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, flush, shutdown, running, stopReason>>
                             \/ /\ \E i \in Blocks:
                                     /\ running
                                        /\ ~shutdown
                                        /\ phase[i] = "Queued"
                                        /\ NoEarlierQueued(i)
                                     /\ LET newPhase == [phase EXCEPT ![i] = "Active"] IN
                                          LET newAlloc == [alloc EXCEPT ![i] = 1] IN
                                            LET newTarget == [target EXCEPT ![i] = 1] IN
                                              /\ ~Overflow(newPhase, final, emitted, width, height)
                                                 /\ AllocationStateOK(
                                                        newAlloc,
                                                        newTarget,
                                                        newPhase,
                                                        final,
                                                        emitted,
                                                        width,
                                                        height
                                                    )
                                              /\ /\ alloc' = newAlloc
                                                 /\ phase' = newPhase
                                                 /\ target' = newTarget
                                /\ UNCHANGED <<mode, want, final, native, width, height, resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, flush, shutdown, running, stopReason>>
                             \/ /\ \E i \in Blocks:
                                     \E snapshot \in SnapshotValues:
                                       /\ running
                                          /\ ~shutdown
                                          /\ phase[i] \in {"Queued", "Active"}
                                          /\ (mode[i] = "Mutable" \/ Prefix(want[i], snapshot))
                                          /\ snapshot # want[i]
                                       /\ want' = [want EXCEPT ![i] = snapshot]
                                /\ UNCHANGED <<phase, mode, final, alloc, target, native, width, height, resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, flush, shutdown, running, stopReason>>
                             \/ /\ \E newTarget \in [Blocks -> 0..H]:
                                     /\ running
                                        /\ ~shutdown
                                        /\ AllocationStateOK(
                                               alloc,
                                               newTarget,
                                               phase,
                                               final,
                                               emitted,
                                               width,
                                               height
                                           )
                                        /\ newTarget # target
                                     /\ target' = newTarget
                                /\ UNCHANGED <<phase, mode, want, final, alloc, native, width, height, resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, flush, shutdown, running, stopReason>>
                             \/ /\ \E i \in Blocks:
                                     /\ running
                                        /\ ~shutdown
                                        /\ phase[i] = "Active"
                                        /\ alloc[i] # target[i]
                                     /\ LET nextHeight == BridgeHeight(alloc[i], target[i]) IN
                                          LET newAlloc == [alloc EXCEPT ![i] = nextHeight] IN
                                            /\       AllocationStateOK(
                                                   newAlloc,
                                                   target,
                                                   phase,
                                                   final,
                                                   emitted,
                                                   width,
                                                   height
                                               )
                                            /\ alloc' = newAlloc
                                /\ UNCHANGED <<phase, mode, want, final, target, native, width, height, resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, flush, shutdown, running, stopReason>>
                             \/ /\ \E i \in Blocks:
                                     \E snapshot \in SnapshotValues:
                                       /\ running
                                          /\ ~shutdown
                                          /\ phase[i] = "Active"
                                          /\ (mode[i] = "Mutable" \/ Prefix(want[i], snapshot))
                                       /\ LET newPhase == [phase EXCEPT ![i] = "Finalized"] IN
                                            LET newFinal == [final EXCEPT ![i] = snapshot] IN
                                              LET newAlloc ==            CanonicalAllocation(
                                                                  newPhase,
                                                                  newFinal,
                                                                  emitted,
                                                                  width,
                                                                  height
                                                              ) IN
                                                /\ alloc' = newAlloc
                                                /\ final' = newFinal
                                                /\ phase' = newPhase
                                                /\ target' = newAlloc
                                                /\ want' = [want EXCEPT ![i] = snapshot]
                                /\ UNCHANGED <<mode, native, width, height, resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, flush, shutdown, running, stopReason>>
                             \/ /\ \E i \in Blocks:
                                     \E snapshot \in SnapshotValues:
                                       /\ running
                                          /\ ~shutdown
                                          /\ phase[i] = "Queued"
                                          /\ (mode[i] = "Mutable" \/ Prefix(want[i], snapshot))
                                       /\ LET newPhase == [phase EXCEPT ![i] = "Finalized"] IN
                                            LET newWant == [want EXCEPT ![i] = snapshot] IN
                                              LET newFinal == [final EXCEPT ![i] = snapshot] IN
                                                LET newAlloc ==            CanonicalAllocation(
                                                                    newPhase,
                                                                    newFinal,
                                                                    emitted,
                                                                    width,
                                                                    height
                                                                ) IN
                                                  /\ alloc' = newAlloc
                                                  /\ final' = newFinal
                                                  /\ phase' = newPhase
                                                  /\ target' = newAlloc
                                                  /\ want' = newWant
                                /\ UNCHANGED <<mode, native, width, height, resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, flush, shutdown, running, stopReason>>
                             \/ /\ running /\ ~flush
                                /\ flush' = TRUE
                                /\ UNCHANGED <<phase, mode, want, final, alloc, target, native, width, height, resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, shutdown, running, stopReason>>
                             \/ /\ \E batchEnd \in Blocks:
                                     /\ running
                                        /\ ~Replaying
                                        /\ batchEnd \in (c + 1)..N
                                        /\ FinalizedRange(c + 1, batchEnd)
                                        /\ RetirementRequested
                                     /\ LET rows == NativeRetirementRows(
                                                        "FailedWrite",
                                                        c + 1,
                                                        batchEnd,
                                                        final,
                                                        emitted[c + 1],
                                                        width
                                                    ) IN
                                          \E count \in 0..MaxFailureRows:
                                            /\ count \in 0..Len(rows)
                                            /\ /\ native' = native \o PrefixOf(rows, count)
                                               /\ running' = FALSE
                                               /\ stopReason' = "WriteFailure"
                                /\ UNCHANGED <<phase, mode, want, final, alloc, target, width, height, resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, flush, shutdown>>
                             \/ /\ \E newWidth \in WidthValues:
                                     \E newHeight \in 0..H:
                                       \E resizePolicy \in ResizeModes:
                                         \E pushed \in 0..H:
                                           /\ running
                                              /\ ~shutdown
                                              /\ resizes < MaxResizes
                                              /\ (newWidth # width \/ newHeight # height)
                                              /\ pushed \in 0..Len(Screen)
                                           /\ LET widthChanged == newWidth # width IN
                                                LET effectiveMode == IF widthChanged
                                                                     THEN resizePolicy
                                                                     ELSE "Preserve" IN
                                                  LET pushedRows ==              NativeCells(
                                                                        "Resize",
                                                                        PrefixOf(Screen, pushed),
                                                                        width
                                                                    ) IN
                                                    LET beginReplay == effectiveMode # "Preserve"
                                                                       /\ (c > 0 \/ PartialHeadExists) IN
                                                      LET newPhase == phase IN
                                                        LET newAlloc ==            CanonicalAllocation(
                                                                            newPhase,
                                                                            final,
                                                                            emitted,
                                                                            newWidth,
                                                                            newHeight
                                                                        ) IN
                                                          /\ alloc' = newAlloc
                                                          /\ epoch' = (IF effectiveMode = "Rebuild" THEN epoch + 1 ELSE epoch)
                                                          /\ height' = newHeight
                                                          /\ native' = (IF effectiveMode = "Rebuild"
                                                                        THEN <<>>
                                                                        ELSE native \o pushedRows)
                                                          /\ replayCursor' = IF beginReplay
                                                                             THEN 1
                                                                             ELSE IF Replaying THEN replayCursor ELSE 0
                                                          /\ replayCut' = 0
                                                          /\ replayEnd' = IF beginReplay
                                                                          THEN c
                                                                          ELSE IF Replaying THEN replayEnd ELSE 0
                                                          /\ replayMode' = IF beginReplay
                                                                           THEN effectiveMode
                                                                           ELSE IF Replaying THEN replayMode ELSE "None"
                                                          /\ replayPartial' = IF beginReplay
                                                                              THEN IF PartialHeadExists THEN emitted[c + 1] ELSE 0
                                                                              ELSE IF Replaying THEN replayPartial ELSE 0
                                                          /\ replayPrepared' = FALSE
                                                          /\ resizes' = resizes + 1
                                                          /\ target' = newAlloc
                                                          /\ width' = newWidth
                                /\ UNCHANGED <<phase, mode, want, final, flush, shutdown, running, stopReason>>
                             \/ /\ running /\ ~shutdown
                                /\ LET newPhase == [i \in Blocks |->
                                                        IF phase[i] = "Absent"
                                                        THEN "Absent"
                                                        ELSE IF i <= c THEN "Committed" ELSE "Finalized"] IN
                                     LET newFinal == [i \in Blocks |->
                                                          IF phase[i] = "Absent"
                                                          THEN NoFinal
                                                          ELSE IF i <= c \/ phase[i] = "Finalized"
                                                          THEN final[i]
                                                          ELSE want[i]] IN
                                       LET newAlloc ==            CanonicalAllocation(
                                                           newPhase,
                                                           newFinal,
                                                           emitted,
                                                           width,
                                                           height
                                                       ) IN
                                         /\ alloc' = newAlloc
                                         /\ final' = newFinal
                                         /\ flush' = TRUE
                                         /\ phase' = newPhase
                                         /\ shutdown' = TRUE
                                         /\ target' = newAlloc
                                /\ UNCHANGED <<mode, want, native, width, height, resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, running, stopReason>>
                             \/ /\ \E push \in 0..1:
                                     /\ running
                                        /\ shutdown
                                        /\ ~Replaying
                                        /\ c = CreatedCount
                                        /\ (push = 0 \/ height > 0)
                                     /\ /\ native' = (IF push = 0
                                                      THEN native
                                                      ELSE native \o NativeCells("Exit", <<Screen[1]>>, width))
                                        /\ running' = FALSE
                                        /\ stopReason' = "Graceful"
                                /\ UNCHANGED <<phase, mode, want, final, alloc, target, width, height, resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, flush, shutdown>>
                             \/ /\ \E push \in 0..1:
                                     /\ running
                                        /\ ~shutdown
                                        /\ (push = 0 \/ height > 0)
                                     /\ /\ native' = (IF push = 0
                                                      THEN native
                                                      ELSE native \o NativeCells("Exit", <<Screen[1]>>, width))
                                        /\ running' = FALSE
                                        /\ stopReason' = "Detach"
                                /\ UNCHANGED <<phase, mode, want, final, alloc, target, width, height, resizes, epoch, replayMode, replayCursor, replayEnd, replayPartial, replayPrepared, replayCut, flush, shutdown>>
               /\ UNCHANGED << c, emitted, history >>

Next == retireSuccess \/ prepareReplay \/ replaySuccess \/ appendStable
           \/ completeAppendOnly \/ environment

Spec == /\ Init /\ [][Next]_vars
        /\ WF_vars(retireSuccess)
        /\ WF_vars(prepareReplay)
        /\ WF_vars(replaySuccess)
        /\ WF_vars(appendStable)
        /\ WF_vars(completeAppendOnly)

\* END TRANSLATION 

HistoryExtension == Prefix(history, history')
HistoryMonotonicity == [][HistoryExtension]_vars

NativeEpochStep ==
    IF epoch' = epoch
    THEN Prefix(native, native')
    ELSE /\ epoch' = epoch + 1
         /\ native' = <<>>
NativeEpochDiscipline == [][NativeEpochStep]_vars

FinalsStayFixed ==
    \A i \in Blocks :
        phase[i] \in {"Finalized", "Committed"} => final'[i] = final[i]
FinalImmutability == [][FinalsStayFixed]_vars

AppendOnlyPrefixStep ==
    \A i \in Blocks :
        (mode[i] = "AppendOnly" /\ phase[i] \in {"Queued", "Active"})
        => Prefix(want[i], want'[i])
AppendOnlyMonotonicity == [][AppendOnlyPrefixStep]_vars

ResizeKeepsLogicalHistoryStep ==
    (width' # width \/ height' # height) =>
        /\ history' = history
        /\ c' = c
        /\ mode' = mode
        /\ want' = want
        /\ final' = final
        /\ emitted' = emitted
ResizeKeepsLogicalHistory == [][ResizeKeepsLogicalHistoryStep]_vars

FailedWriteStops == [](
    stopReason = "WriteFailure" => ~running
)

StoppedStep == ~running => UNCHANGED vars
StoppedQuiescence == [][StoppedStep]_vars

AllFinalized ==
    \A i \in 1..CreatedCount : phase[i] \in {"Finalized", "Committed"}
AllCommitted ==
    /\ c = CreatedCount
    /\ history = CommittedRows(c, final)

FlushLiveness ==
    (AllFinalized /\ flush /\ shutdown /\ running /\ ~Replaying)
    ~> (AllCommitted \/ ~running)

ReplayLiveness == (Replaying /\ running) ~> (~Replaying \/ ~running)

QueuedDemand == \E i \in Blocks : phase[i] = "Queued"
QueuedPressureRetirement ==
    \A i \in Blocks :
        (/\ running
         /\ ~Replaying
         /\ c = i - 1
         /\ phase[i] = "Finalized"
         /\ Pressure
         /\ QueuedDemand)
        ~> (c >= i \/ ~running)

====
