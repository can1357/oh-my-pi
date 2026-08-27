//! Bounded, authority-backed support shared by every end-to-end proof.

mod builders;
#[cfg(unix)]
mod docserver;
#[cfg(unix)]
mod envd;
#[cfg(unix)]
mod extension;
#[cfg(unix)]
mod gateway;
mod process;
mod scratch;
mod storage;
mod time;

pub use builders::{
	accepted_event, assistant_item, message_item, outcome_event, tool_call_item, tool_result_item,
	turn_event, user_item,
};
#[cfg(unix)]
pub use docserver::DocServerTask;
#[cfg(unix)]
pub use envd::{
	AllowAdmission, EnvHarness, FramedEnvConnection, ProcessEnvHarness, connect_env, read_blob,
};
#[cfg(unix)]
pub use extension::{ExtensionHarness, recording_ui_factory};
#[cfg(unix)]
pub use gateway::ScriptedGateway;
pub use process::{OwnedProcess, install_omp_binary_env, omp_binary};
#[cfg(unix)]
pub use process::{process_group_alive, wait_process_group_dead};
pub use scratch::Scratch;
pub use storage::{reopen_journal, reopen_transcript};
pub use time::{DEFAULT_TIMEOUT, DeterministicBarrier, Gate, within};
