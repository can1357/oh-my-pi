//! Journal-derived authoritative session tree.
//!
//! [`Session`] is the only mutable owner of a session journal and DOM. Live
//! writes are committed to the journal before the exact appended entry is
//! folded, and replay uses that same fold.

mod component;
pub mod custom_message;
pub mod components {
	//! Built-in journal-derived `<meta>` components.

	/// Journal-backed console-variable subtree boundary.
	pub mod con;
	/// Journal-backed director engagement subtree boundary.
	pub mod directors;
	/// Detached-work projection component.
	pub mod jobs;
	/// Journal-derived lifecycle-sensitive components and their read APIs.
	pub mod lifecycle;
	/// Journal-backed deferred-prompt subtree boundary.
	pub mod prompts;
	/// Todo snapshot projection component.
	pub mod todo;
}
pub mod exit_diagnostics;
mod fold;
pub mod late_diagnostics;
pub mod projection;
pub mod rewind;
mod session;

pub use component::{Component, ComponentRegistry, Draft};
pub use exit_diagnostics::{
	CrashTail, ExitCause, ExitSignal, ExitStatus, SessionExit, latest_session_exit,
};
pub use projection::{
	ASSISTANT_CONTENT_TAG, FILE_MENTION_PROP, PROVIDER_BLOCK_INDEX_PROP, ProjectionError,
	compaction_frame_count, compaction_frames, file_mentions, project_thread,
	project_thread_history, project_thread_through,
};
pub use rewind::{LifecycleWork, diff};
pub use session::{AttachmentInput, Session, SessionError, UnsettledCall};
