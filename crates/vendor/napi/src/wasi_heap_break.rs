//! The page arithmetic of the heap-sync `sbrk` (`wasi_heap_sync::__wrap_sbrk`): pure functions,
//! so they also build natively, where the unit tests below run. The design is in
//! `wasi_heap_sync`'s "The break".

/// When the break must pass the current memory, grow at least this much in one `memory.grow`,
/// so the heap grows in a few large steps instead of 64 KiB-2 MiB ones. Every growth costs one
/// refresh on every thread, and V8 changes the page permissions of the whole memory on each
/// grow. 16 MiB is a small share of the 4 GiB maximum.
pub(crate) const GROW_AHEAD: usize = 16 << 20;

/// Wasm page size in bytes, for address math in `usize` (32 bits on wasm32).
pub(crate) const PAGE_BYTES: usize = 1 << 16;

/// The break never passes this page, 2^31 in bytes; see `wasi_heap_sync`'s "The break".
pub(crate) const HEAP_LIMIT_PAGES: usize = 1 << 15;

/// Pages needed to cover every byte below `addr`.
#[inline]
pub(crate) const fn pages_below(addr: usize) -> usize {
  addr.div_ceil(PAGE_BYTES)
}

/// The new break when `increment` bytes fit below `own_end` (the reserve's end, or the end of
/// the last region `sbrk` grew itself): no growth. `None` when the memory must grow.
#[inline]
pub(crate) fn fits(brk: usize, own_end: usize, increment: usize) -> Option<usize> {
  brk.checked_add(increment).filter(|&end| end <= own_end)
}

/// The pages `sbrk` grows for a request that does not [`fit`](fits).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Grow {
  /// The fewest pages that hold the request.
  pub need: usize,
  /// The pages tried first: `need` raised to [`GROW_AHEAD`], capped at [`HEAP_LIMIT_PAGES`].
  pub ahead: usize,
}

