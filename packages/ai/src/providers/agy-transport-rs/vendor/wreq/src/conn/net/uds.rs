//! Unix Domain Socket (UDS) connection types and utilities.

#[cfg(all(unix, feature = "tokio-rt"))]
pub mod tokio;

#[cfg(all(unix, feature = "compio-rt"))]
pub mod compio;

use std::{io::Result, pin::Pin};

type BoxConnecting<T> = Pin<Box<dyn Future<Output = Result<T>> + Send>>;
