//! Versioned typed contract shared by eval `agent`, `parallel`, and `pipeline`
//! spawns.

use std::collections::HashSet;

use omp_core::Str;
pub use omp_tools::task::{
	ChildResult as SpawnResultV1, Fault as SpawnFaultV1, Payload as SpawnPayloadV1,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Current typed spawn contract revision.
pub const SPAWN_CONTRACT_REVISION: u16 = 1;

/// Eval helper which submitted a normalized spawn batch.
#[derive(
	Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, strum::Display, strum::EnumString,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum SpawnMode {
	/// One blocking or handled `agent()` call.
	Agent,
	/// Independent calls submitted by one `parallel()` barrier.
	Parallel,
	/// Ordered barrier stages submitted by `pipeline()`.
	Pipeline,
}

/// Requested schema failure behavior.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum SpawnSchemaMode {
	/// Preserve bounded invalid output with an override warning.
	#[default]
	Permissive,
	/// Return a structured schema-invalid terminal status.
	Strict,
}

/// Caller-selectable reasoning effort.
#[derive(
	Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, strum::Display, strum::EnumString,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum SpawnEffort {
	/// Minimal reasoning.
	Minimal,
	/// Low reasoning.
	Low,
	/// Medium reasoning.
	Medium,
	/// High reasoning.
	High,
	/// Extra-high reasoning.
	Xhigh,
	/// Maximum reasoning supported by the selected model.
	Max,
}

/// Requested workspace isolation and disposition.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SpawnIsolation {
	/// Create an isolated Environment workspace.
	pub requested: bool,
	/// Apply successful changes to the parent workspace.
	pub apply:     bool,
	/// Merge through a retained branch rather than a patch.
	pub merge:     bool,
}

/// One normalized spawn request.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SpawnRequestV1 {
	/// Contract revision; must equal [`SPAWN_CONTRACT_REVISION`].
	pub revision:      u16,
	/// Existing stable ID for a follow-up, otherwise absent for allocation.
	#[serde(default)]
	pub stable_id:     Option<Str>,
	/// Caller display name, distinct from the stable ID.
	#[serde(default)]
	pub name:          Option<Str>,
	/// Resolved agent definition name.
	pub agent:         Str,
	/// Complete child assignment.
	pub prompt:        Str,
	/// Normalized JSON Schema selected for the child result.
	#[serde(default)]
	pub output_schema: Option<Value>,
	/// Strict or permissive schema behavior.
	#[serde(default)]
	pub schema_mode:   SpawnSchemaMode,
	/// Optional caller effort before settings/model clamping.
	#[serde(default)]
	pub effort:        Option<SpawnEffort>,
	/// Isolation request and merge disposition.
	#[serde(default)]
	pub isolation:     SpawnIsolation,
	/// Explicit LSP enablement. Omission is false and never inherits true.
	#[serde(default)]
	pub enable_lsp:    bool,
}

/// Versioned submission envelope used by all three eval helper shapes.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnBatchV1 {
	/// Contract revision; must equal [`SPAWN_CONTRACT_REVISION`].
	pub revision: u16,
	/// Helper semantics which govern item ordering and barriers.
	pub mode:     SpawnMode,
	/// Shared context applied to every item after definition resolution.
	#[serde(default)]
	pub context:  Option<Str>,
	/// Ordered normalized requests.
	pub items:    Vec<SpawnRequestV1>,
}

impl SpawnBatchV1 {
	/// Validates revision, shape, identity uniqueness, and isolation invariants.
	pub fn validate(&self) -> Result<(), SpawnContractError> {
		if self.revision != SPAWN_CONTRACT_REVISION {
			return Err(SpawnContractError::UnsupportedRevision { revision: self.revision });
		}
		if self.items.is_empty() {
			return Err(SpawnContractError::EmptyBatch);
		}
		if self.mode == SpawnMode::Agent && self.items.len() != 1 {
			return Err(SpawnContractError::AgentCardinality { count: self.items.len() });
		}
		let mut ids = HashSet::new();
		let mut names = HashSet::new();
		for item in &self.items {
			item.validate()?;
			if let Some(id) = item.stable_id.as_ref()
				&& !ids.insert(id.as_str().to_ascii_lowercase())
			{
				return Err(SpawnContractError::DuplicateStableId { id: id.clone() });
			}
			if let Some(name) = item.name.as_ref()
				&& !names.insert(name.as_str().to_ascii_lowercase())
			{
				return Err(SpawnContractError::DuplicateName { name: name.clone() });
			}
		}
		Ok(())
	}