/// How much `sbrk` grows when `increment` bytes do not fit below `own_end`, with the memory at
/// `now` pages. `None` when the request cannot fit below 2^31: `sbrk` then fails without growing.
///
/// - `own_end` is the current memory end (nobody else grew the memory since `sbrk` last moved
///   `own_end`): the new pages extend `[brk, own_end)`, so only the part of the new break past
///   the memory end is grown, `pages_below(brk + increment) - now`. The reserve, or what is left
///   of the last grown region, is used before any page is grown.
/// - Otherwise another allocator grew the pages after `own_end`. `sbrk` returns one contiguous
///   block, and `[brk, own_end)` does not touch the new pages, so the block starts a new segment
///   at the memory end and the whole increment must be grown: `pages_below(increment)`.
pub(crate) fn grow_plan(brk: usize, own_end: usize, increment: usize, now: usize) -> Option<Grow> {
  // `checked_mul`: at 65536 pages the byte size is 2^32, past `usize` on wasm32.
  let need = if now.checked_mul(PAGE_BYTES) == Some(own_end) {
    pages_below(brk.checked_add(increment)?).checked_sub(now)?
  } else {
    pages_below(increment)
  };
  // Pages that can still be added below 2^31. A request that cannot fit fails before it grows.
  // `need == 0` only for a request that [`fits`], which the caller handles first.
  let room = HEAP_LIMIT_PAGES.saturating_sub(now);
  if need == 0 || need > room {
    return None;
  }
  Some(Grow {
    need,
    ahead: need.max(GROW_AHEAD / PAGE_BYTES).min(room),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  const MIB: usize = 1 << 20;
  const AHEAD_PAGES: usize = GROW_AHEAD / PAGE_BYTES;

  /// rolldown's loader: 1 GiB initial memory (16384 pages), 2 GiB maximum, `__heap_end` at
  /// 1001 pages. The heap-sync break starts at `__heap_end`.
  const INIT_PAGES: usize = 16384;
  const HEAP_END: usize = 1001 * PAGE_BYTES;
  const RESERVE_END: usize = INIT_PAGES * PAGE_BYTES;

  #[test]
  fn increment_inside_the_reserve_does_not_grow() {
    assert_eq!(
      fits(HEAP_END, RESERVE_END, 64 * MIB),
      Some(HEAP_END + 64 * MIB)
    );
    // The reserve is used to its last byte before anything grows.
    assert_eq!(
      fits(HEAP_END, RESERVE_END, RESERVE_END - HEAP_END),
      Some(RESERVE_END)
    );
    assert_eq!(
      fits(HEAP_END, RESERVE_END, RESERVE_END - HEAP_END + 1),
      None
    );
  }

  #[test]
  fn crossing_the_reserve_end_grows_the_part_past_it() {
    // 1 MiB (16 pages) past the reserve end, raised to the grow-ahead.
    let brk = RESERVE_END - 4 * MIB;
    assert_eq!(
      grow_plan(brk, RESERVE_END, 5 * MIB, INIT_PAGES),
      Some(Grow {
        need: 16,
        ahead: AHEAD_PAGES
      })
    );
    // A single byte past it: one page, raised to the grow-ahead.
    assert_eq!(
      grow_plan(RESERVE_END - 8, RESERVE_END, 9, INIT_PAGES),
      Some(Grow {
        need: 1,
        ahead: AHEAD_PAGES
      })
    );
    // More than the grow-ahead past it: exactly the part past it.
    assert_eq!(
      grow_plan(brk, RESERVE_END, 4 * MIB + 32 * MIB + 1, INIT_PAGES),
      Some(Grow {
        need: 513,
        ahead: 513
      })
    );
  }

  #[test]
  fn increment_larger_than_room_fits_when_the_part_past_the_end_does() {
    let room = HEAP_LIMIT_PAGES - INIT_PAGES;
    // 17000 pages: more than the 16384 pages of room, but 1617 of them lie past the reserve.
    let increment = 17000 * PAGE_BYTES;
    assert!(pages_below(increment) > room);
    assert_eq!(
      grow_plan(HEAP_END, RESERVE_END, increment, INIT_PAGES),
      Some(Grow {
        need: 1617,
        ahead: 1617
      })
    );
    // Right up to 2^31 still fits; one byte more does not.
    let to_limit = HEAP_LIMIT_PAGES * PAGE_BYTES - HEAP_END;
    assert_eq!(
      grow_plan(HEAP_END, RESERVE_END, to_limit, INIT_PAGES),
      Some(Grow {
        need: room,
        ahead: room
      })
    );
    assert_eq!(
      grow_plan(HEAP_END, RESERVE_END, to_limit + 1, INIT_PAGES),
      None
    );
  }

  #[test]
  fn rolldown_heap_ceiling_holds() {
    // rolldown's heap-ceiling stress: one `malloc(hold)` right after the loader starts, with the
    // break still at `__heap_end`. Before this fix `sbrk` grew the whole increment, so 1000 MiB
    // grew 16000 pages (memory 32384) and 1100 / 1536 MiB failed (17600 / 24576 > 16384 room).
    for (hold_mib, need) in [(1000, 617), (1100, 2217), (1536, 9193)] {
      let increment = hold_mib * MIB;
      let plan = grow_plan(HEAP_END, RESERVE_END, increment, INIT_PAGES).unwrap();
      assert_eq!(plan, Grow { need, ahead: need }, "hold {hold_mib} MiB");
      // The memory ends where the held block ends.
      assert_eq!(
        (INIT_PAGES + plan.need) * PAGE_BYTES,
        HEAP_END + increment,
        "hold {hold_mib} MiB"
      );
    }
    // A heap already 1 GiB past the reserve end: 1536 MiB more crosses 2^31 and fails.
    let grown_end = (INIT_PAGES + 16000) * PAGE_BYTES;
    assert_eq!(
      grow_plan(grown_end, grown_end, 1536 * MIB, INIT_PAGES + 16000),
      None
    );
  }

  #[test]
  fn foreign_growth_grows_the_whole_increment() {
    // Another allocator grew 100 pages past the reserve end: the block starts at the new memory
    // end, so all of it must be grown.
    let now = INIT_PAGES + 100;
    assert_eq!(
      grow_plan(RESERVE_END - 4 * MIB, RESERVE_END, 5 * MIB, now),
      Some(Grow {
        need: 80,
        ahead: AHEAD_PAGES
      })
    );
    let room = HEAP_LIMIT_PAGES - now;
    assert_eq!(
      grow_plan(HEAP_END, RESERVE_END, (room + 1) * PAGE_BYTES, now),
      None
    );
  }

  #[test]
  fn never_grows_past_two_gib() {
    let limit = HEAP_LIMIT_PAGES * PAGE_BYTES;
    // At the limit, and past it (another allocator grew there): no room at all.
    assert_eq!(grow_plan(limit - 8, limit, 16, HEAP_LIMIT_PAGES), None);
    assert_eq!(grow_plan(limit, limit, 16, HEAP_LIMIT_PAGES + 10), None);
    // The grow-ahead is capped by the room left.
    let now = HEAP_LIMIT_PAGES - 10;
    let end = now * PAGE_BYTES;
    assert_eq!(
      grow_plan(end, end, 1, now),
      Some(Grow { need: 1, ahead: 10 })
    );
    // An increment that overflows the address space fails instead of wrapping.
    assert_eq!(grow_plan(end, end, usize::MAX, now), None);
  }
}
