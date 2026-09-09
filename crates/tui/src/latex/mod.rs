//! Best-effort terminal rendering for inline and display LaTeX math.
//!
//! One-dimensional expressions map to styled Unicode runs; display constructs
//! are delegated to the baseline-aligned box renderer.

mod block;
mod unicode;

pub use block::latex_block;
pub use unicode::latex_inline;
pub(crate) use unicode::{is_bare_math_environment, math_span};
