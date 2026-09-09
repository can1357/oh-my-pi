//! Bounded, authority-backed support shared by end-to-end proofs.

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
mod scripted;
mod storage;
mod time;

pub use builders::{assert_all_entries_caused, journal_entries};
#[cfg(unix)]
pub use docserver::DocServerTask;
#[cfg(unix)]
pub use envd::{
	AllowAdmission, EnvHarness, FramedEnvConnection, ProcessEnvHarness, connect_env, read_blob,
};
#[cfg(unix)]
pub use extension::{ExtensionRegistrar, LiveComponent};
#[cfg(unix)]
pub use gateway::GatewayInference;
pub use process::{OwnedProcess, install_omp_binary_env, omp_binary};
#[cfg(unix)]
pub use process::{process_group_alive, wait_process_group_dead};
pub use scratch::Scratch;
pub use scripted::{CapturedRequests, ScriptedInference, scripted_stream};
pub use storage::{create_session, reopen_session};
pub use time::{DEFAULT_TIMEOUT, DeterministicBarrier, Gate, within};
