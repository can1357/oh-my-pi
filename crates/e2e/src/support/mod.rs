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
#[cfg(unix)]
mod granted;
#[cfg(unix)]
mod owned_groups;
mod process;
#[cfg(unix)]
mod pyext;
mod scratch;
mod scripted;
mod storage;
mod stream_rules;
mod time;

pub use builders::{assert_all_entries_caused, journal_entries};
#[cfg(unix)]
pub use docserver::DocServerTask;
#[cfg(unix)]
pub use envd::{
	AllowAdmission, EnvHarness, FramedEnvConnection, InProcessConnection, InProcessEnvHarness,
	InProcessServing, ProcessEnvHarness, RawEnvConnection, connect_env, read_blob,
};
#[cfg(unix)]
pub use extension::{ExtensionRegistrar, LiveComponent};
#[cfg(unix)]
pub use gateway::GatewayInference;
#[cfg(unix)]
pub use granted::{Admission, AgentsLease, OperatorHome, install_agents_owner};
pub use process::{OwnedProcess, install_omp_binary_env, omp_binary};
#[cfg(unix)]
pub use process::{process_group_alive, wait_process_group_dead};
#[cfg(unix)]
pub use pyext::PythonExtension;
pub use scratch::Scratch;
pub use scripted::{CapturedRequests, ScriptedInference, hanging_stream, scripted_stream};
pub use storage::{create_session, reopen_session};
pub use stream_rules::{guard_directors, text_response};
pub use time::{DEFAULT_TIMEOUT, DeterministicBarrier, Gate, within};
