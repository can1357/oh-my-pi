//! Session/journal helpers for the authoritative `.oms` spine.

use std::path::Path;

use omp_session::{ComponentRegistry, Session, SessionError};

/// Creates a standard journal-derived session.
pub fn create_session(path: &Path) -> Result<Session, SessionError> {
	Session::create(path, ComponentRegistry::standard())
}

/// Reopens a standard session through the production replay fold.
pub fn reopen_session(path: &Path) -> Result<Session, SessionError> {
	Session::open(path, ComponentRegistry::standard())
}
