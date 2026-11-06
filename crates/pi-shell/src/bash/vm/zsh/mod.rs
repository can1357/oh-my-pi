//! The zsh dialect: ports of zsh 5.9's expansion, parameter,
//! globbing, arithmetic, condition and builtin code onto the engine's
//! expander, store and pollable file system.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

pub mod arith;
pub mod assoc_order;
pub mod brace;
pub mod cond;
pub mod math;
pub mod modify;
pub mod nameddir;
pub mod params;
pub mod specials;
pub mod subscript;
pub mod subst;
pub mod terminfo_db;
pub mod text;
pub mod wcwidth;
pub mod zexit;
pub mod zglob;
pub mod zpattern;
pub mod zwc;