	/// Preflights each item independently so one registration error does not
	/// discard valid siblings.
	pub fn preflight_items(&self) -> Vec<Result<(), SpawnContractError>> {
		let mut ids = HashSet::new();
		let mut names = HashSet::new();
		self
			.items
			.iter()
			.map(|item| {
				item.validate()?;
				if let Some(id) = item.stable_id.as_ref()
					&& !ids.insert(id.as_str().to_ascii_lowercase())
				{
					return Err(SpawnContractError::DuplicateStableId { id: id.clone() });
				}
				if let Some(name) = item.name.as_ref()
					&& !names.insert(name.as_str().to_ascii_lowercase())
				{
					return Err(SpawnContractError::DuplicateName { name: name.clone() });
				}
				Ok(())
			})
			.collect()
	}
}

impl SpawnRequestV1 {
	/// Normalizes one authenticated eval bridge argument object.
	pub fn from_bridge_args(args: &Value) -> Result<Self, SpawnContractError> {
		let prompt = args
			.get("prompt")
			.and_then(Value::as_str)
			.ok_or(SpawnContractError::MissingBridgeField { field: "prompt" })?;
		let apply = args.get("apply").and_then(Value::as_bool).unwrap_or(false);
		let merge = args.get("merge").and_then(Value::as_bool).unwrap_or(false);
		let requested = args
			.get("isolated")
			.and_then(Value::as_bool)
			.unwrap_or(apply || merge);
		let schema_mode =
			args
				.get("schemaMode")
				.map_or(Ok(SpawnSchemaMode::Permissive), |value| {
					serde_json::from_value(value.clone()).map_err(|source| {
						SpawnContractError::InvalidBridgeField { field: "schemaMode", source }
					})
				})?;
		let effort = args
			.get("effort")
			.map(|value| {
				serde_json::from_value(value.clone())
					.map_err(|source| SpawnContractError::InvalidBridgeField { field: "effort", source })
			})
			.transpose()?;
		if args.get("schema").is_some() {
			return Err(SpawnContractError::LegacySchemaAlias);
		}
		let request = Self {
			revision: SPAWN_CONTRACT_REVISION,
			stable_id: args.get("stableId").and_then(Value::as_str).map(Str::from),
			name: args.get("name").and_then(Value::as_str).map(Str::from),
			agent: args
				.get("agent")
				.and_then(Value::as_str)
				.unwrap_or("task")
				.into(),
			prompt: prompt.into(),
			output_schema: args.get("outputSchema").cloned(),
			schema_mode,
			effort,
			isolation: SpawnIsolation { requested, apply, merge },
			enable_lsp: args
				.get("enableLsp")
				.and_then(Value::as_bool)
				.unwrap_or(false),
		};
		request.validate()?;
		Ok(request)
	}

	/// Validates one normalized request independently of its batch mode.
	pub fn validate(&self) -> Result<(), SpawnContractError> {
		if self.revision != SPAWN_CONTRACT_REVISION {
			return Err(SpawnContractError::UnsupportedRevision { revision: self.revision });
		}
		if self.prompt.trim().is_empty() {
			return Err(SpawnContractError::EmptyPrompt);
		}
		if self.agent.trim().is_empty() {
			return Err(SpawnContractError::EmptyAgent);
		}
		if let Some(name) = self.name.as_deref() {
			if name.len() > 32 {
				return Err(SpawnContractError::NameTooLong);
			}
			let mut bytes = name.bytes();
			if !bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
				|| !bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
			{
				return Err(SpawnContractError::InvalidName);
			}
		}
		if !self.isolation.requested && (self.isolation.apply || self.isolation.merge) {
			return Err(SpawnContractError::DispositionWithoutIsolation);
		}
		if self.isolation.apply && self.isolation.merge {
			return Err(SpawnContractError::ConflictingDisposition);
		}
		Ok(())
	}
}

