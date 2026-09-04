#![feature(impl_trait_in_assoc_type)]
#![feature(duration_constructors)]
//! Typed, capability-complete inference contracts over one Tower service spine.
//!
//! Public callers retain operation-specific request and output types. Provider
//! registries erase that surface once, at construction, into
//! [`ProviderService`].

pub(crate) use omp_catalog as catalog;

pub mod account;
pub mod answer;
pub mod auth;
pub mod body;
pub mod call;
pub mod client;
pub mod codec;
pub mod debug_wire;
pub mod difficulty;
pub mod discovery;
pub mod error;
pub mod event;
pub mod gate;
pub mod id;
pub mod layer;
#[cfg(feature = "local")]
pub mod local;
pub mod operation;
pub mod plan;
pub mod provider;
pub mod realtime;
pub mod receipt;
pub mod recovery;
pub mod registry;
pub mod router;
pub mod search_settings;
pub mod session;
pub mod settings;
/// Backend-neutral local and hosted speech synthesis convars.
pub mod speech_settings;
pub mod staging;
pub mod transport;

pub use answer::*;
pub use call::*;
pub use client::*;
pub use codec::{
	BeforeRequestDenied, BeforeRequestDraft, BeforeRequestMutation, CredentialDisabledObservation,
	ModelsDiscoverHookPage, ModelsDiscoverHookRequest, ProviderHookCredential, ProviderHookError,
	ProviderHookObserver, ProviderLoginHookRequest, ProviderRefreshHookRequest,
	ProviderRefreshReason, ProviderResponseHooks, ProviderResponseObservation,
	ProviderResponseObserver, ProviderSignHookRequest, ProviderSignature,
};
pub use difficulty::*;
pub use error::*;
pub use event::*;
pub use id::*;
pub use layer::{
	answer::AnswerLayer,
	budget::{InferenceBudget, InferenceBudgetPolicy, InferenceLedger},
	hook::{HookHandle, NoHookHandle},
	recover::{DiscoveryProjector, RecoveryLayer},
	retry::{RetryNotice, RetrySink},
};
pub use omp_catalog::{
	capability::*,
	id::*,
	model::{ModelSpec, PolicyModel, WireTarget},
};
pub use plan::{
	ConstraintAssignment, ConstraintBudget, ConstraintBudgetCaps, ConstraintIntent, ExecutionPlan,
	ModelFallback, Planner,
};
pub use provider::ProviderService;
pub use receipt::*;
pub use registry::{Registry, RegistryBuilder, RegistryHandle, RegistrySnapshot, RouteUnavailable};
pub use settings::InferenceSettings;
