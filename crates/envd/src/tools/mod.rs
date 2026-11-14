//! Production built-in tool registry assembly.
//!
//! Bridges, hook CONTROL, and registry assembly live in sibling modules. Paths
//! and privacy match the previous single file.

mod bridges;
mod hooks;
mod registry;
mod roster_host;

pub use bridges::{
	ActiveContentInputs, CommandCredentialExecutorFactory, ContentResolver, DynamicTool,
	DynamicToolFactory, GoalAuthority, HostResourceResult, HostResources, HostUriJudgment,
	InvocationEditor, RegistryBridges, SearchInference, TelemetryUpload, invocation_acp_documents,
	invocation_approvals, with_invocation_approvals,
};
pub(super) use bridges::{
	InvocationAcpBackends, InvocationEditRepairContext, invocation_output_request,
	invocation_session_id, pty_denied, with_acp_scope, with_edit_repair_scope,
	with_invocation_scope, with_invocation_session_scope, with_output_request_scope,
};
pub(crate) use bridges::{invocation_reflection, with_invocation_reflection};
pub use hooks::{
	HookControlFactory, HookEventPolicy, HookFailurePolicy, HookFieldComposition, HookSubscription,
};
#[cfg(test)]
pub(super) use registry::python_engine;
#[cfg(test)]
pub use registry::worker_spec;
pub use registry::{
	AgentCheckpointControl, DeviceCatalogObserver, DeviceControlFactory, DeviceInvocationAdmission,
	DynamicDeviceCatalogEntry, RegistryControlFactory,
};
pub(crate) use registry::{
	SessionRegistryBridges, build_environment_declaration_inputs, environment_tool_names,
	production_registry, session_registry,
};