/// Rejected normalized spawn contract.
#[derive(Debug, Error)]
pub enum SpawnContractError {
	/// Revision is not supported by this host.
	#[error("unsupported spawn contract revision {revision}")]
	UnsupportedRevision {
		/// Received revision.
		revision: u16,
	},
	/// An envelope omitted every item.
	#[error("spawn batch must contain at least one item")]
	EmptyBatch,
	/// `agent()` carried something other than exactly one request.
	#[error("agent spawn envelope requires exactly one item, received {count}")]
	AgentCardinality {
		/// Received item count.
		count: usize,
	},
	/// Two follow-up items target the same stable ID in one batch.
	#[error("spawn batch contains duplicate stable ID {id}")]
	DuplicateStableId {
		/// Duplicate stable ID.
		id: Str,
	},
	/// Two new items requested the same case-insensitive display name.
	#[error("spawn batch contains duplicate display name {name}")]
	DuplicateName {
		/// Duplicate display name.
		name: Str,
	},
	/// Caller display names are capped for routing and presentation.
	#[error("spawn display name exceeds 32 characters")]
	NameTooLong,
	/// Caller display name was not an ASCII routing identifier.
	#[error(
		"spawn display name must begin with a letter and contain only letters, digits, '_' or '-'"
	)]
	InvalidName,
	/// The removed `schema` alias was used instead of `outputSchema`.
	#[error("spawn field schema is unsupported; use outputSchema")]
	LegacySchemaAlias,
	/// A required authenticated bridge field was absent.
	#[error("spawn bridge field {field} is required")]
	MissingBridgeField {
		/// Missing field.
		field: &'static str,
	},
	/// A bridge field had the wrong typed shape or enum vocabulary.
	#[error("spawn bridge field {field} is invalid")]
	InvalidBridgeField {
		/// Invalid field.
		field:  &'static str,
		/// Typed JSON decoding failure.
		#[source]
		source: serde_json::Error,
	},
	/// Assignment was empty.
	#[error("spawn prompt must not be empty")]
	EmptyPrompt,
	/// Definition name was empty.
	#[error("spawn agent definition must not be empty")]
	EmptyAgent,
	/// Apply/merge was requested without isolation.
	#[error("spawn disposition requires isolation")]
	DispositionWithoutIsolation,
	/// Apply and branch merge were both selected.
	#[error("spawn apply and merge dispositions are mutually exclusive")]
	ConflictingDisposition,
}

#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;

	fn request(name: Option<&str>) -> SpawnRequestV1 {
		SpawnRequestV1 {
			revision:      SPAWN_CONTRACT_REVISION,
			stable_id:     None,
			name:          name.map(Str::from),
			agent:         sf!("task"),
			prompt:        sf!("do work"),
			output_schema: None,
			schema_mode:   SpawnSchemaMode::Permissive,
			effort:        None,
			isolation:     SpawnIsolation::default(),
			enable_lsp:    false,
		}
	}

	#[test]
	fn caller_name_is_distinct_from_stable_id_and_label_is_not_accepted() {
		let decoded: SpawnRequestV1 = serde_json::from_value(serde_json::json!({
			"revision": 1,
			"name": "Reviewer",
			"agent": "reviewer",
			"prompt": "review"
		}))
		.unwrap();
		assert_eq!(decoded.name.as_deref(), Some("Reviewer"));
		assert!(decoded.stable_id.is_none());
		assert!(!decoded.enable_lsp);
		assert!(
			serde_json::from_value::<SpawnRequestV1>(serde_json::json!({
				"revision": 1,
				"label": "legacy",
				"agent": "task",
				"prompt": "work"
			}))
			.is_err()
		);
	}

	#[test]
	fn bridge_arguments_normalize_into_the_versioned_contract() {
		let request = SpawnRequestV1::from_bridge_args(&serde_json::json!({
			"prompt": "inspect",
			"agent": "scout",
			"name": "ScoutOne",
			"effort": "low",
			"isolated": true,
			"apply": true
		}))
		.unwrap();
		assert_eq!(request.revision, SPAWN_CONTRACT_REVISION);
		assert_eq!(request.name.as_deref(), Some("ScoutOne"));
		assert_eq!(request.effort, Some(SpawnEffort::Low));
		assert!(request.isolation.requested);
		assert!(request.isolation.apply);
	}

	#[test]
	fn every_helper_shape_uses_the_same_validated_item_contract() {
		for mode in [SpawnMode::Agent, SpawnMode::Parallel, SpawnMode::Pipeline] {
			let batch =
				SpawnBatchV1 { revision: 1, mode, context: None, items: vec![request(Some("Worker"))] };
			batch.validate().unwrap();
		}
	}

	#[test]
	fn isolation_disposition_is_rejected_without_isolation() {
		let mut request = request(None);
		request.isolation.apply = true;
		assert!(matches!(request.validate(), Err(SpawnContractError::DispositionWithoutIsolation)));
	}
}
