//! Shared size limits for buffers whose length a script controls.
//!
//! `try_reserve` succeeds for nearly any size on overcommitting hosts, and the
//! fill that follows then touches every page inside one uncancellable native
//! call. Every reserve-then-fill sized by script input checks this limit first.

/// Largest buffer (bytes or elements) a single script-sized allocation may request.
pub(in crate::perl) const MAX_BUFFER: usize = 1 << 30;

/// Rejects a script-sized length above [`MAX_BUFFER`] with perl's out-of-memory wording
/// ("Out of memory during string extend"); `what` names the buffer ("string", "pack", "list").
pub(in crate::perl) fn check_len(len: usize, what: &str) -> Result<(), String> {
	if len > MAX_BUFFER { Err(format!("Out of memory during {what} extend")) } else { Ok(()) }
}
