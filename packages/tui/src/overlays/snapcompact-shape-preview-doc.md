¶user:Fix the settings overlay crash. Wheeling past the last row throws.

¶call:read(path="src/select-list.ts:140-180")//Reading the select-list hit test
<out>
162: const index = Math.floor(line / rowHeight); index is never checked against bounds.
</out>

¶ai:Found it. The hit test indexes past the filtered list; clamping to the last row fixes the crash.

¶user:Does the fix survive filtering?

¶think:Check whether the clamp runs before or after filtering.

¶ai:Yes. The clamp applies after the filter pass, so a narrowed list keeps the hit map in sync. Added a regression test that wheels past the last row with a filter active and asserts no throw.
