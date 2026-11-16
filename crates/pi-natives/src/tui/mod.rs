//! Terminal engine: everything between the JS component tree and the TTY.
//!
//! The JS host renders components to rows and forwards resize notifications
//! and a clock reading; this engine owns the rest — the process's stdin (raw
//! mode, a reader thread) and stdout (a writer thread), stdin parsing and
//! capability negotiation, terminal modes and their restore, frame
//! preparation and diffing, history/viewport accounting, resize
//! transactions, and render scheduling — through [`crate::term`]. Virtual
//! terminals and test harnesses instead capture the output and forward
//! input bytes.
//!
//! # Architecture
//!
//! - [`input`]: stdin bytes → keys, pastes, and terminal [`types::Report`]s.
//! - [`session`]: probes and negotiated state (keyboard protocol, DECRQM,
//!   appearance, notifications, glyph protocol, TSP hello, in-band resize,
//!   stall watchdog, progress keepalive).
//! - [`screen`]: frame painting, resize transactions, and render scheduling.
//! - [`surface`]: the Tern Surface Protocol handshake (optimistic start,
//!   confirm deadline, first-paint hold, revoke, adoption).
//! - [`budget`]: the inline-image budget (napi `ImageBudget`): live/text
//!   splits, graphics-store residency, transmit and purge queues, shared with
//!   the engine that drains it on every paint.
//! - [`graphics`]: inline-image encoding (napi `InlineImage`): Kitty transmits,
//!   direct and Unicode-placeholder placements, iTerm2 inline images, SIXEL
//!   encodes, and header dimension sniffing.
//! - `engine`: the napi `TerminalEngine` that routes between them.
//!
//! Time is an input: every call carries the host's clock, and the host
//! re-arms one timer at `nextDeadline()`. The only callback into JS is the
//! wake-up the stdout writer raises when its backlog drains or the terminal
//! fails, and the stdin reader when reads are queued or stdin ends; the host
//! answers with `tick`.

pub mod budget;
pub mod engine;
pub mod graphics;
pub(crate) mod input;
mod js;
pub(crate) mod profile;
pub(crate) mod screen;
pub(crate) mod session;
pub(crate) mod surface;
pub(crate) mod types;
