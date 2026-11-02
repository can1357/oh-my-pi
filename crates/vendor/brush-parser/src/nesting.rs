//! Bounds how deeply the parsers nest constructs.
//!
//! The parsers are recursive descent: every nested construct (a brace group in
//! a brace group, a parenthesis in an arithmetic expression, a `${...}` in a
//! `${...}` default) adds stack frames, and so do the passes that later walk
//! the parsed tree (execution, expansion, arithmetic evaluation, drop). Past
//! the end of the thread's stack the process dies with no message, so each
//! parser refuses input nested deeper than [`MAX_NESTING_DEPTH`] and reports
//! the construct that went past it.

use std::cell::Cell;

/// The deepest nesting of constructs the parsers accept.
///
/// Every level costs stack, both while parsing and in every later pass over the
/// parsed tree. On a 2 MiB thread (the default for spawned threads, and the
/// size of the Tokio workers an embedder may run the shell on), the costliest
/// constructs die near 100 levels on their own. They can meet across a parse
/// boundary, though: 51 nested `for` loops around 51 quoted `${x:-...}`
/// expansions overflow an optimized worker. 32 leaves headroom for two
/// independently nested constructs. It also exceeds the 16 levels found in
/// 1,526 real shell scripts, and the Bash corpus has no regression at it.
pub const MAX_NESTING_DEPTH: usize = 32;

/// A construct was nested more deeply than [`MAX_NESTING_DEPTH`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("`{construct}': maximum nesting level exceeded ({limit})")]
pub struct NestingLimitExceeded {
    /// The opening token of the construct that went past the limit.
    pub construct: &'static str,
    /// The limit that was exceeded.
    pub limit: usize,
}

impl NestingLimitExceeded {
    pub(crate) const fn new(construct: &'static str) -> Self {
        Self {
            construct,
            limit: MAX_NESTING_DEPTH,
        }
    }
}

/// Counts how deeply one parse is nested.
///
/// The grammars enter it when they descend into a nested construct and leave it
/// when they come back out, whether the construct parsed or not. Once a
/// construct goes past the limit, every later attempt to enter fails too, so a
/// backtracking grammar unwinds instead of retrying alternatives at depth; the
/// caller then reports the first construct that went past the limit, whatever
/// the grammar made of the input.
#[derive(Debug, Default)]
pub(crate) struct NestingGuard {
    depth: Cell<usize>,
    exceeded: Cell<Option<(&'static str, usize)>>,
}

impl NestingGuard {
    /// Enters one level of `construct`, found at input position `pos`.
    /// Returns false, and records the construct, if that would go past the
    /// limit or the limit was already exceeded.
    pub(crate) fn enter(&self, construct: &'static str, pos: usize) -> bool {
        if self.exceeded.get().is_some() {
            return false;
        }
        let depth = self.depth.get();
        if depth >= MAX_NESTING_DEPTH {
            self.exceeded.set(Some((construct, pos)));
            return false;
        }
        self.depth.set(depth + 1);
        true
    }

    /// Leaves the level the last successful [`Self::enter`] entered.
    pub(crate) fn leave(&self) {
        self.depth.set(self.depth.get().saturating_sub(1));
    }

    /// How many levels this guard is inside now.
    pub(crate) const fn depth(&self) -> usize {
        self.depth.get()
    }

    /// Records that a nested parse this one depends on went past the limit.
    pub(crate) fn exceed(&self, error: &NestingLimitExceeded, pos: usize) {
        if self.exceeded.get().is_none() {
            self.exceeded.set(Some((error.construct, pos)));
        }
    }

    /// Runs `parse`, a parse of a different input that shares this guard, and reports any
    /// construct it takes past the limit at `pos`, a position in this guard's input.
    pub(crate) fn sharing_at<T>(&self, pos: usize, parse: impl FnOnce() -> T) -> T {
        let already_exceeded = self.exceeded.get().is_some();
        let result = parse();
        if !already_exceeded && let Some((construct, _)) = self.exceeded.get() {
            self.exceeded.set(Some((construct, pos)));
        }
        result
    }

    /// The construct that first went past the limit, and its input position.
    pub(crate) fn exceeded(&self) -> Option<(NestingLimitExceeded, usize)> {
        self.exceeded
            .get()
            .map(|(construct, pos)| (NestingLimitExceeded::new(construct), pos))
    }
}
