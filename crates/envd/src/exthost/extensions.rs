//! Python extension-host adapters and sealed CONTROL declaration evidence.

use std::{
	collections::{BTreeMap, BTreeSet},
	str::FromStr as _,
	sync::Arc,
	time::{Duration, Instant},
};

use bytes::Bytes;
use omp_agent::{
	BindValue, BoxFut, Director, DirectorCx, DirectorEffect, DirectorError, ExtensionRegistrar,
	LiveComponent, LiveComponentError, MutDirectorCx, Prepared, Slot, StateUpdate, TurnView,
	Verdict,
};
use omp_con::{Ctx, DynamicVarSpec, Origin, TypeSpec, Value as ConValue, VarFlags};
use omp_core::{Provenance, Str, sf};
use omp_dom::{Node, Op, Txn};
use omp_ext::config::{SettingSchema, SettingType, extension_setting_convar_name};
use omp_journal::{Entry, Kind};
use omp_proto::{
	inference::v1::{Fallback, ToolDef, tool_def},
	policy::v1::EffectEnvelope,
	toolhost::v1::{
		GrammarConstraint, GrammarSyntax, PreludeParam, PreludeParamKind, SchemaConstraint,
		ToolConstraint, ToolDecl, ToolExample, ToolExecutionMode, tool_constraint,
	},
	ui::v1::{CommandArgDecl, CommandDecl, RegisterUi, ShortcutDecl, TriggerDecl},
};
use omp_session::{Component, Draft, SessionError};
use omp_tool::{Rev, ToolIdentity};
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::{Map, Value as JsonValue, json};
use thiserror::Error;

use super::{
	CallbackConcurrency, EventDeadline, ExtensionManifest, PromptSlotBinding,
	VerifiedMarkdownTransformer, VerifiedMessageRendererDeclaration, VerifiedRendererDeclaration,
	VerifiedUiRoster,
	control::{
		ControlConnectionIdentity, ControlDispatch, ControlHandle, ControlInvocationAuthority,
	},
	dispatch::prompt_slot_binding,
	services::{ServiceKey, ServiceMethodSchema, ServiceProviderDeclaration},
	verify_ui_registration,
};
use crate::tools::{HookFailurePolicy, HookFieldComposition};

/// Default bounded callback wait; composition may inject `sv_ext_hook_timeout`.
pub const DEFAULT_EXTENSION_HOOK_TIMEOUT: Duration = Duration::from_secs(5);

/// A Python callback could not produce a valid engine registration result.
#[derive(Debug, Error)]
pub enum PyExtensionError {
	/// The extension callback timed out.
	#[error("Python extension callback timed out")]
	Timeout,
	/// No Tokio runtime was available to drive the CONTROL dispatch.
	#[error("Python extension callback has no runtime")]
	NoRuntime,
	/// The extension-host CONTROL dispatch failed.
	#[error(transparent)]
	Control(#[from] super::control::ControlRuntimeError),
	/// The callback returned an invalid result shape.
	#[error("Python extension callback returned an invalid result")]
	InvalidResult,
	/// A returned DOM patch was malformed.
	#[error("Python extension callback returned malformed DOM operations")]
	InvalidOps(#[source] serde_json::Error),
	/// Journaling the callback result failed.
	#[error(transparent)]
	Session(#[from] SessionError),
}

/// Failure while installing manifest settings into the shared control plane.
#[derive(Debug, Error)]
pub enum ExtensionConvarError {
	/// A setting had neither a manifest default nor an admitted effective value.
	#[error("extension {extension} setting {key} has no value to seed its convar")]
	MissingValue {
		/// Extension identity.
		extension: Str,
		/// Manifest setting key.
		key:       Str,
	},
	/// A resolved value did not match its manifest-declared setting kind.
	#[error("extension {extension} setting {key} does not match its declared type")]
	InvalidValue {
		/// Extension identity.
		extension: Str,
		/// Manifest setting key.
		key:       Str,
	},
	/// Curated UI metadata was not safe to expose in the product settings panel.
	#[error("extension {extension} setting {key} has invalid settings UI metadata")]
	InvalidUi {
		/// Extension identity.
		extension: Str,
		/// Manifest setting key.
		key:       Str,
	},
	/// The control plane rejected a dynamic declaration or effective value.
	#[error("extension {extension} setting {key} could not be installed")]
	Control {
		/// Extension identity.
		extension: Str,
		/// Manifest setting key.
		key:       Str,
		/// Typed control-plane failure.
		#[source]
		source:    omp_con::ConError,
	},
}

/// Registers every admitted extension setting as a dynamic control variable.
///
/// Names are owner-qualified as `ext::<extension>::<key>`. Registration uses
/// the manifest default as the persistence baseline and commits a different
/// admitted launch value to the session layer.
pub fn register_extension_setting_convars(
	ctx: &Ctx,
	extension: &str,
	settings: &BTreeMap<Str, SettingSchema>,
	resolved: &serde_json::Map<String, JsonValue>,
) -> Result<(), ExtensionConvarError> {
	for (key, schema) in settings {
		let effective = resolved.get(key.as_str());
		let baseline = match schema.default.as_ref() {
			Some(default) => serde_json::to_value(default)
				.ok()
				.as_ref()
				.and_then(|value| convar_value(schema, value)),
			None => effective.and_then(|value| convar_value(schema, value)),
		}
		.ok_or_else(|| ExtensionConvarError::MissingValue {
			extension: Str::new(extension),
			key:       key.clone(),
		})?;
		let name = extension_setting_convar_name(extension, key);
		let mut meta = Vec::new();
		if let Some(ui) = &schema.ui {
			if ui.group.trim().is_empty()
				|| ui.label.trim().is_empty()
				|| ui.label == name
				|| ui.label.contains("::")
				|| ui.options.iter().enumerate().any(|(index, option)| {
					option.label.trim().is_empty()
						|| ui.options[..index]
							.iter()
							.any(|previous| previous.value == option.value)
				}) {
				return Err(ExtensionConvarError::InvalidUi {
					extension: Str::new(extension),
					key:       key.clone(),
				});
			}
			let tab: &'static str = ui.tab.into();
			meta.push((Str::new("ui.tab"), Str::new(tab)));
			meta.push((Str::new("ui.group"), ui.group.clone()));
			meta.push((Str::new("ui.label"), ui.label.clone()));
			meta.push((Str::new("ui.description"), ui.description.clone()));
			if let Some(warning) = &ui.warning {
				meta.push((Str::new("ui.warning"), warning.clone()));
			}
			for option in &ui.options {
				meta.push((sf!("ui.option.{}", option.value), option.label.clone()));
				meta.push((sf!("ui.option.{}.desc", option.value), option.description.clone()));
			}
			if ui.ordered {
				meta.push((Str::new("ui.ordered"), Str::new("true")));
			}
		}
		ctx.register_dynamic_var(DynamicVarSpec {
			name:    name.clone(),
			desc:    schema
				.description
				.clone()
				.unwrap_or_else(|| sf!("Setting {key} declared by extension {extension}")),
			ty:      convar_type(schema),
			flags:   VarFlags::ARCHIVE
				.with(VarFlags::SESSION)
				.with(VarFlags::REPLICATED),
			default: baseline.clone(),
			meta:    meta.into(),
		})
		.map_err(|source| ExtensionConvarError::Control {
			extension: Str::new(extension),
			key: key.clone(),
			source,
		})?;
		if let Some(effective) = effective {
			let effective =
				convar_value(schema, effective).ok_or_else(|| ExtensionConvarError::InvalidValue {
					extension: Str::new(extension),
					key:       key.clone(),
				})?;
			if effective != baseline {
				ctx.set(name.as_str(), effective, Origin::Session)
					.map_err(|source| ExtensionConvarError::Control {
						extension: Str::new(extension),
						key: key.clone(),
						source,
					})?;
			}
		}
	}
	Ok(())
}

fn convar_type(schema: &SettingSchema) -> &'static TypeSpec {
	match schema.kind {
		SettingType::Boolean => TypeSpec::BOOL,
		SettingType::Number => TypeSpec::FLOAT,
		SettingType::String | SettingType::Enum => TypeSpec::STR,
	}
}

fn convar_value(schema: &SettingSchema, value: &JsonValue) -> Option<ConValue> {
	match schema.kind {
		SettingType::Boolean => value.as_bool().map(ConValue::Bool),
		SettingType::Number => value.as_f64().map(ConValue::Float),
		SettingType::String => value.as_str().map(|value| ConValue::Str(Str::new(value))),
		SettingType::Enum => {
			let value = value.as_str()?;
			schema
				.values
				.iter()
				.any(|allowed| allowed == value)
				.then(|| ConValue::Str(Str::new(value)))
		},
	}
}

/// One manifest-verified runtime hook subscription.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedHookRegistration {
	/// Stable event name.
	pub event:            Str,
	/// Frozen hook phase.
	pub phase:            Str,
	/// Stable callback name selected inside Python.
	pub name:             Str,
	/// Deterministic callback order.
	pub order:            i32,
	/// Optional callback failure override.
	pub on_failure:       Option<HookFailurePolicy>,
	/// Optional callback timeout override.
	pub timeout:          Option<Duration>,
	/// Declared callback overlap behavior.
	pub concurrency:      CallbackConcurrency,
	/// Provider ids admitted by this callback.
	pub providers:        Option<Box<[Str]>>,
	/// Exact raw MCP mount names admitted by this callback.
	pub servers:          Option<Box<[Str]>>,
	/// Anchored MCP JSON-RPC method globs.
	pub method_globs:     Box<[Str]>,
	/// Exact event payload/decision revision.
	pub event_revision:   u16,
	/// Event-level callback failure default.
	pub event_on_failure: HookFailurePolicy,
	/// Event default decision for an all-deferred composition.
	pub event_default:    JsonValue,
	/// Event-level callback deadline.
	pub event_timeout:    Duration,
	/// Event field composition declarations.
	pub composition:      BTreeMap<Str, HookFieldComposition>,
}

/// One manifest-authenticated initial device availability fact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedToolAvailability {
	/// Exact declared device name.
	pub name:    Str,
	/// Exact compatibility family.
	pub family:  Str,
	/// Exact declaration revision.
	pub rev:     u16,
	/// Whether the route starts mounted in this generation.
	pub mounted: bool,
	/// Typed human-readable reason for an unavailable route.
	pub reason:  Option<Str>,
}

/// Exact sealed registry publication accepted from one authenticated host.
#[derive(Clone, Debug)]
pub struct SealedRegistryEvidence {
	/// Connection identity whose generation published this evidence.
	pub identity:        Arc<ControlConnectionIdentity>,
	/// Host-authenticated session identity used by callbacks.
	pub session:         Option<Str>,
	/// Core-authenticated installation provenance.
	pub provenance:      Provenance,
	/// Full executable tool declarations.
	pub tools:           Arc<[ToolDecl]>,
	/// Prompt renderers dispatched through CONTROL.
	pub prompts:         Arc<[PromptSlotBinding]>,
	/// Service providers dispatched through CONTROL.
	pub services:        Arc<[ServiceProviderDeclaration]>,
	/// Verified runtime hook subscriptions.
	pub hooks:           Arc<[SealedHookRegistration]>,
	/// Raw UI declaration used by the lifecycle register transition.
	pub ui_registration: RegisterUi,
	/// Manifest-verified UI roster.
	pub ui:              VerifiedUiRoster,
	/// Initial root-device availability, sealed separately from identity.
	pub availability:    Arc<[SealedToolAvailability]>,
	/// Full frozen provider declaration documents.
	pub providers:       Arc<[JsonValue]>,
	/// Python lifecycle declarations registered as Directors.
	pub directors:       Arc<[JsonValue]>,
	/// Python state declarations registered as Components.
	pub components:      Arc<[JsonValue]>,
}

impl SealedRegistryEvidence {
	/// Returns whether two generations published byte-equivalent declaration
	/// tables.
	pub fn same_declarations(&self, other: &Self) -> bool {
		self.tools == other.tools
			&& self.prompts == other.prompts
			&& self.services == other.services
			&& self.hooks == other.hooks
			&& self.ui_registration.commands == other.ui_registration.commands
			&& self.ui_registration.shortcuts == other.ui_registration.shortcuts
			&& self.ui_registration.triggers == other.ui_registration.triggers
			&& self.ui_registration.renderers == other.ui_registration.renderers
			&& self.ui_registration.props == other.ui_registration.props
			&& self.ui.commands == other.ui.commands
			&& self.ui.shortcuts == other.ui.shortcuts
			&& self.ui.triggers == other.ui.triggers
			&& self.ui.message_renderers == other.ui.message_renderers
			&& self.ui.markdown_transformers == other.ui.markdown_transformers
			&& self.ui.renderers == other.ui.renderers
			&& self.providers == other.providers
			&& self.directors == other.directors
			&& self.components == other.components
	}
}

/// Rejection while sealing a FREEZE acknowledgment.
#[derive(Debug, Error)]
pub enum SealedRegistryEvidenceError {
	/// Authenticated connection identity does not match the deployment manifest.
	#[error("registry publication identity does not match its deployment manifest")]
	Identity,
	/// Registry publication was malformed.
	#[error("registry publication is malformed")]
	Malformed,
	/// Frozen runtime declarations differ from the authenticated manifest.
	#[error("registry publication differs from authenticated manifest")]
	ManifestDrift,
	/// One declaration was duplicated.
	#[error("registry publication contains a duplicate declaration")]
	Duplicate,
	/// A declaration came from a module outside the admitted module set.
	#[error("registry declaration source module is not admitted")]
	SourceModule,
	/// A typed UI declaration was invalid.
	#[error(transparent)]
	Ui(#[from] super::lifecycle::UiRegistrationError),
	/// A prompt declaration was invalid.
	#[error(transparent)]
	Prompt(#[from] super::dispatch::PromptDispatchError),
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
struct FrozenDeclarationKey {
	kind: Str,
	key:  Str,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
struct FrozenCallback {
	#[serde(rename = "$omp.callable")]
	callable: String,
}

#[derive(Deserialize)]
struct FrozenTool {
	name:          String,
	#[serde(default)]
	family:        String,
	rev:           u16,
	#[serde(default)]
	description:   String,
	schema:        JsonValue,
	#[serde(default)]
	strict:        Option<bool>,
	#[serde(default)]
	streams_args:  bool,
	source_module: String,
	kind:          String,
	place:         String,
	#[serde(default)]
	effects:       Option<JsonValue>,
	#[serde(default)]
	constraint:    Option<JsonValue>,
	#[serde(default)]
	serial:        bool,
	#[serde(default)]
	precedence:    u32,
	#[serde(default)]
	replaces:      Option<String>,
	#[serde(default)]
	summary:       Option<String>,
	#[serde(default)]
	docs:          JsonValue,
	#[serde(default)]
	examples:      Vec<JsonValue>,
	callback:      FrozenToolCallback,
}

#[derive(Deserialize)]
struct FrozenToolCallback {
	operation: String,
	path:      String,
	#[serde(default)]
	family:    String,
	rev:       u16,
}

#[derive(Deserialize)]
struct FrozenPrelude {
	name:          String,
	rev:           u16,
	#[serde(default)]
	doc:           String,
	#[serde(default)]
	summary:       String,
	source_module: String,
	#[serde(default)]
	params:        Vec<FrozenPreludeParam>,
	callback:      FrozenToolCallback,
}

#[derive(Deserialize)]
struct FrozenPreludeParam {
	name:         String,
	kind:         String,
	#[serde(default)]
	default_json: Option<String>,
	#[serde(default)]
	annotation:   Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct FrozenAvailability {
	name:    String,
	#[serde(default)]
	family:  String,
	rev:     u16,
	mounted: bool,
	#[serde(default)]
	reason:  Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
struct FrozenHook {
	event:            Str,
	phase:            Str,
	name:             Str,
	order:            i32,
	on_failure:       Option<Str>,
	timeout:          Option<Str>,
	concurrency:      usize,
	threadsafe:       bool,
	callback:         FrozenCallback,
	#[serde(default)]
	when:             Option<FrozenHookWhen>,
	event_rev:        u16,
	event_on_failure: Str,
	event_default:    Option<Str>,
	event_timeout:    Str,
	#[serde(default)]
	composition:      BTreeMap<Str, Str>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
struct FrozenHookWhen {
	#[serde(default)]
	provider:     Option<Vec<Str>>,
	#[serde(default)]
	server:       Option<Vec<Str>>,
	#[serde(default)]
	method_globs: Vec<Str>,
}

#[derive(Deserialize)]
struct FrozenService {
	name:          String,
	rev:           u32,
	source_module: String,
	methods:       Vec<ServiceMethodSchema>,
	callback:      FrozenOperationCallback,
}

#[derive(Deserialize)]
struct FrozenOperationCallback {
	operation: String,
}

#[derive(Deserialize)]
struct FrozenRegistry {
	declaration_keys:      Vec<FrozenDeclarationKey>,
	tools:                 Vec<FrozenTool>,
	#[serde(default)]
	preludes:              Vec<FrozenPrelude>,
	#[serde(default)]
	availability:          Vec<FrozenAvailability>,
	hooks:                 Vec<FrozenHook>,
	services:              Vec<FrozenService>,
	prompt_slots:          Vec<JsonValue>,
	#[serde(default)]
	commands:              Vec<FrozenCommand>,
	#[serde(default)]
	shortcuts:             Vec<FrozenShortcut>,
	#[serde(default)]
	completions:           Vec<FrozenCompletion>,
	#[serde(default)]
	message_renderers:     Vec<FrozenNamedUiCallback>,
	#[serde(default)]
	markdown_transformers: Vec<FrozenNamedUiCallback>,
	#[serde(default)]
	verdict_renderers:     Vec<FrozenRenderer>,
	providers:             Vec<JsonValue>,
	directors:             Vec<JsonValue>,
	components:            Vec<JsonValue>,
}

#[derive(Deserialize)]
struct FrozenCommandArg {
	name:        String,
	#[serde(default)]
	description: String,
	#[serde(default)]
	usage:       Option<String>,
}

#[derive(Deserialize)]
struct FrozenCommand {
	name:            String,
	#[serde(default)]
	aliases:         Vec<String>,
	#[serde(default)]
	description:     String,
	#[serde(default)]
	args:            Vec<FrozenCommandArg>,
	#[serde(default)]
	hint:            Option<String>,
	#[serde(default)]
	arg_completions: Option<FrozenCallback>,
	handler:         FrozenCallback,
	#[serde(default)]
	trigger:         String,
}

#[derive(Deserialize)]
struct FrozenShortcut {
	chord:       String,
	action_id:   String,
	#[serde(default)]
	description: String,
	#[serde(default)]
	when:        Option<Vec<String>>,
	handler:     FrozenCallback,
	#[serde(default)]
	trigger:     String,
}

#[derive(Deserialize)]
struct FrozenNamedUiCallback {
	kind:    String,
	name:    String,
	value:   FrozenCallback,
	trigger: String,
}

#[derive(Deserialize)]
struct FrozenRendererValue {
	function:  FrozenCallback,
	#[serde(default)]
	reduce:    Option<FrozenCallback>,
	#[serde(default)]
	decorates: bool,
}

#[derive(Deserialize)]
struct FrozenRenderer {
	kind:    String,
	name:    (String, String, u16),
	value:   FrozenRendererValue,
	trigger: String,
}

#[derive(Deserialize)]
struct FrozenCompletion {
	kind:     String,
	name:     String,
	value:    FrozenCallback,
	metadata: FrozenCompletionTrigger,
	trigger:  String,
}

#[derive(Deserialize)]
struct FrozenCompletionTrigger {
	prefix:         String,
	#[serde(default)]
	at_line_start:  bool,
	#[serde(default)]
	min_chars:      u32,
	#[serde(default = "default_completion_debounce")]
	debounce:       JsonValue,
	#[serde(default = "default_completion_max_results")]
	max_results:    u32,
	#[serde(default = "default_completion_cache")]
	cache:          JsonValue,
	#[serde(default = "default_completion_refine_locally")]
	refine_locally: bool,
}

fn default_completion_debounce() -> JsonValue {
	JsonValue::String("90ms".to_owned())
}

const fn default_completion_max_results() -> u32 {
	20
}

fn default_completion_cache() -> JsonValue {
	JsonValue::String("2s".to_owned())
}

const fn default_completion_refine_locally() -> bool {
	true
}

/// Seals one complete FREEZE acknowledgment against authenticated manifest
/// facts.
pub fn seal_registry_evidence(
	identity: Arc<ControlConnectionIdentity>,
	session: Str,
	manifest: &ExtensionManifest,
	payload: JsonValue,
) -> Result<SealedRegistryEvidence, SealedRegistryEvidenceError> {
	if manifest.provenance.extension_id() != identity.extension.as_str()
		|| manifest.provenance.layer() != identity.layer.as_str()
		|| manifest.provenance.tier() != identity.tier.as_str()
		|| manifest.provenance.artifact_digest().to_string() != identity.artifact_digest.as_str()
	{
		return Err(SealedRegistryEvidenceError::Identity);
	}
	let mut frozen: FrozenRegistry =
		serde_json::from_value(payload).map_err(|_| SealedRegistryEvidenceError::Malformed)?;
	frozen.declaration_keys.sort();
	if frozen
		.declaration_keys
		.windows(2)
		.any(|rows| rows[0] == rows[1])
	{
		return Err(SealedRegistryEvidenceError::Duplicate);
	}
	validate_declaration_keys(manifest, &frozen.declaration_keys)?;

	let availability = seal_availability(&frozen.tools, frozen.availability)?;
	let mut tools = seal_tools(manifest, frozen.tools)?;
	tools.extend(seal_preludes(manifest, frozen.preludes)?);
	let prompts = seal_prompts(manifest, &identity, frozen.prompt_slots)?;
	let services = seal_services(manifest, frozen.services)?;
	let hooks = seal_hooks(manifest, frozen.hooks)?;
	let providers = seal_documents(manifest, "provider", frozen.providers)?;
	validate_callback_documents(manifest, "director", &frozen.directors)?;
	validate_callback_documents(manifest, "component", &frozen.components)?;
	let (ui_registration, ui) = seal_ui(
		manifest,
		&identity,
		frozen.commands,
		frozen.shortcuts,
		frozen.completions,
		frozen.message_renderers,
		frozen.markdown_transformers,
		frozen.verdict_renderers,
	)?;

	Ok(SealedRegistryEvidence {
		identity,
		session: Some(session),
		provenance: manifest.provenance.clone(),
		tools: tools.into(),
		prompts: prompts.into(),
		services: services.into(),
		hooks: hooks.into(),
		ui_registration,
		ui,
		availability: availability.into(),
		providers: providers.into(),
		directors: frozen.directors.into(),
		components: frozen.components.into(),
	})
}

fn validate_declaration_keys(
	manifest: &ExtensionManifest,
	actual: &[FrozenDeclarationKey],
) -> Result<(), SealedRegistryEvidenceError> {
	if manifest.has_uniform_declarations() && !manifest.runtime_declarations_trusted() {
		let executable =
			|kind: &str| {
				matches!(
					kind,
					"soft"
						| "hard" | "hook"
						| "director" | "component"
						| "worker" | "provider"
						| "prompt_slot"
						| "command" | "shortcut"
						| "completion"
						| "message_renderer"
						| "markdown_transformer"
						| "verdict_renderer"
						| "telemetry"
						| "service"
				)
			};
		let expected = manifest
			.static_declarations()
			.ordered
			.iter()
			.filter(|row| executable(row.kind.as_str()))
			.map(|row| FrozenDeclarationKey { kind: row.kind.clone(), key: row.key.clone() })
			.collect::<BTreeSet<_>>();
		let actual = actual.iter().cloned().collect::<BTreeSet<_>>();
		if expected != actual {
			return Err(SealedRegistryEvidenceError::ManifestDrift);
		}
	}
	Ok(())
}

fn seal_tools(
	manifest: &ExtensionManifest,
	rows: Vec<FrozenTool>,
) -> Result<Vec<ToolDecl>, SealedRegistryEvidenceError> {
	let expected = manifest
		.declarations
		.tools()
		.filter(|tool| tool.family.as_str() != "prelude")
		.map(|tool| (tool.name.as_str(), tool.family.as_str(), tool.rev))
		.collect::<BTreeSet<_>>();
	let actual = rows
		.iter()
		.map(|tool| (tool.name.as_str(), tool.family.as_str(), tool.rev))
		.collect::<BTreeSet<_>>();
	if actual.len() != rows.len() {
		return Err(SealedRegistryEvidenceError::Duplicate);
	}
	if !manifest.runtime_declarations_trusted() && expected != actual {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	rows
		.into_iter()
		.map(|row| seal_tool(manifest, row))
		.collect()
}

fn seal_preludes(
	manifest: &ExtensionManifest,
	rows: Vec<FrozenPrelude>,
) -> Result<Vec<ToolDecl>, SealedRegistryEvidenceError> {
	let expected = manifest
		.declarations
		.tools()
		.filter(|tool| tool.family.as_str() == "prelude")
		.map(|tool| (tool.name.as_str(), tool.rev))
		.collect::<BTreeSet<_>>();
	let actual = rows
		.iter()
		.map(|row| (row.name.as_str(), row.rev))
		.collect::<BTreeSet<_>>();
	if actual.len() != rows.len() {
		return Err(SealedRegistryEvidenceError::Duplicate);
	}
	if !manifest.runtime_declarations_trusted() && expected != actual {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	rows
		.into_iter()
		.map(|row| {
			if row.name.is_empty()
				|| row.rev == 0
				|| row.source_module.is_empty()
				|| row.callback.operation != "omp.devices.call"
				|| row.callback.path != row.name
				|| row.callback.family != "prelude"
				|| row.callback.rev != row.rev
				|| manifest_module_for_callback(manifest, &row.source_module)? != row.source_module
			{
				return Err(SealedRegistryEvidenceError::Malformed);
			}
			let mut names = BTreeSet::new();
			let mut keyword_only = false;
			let mut positional_default = false;
			let params = row
				.params
				.into_iter()
				.map(|param| {
					if param.name.is_empty() || !names.insert(param.name.clone()) {
						return Err(SealedRegistryEvidenceError::Duplicate);
					}
					let kind = match param.kind.as_str() {
						"positional_or_keyword" if !keyword_only => {
							if param.default_json.is_some() {
								positional_default = true;
							} else if positional_default {
								return Err(SealedRegistryEvidenceError::Malformed);
							}
							PreludeParamKind::PositionalOrKeyword
						},
						"keyword_only" => {
							keyword_only = true;
							PreludeParamKind::KeywordOnly
						},
						_ => return Err(SealedRegistryEvidenceError::Malformed),
					};
					let default_json = param
						.default_json
						.map(|raw| {
							serde_json::from_str::<JsonValue>(&raw)
								.map_err(|_| SealedRegistryEvidenceError::Malformed)?;
							Ok::<Bytes, SealedRegistryEvidenceError>(Bytes::from(raw.into_bytes()))
						})
						.transpose()?;
					Ok(PreludeParam {
						name: param.name,
						kind: kind as i32,
						default_json,
						annotation: param.annotation,
						..Default::default()
					})
				})
				.collect::<Result<Vec<_>, _>>()?;
			Ok(ToolDecl {
				definition: Some(ToolDef {
					name:        row.name,
					description: row.summary.clone(),
					input:       Some(tool_def::Input::JsonSchema(tool_def::JsonSchema {
						schema_json: Bytes::from_static(
							br#"{"type":"object","additionalProperties":true}"#,
						),
						strict:      None,
					})),
				}),
				rev: format!("prelude.{}", row.rev),
				extension_id: row.source_module,
				summary: row.summary,
				docs: row.doc,
				prelude_params: params,
				kind: String::from("soft"),
				execution_mode: ToolExecutionMode::Parallel as i32,
				place: String::from("host"),
				..Default::default()
			})
		})
		.collect()
}

fn seal_availability(
	tools: &[FrozenTool],
	rows: Vec<FrozenAvailability>,
) -> Result<Vec<SealedToolAvailability>, SealedRegistryEvidenceError> {
	let expected = tools
		.iter()
		.filter(|tool| matches!(tool.kind.as_str(), "soft" | "hard"))
		.map(|tool| (tool.name.clone(), tool.family.clone(), tool.rev))
		.collect::<BTreeSet<_>>();
	let actual = rows
		.iter()
		.map(|row| (row.name.clone(), row.family.clone(), row.rev))
		.collect::<BTreeSet<_>>();
	if actual.len() != rows.len() {
		return Err(SealedRegistryEvidenceError::Duplicate);
	}
	if expected != actual {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	rows
		.into_iter()
		.map(|row| {
			if row.name.is_empty() || row.rev == 0 || row.mounted && row.reason.is_some() {
				return Err(SealedRegistryEvidenceError::Malformed);
			}
			Ok(SealedToolAvailability {
				name:    Str::from(row.name),
				family:  Str::from(row.family),
				rev:     row.rev,
				mounted: row.mounted,
				reason:  row.reason.map(Str::from),
			})
		})
		.collect()
}

fn seal_tool(
	manifest: &ExtensionManifest,
	row: FrozenTool,
) -> Result<ToolDecl, SealedRegistryEvidenceError> {
	if row.name.is_empty()
		|| row.source_module.is_empty()
		|| !matches!(row.kind.as_str(), "soft" | "hard" | "legacy")
		|| row.place.is_empty()
		|| row.callback.operation != "omp.devices.call"
		|| row.callback.path != row.name
		|| row.callback.family != row.family
		|| row.callback.rev != row.rev
	{
		return Err(SealedRegistryEvidenceError::Malformed);
	}
	let module = manifest_module_for_callback(manifest, &row.source_module)?;
	if module != row.source_module {
		return Err(SealedRegistryEvidenceError::SourceModule);
	}
	if manifest.has_uniform_declarations() && !manifest.runtime_declarations_trusted() {
		let key = format!("{}@{}.{}", row.name, row.family, row.rev);
		let declaration = manifest
			.static_declarations()
			.tools
			.iter()
			.find(|declaration| declaration.key.as_str() == key)
			.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
		if declaration.kind.as_str() != row.kind || declaration.module.as_str() != row.source_module {
			return Err(SealedRegistryEvidenceError::ManifestDrift);
		}
	}
	let schema_json = if let Some(schema) = row.schema.as_str() {
		serde_json::from_str::<JsonValue>(schema)
			.ok()
			.filter(JsonValue::is_object)
			.ok_or(SealedRegistryEvidenceError::Malformed)?;
		schema.as_bytes().to_vec()
	} else {
		if !row.schema.is_object() {
			return Err(SealedRegistryEvidenceError::Malformed);
		}
		serde_json::to_vec(&row.schema).map_err(|_| SealedRegistryEvidenceError::Malformed)?
	};
	let effects = row
		.effects
		.map(|effects| {
			serde_json::from_value::<omp_tool::Effects>(effects)
				.map(|effects| EffectEnvelope::from(&effects))
				.map_err(|_| SealedRegistryEvidenceError::Malformed)
		})
		.transpose()?;
	let constraint = row
		.constraint
		.as_ref()
		.map(seal_tool_constraint)
		.transpose()?;
	let examples = row
		.examples
		.into_iter()
		.map(seal_tool_example)
		.collect::<Result<Vec<_>, _>>()?;
	let docs = row.docs.as_str().unwrap_or_default().to_owned();
	let summary = row.summary.unwrap_or_else(|| row.description.clone());
	Ok(ToolDecl {
		definition: Some(ToolDef {
			name:        row.name,
			description: row.description,
			input:       Some(tool_def::Input::JsonSchema(tool_def::JsonSchema {
				schema_json: Bytes::from(schema_json),
				strict:      row.strict,
			})),
		}),
		rev: if row.family.is_empty() {
			row.rev.to_string()
		} else {
			format!("{}.{}", row.family, row.rev)
		},
		constraint,
		extension_id: row.source_module,
		precedence: row.precedence,
		replaces: row.replaces.into_iter().collect(),
		summary,
		docs,
		examples,
		streams_args: row.streams_args,
		effects,
		kind: row.kind,
		execution_mode: if row.serial {
			ToolExecutionMode::Sequential as i32
		} else {
			ToolExecutionMode::Parallel as i32
		},
		place: row.place,
		..Default::default()
	})
}

fn seal_tool_example(row: JsonValue) -> Result<ToolExample, SealedRegistryEvidenceError> {
	let row = row
		.as_object()
		.ok_or(SealedRegistryEvidenceError::Malformed)?;
	let args = row
		.get("args")
		.ok_or(SealedRegistryEvidenceError::Malformed)?;
	let args_json = serde_json::to_vec(args).map_err(|_| SealedRegistryEvidenceError::Malformed)?;
	let description = row
		.get("note")
		.and_then(JsonValue::as_str)
		.or_else(|| row.get("result").and_then(JsonValue::as_str))
		.map(ToOwned::to_owned);
	Ok(ToolExample { args_json: Bytes::from(args_json), description })
}

fn seal_tool_constraint(value: &JsonValue) -> Result<ToolConstraint, SealedRegistryEvidenceError> {
	let value = value
		.as_object()
		.ok_or(SealedRegistryEvidenceError::Malformed)?;
	let priority = value
		.get("priority")
		.and_then(JsonValue::as_u64)
		.and_then(|value| u32::try_from(value).ok())
		.ok_or(SealedRegistryEvidenceError::Malformed)?;
	let on_unsupported = match value.get("on_unsupported").and_then(JsonValue::as_str) {
		Some("unspecified") => Fallback::Unspecified,
		Some("error") => Fallback::Error,
		Some("drop") => Fallback::Ignore,
		_ => return Err(SealedRegistryEvidenceError::Malformed),
	};
	let kind = match value.get("kind").and_then(JsonValue::as_str) {
		Some("schema") => tool_constraint::Kind::Schema(SchemaConstraint {
			priority,
			on_unsupported: on_unsupported as i32,
		}),
		Some("grammar") => {
			let syntax = match value.get("syntax").and_then(JsonValue::as_str) {
				Some("lark") => GrammarSyntax::Lark,
				Some("regex") => GrammarSyntax::Regex,
				Some("ebnf") => GrammarSyntax::Ebnf,
				Some("gbnf") => GrammarSyntax::Gbnf,
				_ => return Err(SealedRegistryEvidenceError::Malformed),
			};
			let definition = value
				.get("definition")
				.and_then(JsonValue::as_str)
				.filter(|definition| !definition.is_empty())
				.ok_or(SealedRegistryEvidenceError::Malformed)?;
			tool_constraint::Kind::Grammar(GrammarConstraint {
				syntax: syntax as i32,
				definition: definition.to_owned(),
				priority,
				on_unsupported: on_unsupported as i32,
			})
		},
		_ => return Err(SealedRegistryEvidenceError::Malformed),
	};
	Ok(ToolConstraint { kind: Some(kind) })
}

fn seal_prompts(
	manifest: &ExtensionManifest,
	identity: &ControlConnectionIdentity,
	rows: Vec<JsonValue>,
) -> Result<Vec<PromptSlotBinding>, SealedRegistryEvidenceError> {
	let expected = manifest
		.static_declarations()
		.prompt_slots
		.iter()
		.map(|row| row.key.clone())
		.collect::<BTreeSet<_>>();
	let mut actual = BTreeSet::<Str>::new();
	let mut prompts = Vec::with_capacity(rows.len());
	for row in rows {
		let slot = row
			.get("slot")
			.and_then(JsonValue::as_str)
			.ok_or(SealedRegistryEvidenceError::Malformed)?;
		let callback = row
			.get("callback")
			.and_then(JsonValue::as_object)
			.and_then(|callback| callback.get("$omp.callable"))
			.and_then(JsonValue::as_str)
			.ok_or(SealedRegistryEvidenceError::Malformed)?;
		let module = manifest_module_for_callback(manifest, callback)?;
		if !actual.insert(Str::new(slot)) {
			return Err(SealedRegistryEvidenceError::Duplicate);
		}
		if !manifest.runtime_declarations_trusted() {
			let declaration = manifest
				.static_declarations()
				.prompt_slots
				.iter()
				.find(|declaration| declaration.key.as_str() == slot)
				.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
			if module != declaration.module.as_str() {
				return Err(SealedRegistryEvidenceError::ManifestDrift);
			}
		}
		prompts.push(prompt_slot_binding(identity.extension.clone(), &row)?);
	}
	if !manifest.runtime_declarations_trusted() && expected != actual {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	Ok(prompts)
}

fn seal_services(
	manifest: &ExtensionManifest,
	rows: Vec<FrozenService>,
) -> Result<Vec<ServiceProviderDeclaration>, SealedRegistryEvidenceError> {
	let expected = manifest
		.services
		.provides()
		.map(|service| (service.name.as_str(), service.rev))
		.collect::<BTreeSet<_>>();
	let actual = rows
		.iter()
		.map(|service| (service.name.as_str(), service.rev))
		.collect::<BTreeSet<_>>();
	if actual.len() != rows.len() {
		return Err(SealedRegistryEvidenceError::Duplicate);
	}
	if !manifest.runtime_declarations_trusted() && expected != actual {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	rows
		.into_iter()
		.map(|row| {
			if row.name.is_empty()
				|| row.rev == 0
				|| row.callback.operation != "omp.services.dispatch"
				|| manifest_module_for_callback(manifest, &row.source_module)? != row.source_module
				|| row.methods.is_empty()
			{
				return Err(SealedRegistryEvidenceError::Malformed);
			}
			if manifest.has_uniform_declarations() && !manifest.runtime_declarations_trusted() {
				let declaration = manifest
					.static_declarations()
					.services
					.iter()
					.find(|declaration| declaration.key.as_str() == row.name)
					.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
				if declaration.module.as_str() != row.source_module {
					return Err(SealedRegistryEvidenceError::ManifestDrift);
				}
			}
			let mut names = BTreeSet::new();
			if row
				.methods
				.iter()
				.any(|method| method.name.is_empty() || !names.insert(method.name.as_str()))
			{
				return Err(SealedRegistryEvidenceError::Duplicate);
			}
			Ok(ServiceProviderDeclaration {
				service: ServiceKey::new(row.name, row.rev),
				methods: row.methods.into(),
			})
		})
		.collect()
}

fn seal_hooks(
	manifest: &ExtensionManifest,
	mut rows: Vec<FrozenHook>,
) -> Result<Vec<SealedHookRegistration>, SealedRegistryEvidenceError> {
	rows.sort();
	if rows.windows(2).any(|rows| rows[0] == rows[1]) {
		return Err(SealedRegistryEvidenceError::Duplicate);
	}
	let expected = manifest
		.declarations
		.hooks()
		.map(|hook| (hook.event.as_str(), hook.phase.to_string()))
		.collect::<BTreeSet<_>>();
	let actual = rows
		.iter()
		.map(|hook| (hook.event.as_str(), hook.phase.to_string()))
		.collect::<BTreeSet<_>>();
	if !manifest.runtime_declarations_trusted() && expected != actual {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	for hook in &rows {
		let module = manifest_module_for_callback(manifest, &hook.callback.callable)?;
		if manifest.has_uniform_declarations() && !manifest.runtime_declarations_trusted() {
			let key = format!("{}/{}", hook.event, hook.phase.to_ascii_uppercase());
			let declaration = manifest
				.static_declarations()
				.hooks
				.iter()
				.find(|row| row.key.as_str() == key)
				.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
			if module != declaration.module.as_str() {
				return Err(SealedRegistryEvidenceError::ManifestDrift);
			}
		}
		if let Some(filter) = manifest
			.static_declarations()
			.hooks
			.iter()
			.find(|row| {
				row.key.as_str() == format!("{}/{}", hook.event, hook.phase.to_ascii_uppercase())
			})
			.and_then(|row| row.filter.as_ref())
		{
			let Some(when) = hook.when.as_ref() else {
				return Err(SealedRegistryEvidenceError::ManifestDrift);
			};
			if when.server.as_deref().unwrap_or_default() != filter.servers.as_ref()
				|| when.method_globs.as_slice() != filter.method_globs.as_ref()
			{
				return Err(SealedRegistryEvidenceError::ManifestDrift);
			}
		}
	}
	rows.into_iter().map(seal_hook).collect()
}

fn seal_hook(hook: FrozenHook) -> Result<SealedHookRegistration, SealedRegistryEvidenceError> {
	if hook.name.is_empty() || hook.event.is_empty() || hook.phase.is_empty() || hook.event_rev == 0
	{
		return Err(SealedRegistryEvidenceError::Malformed);
	}
	let concurrency = if hook.threadsafe {
		CallbackConcurrency::Threadsafe
	} else if hook.concurrency == 1 {
		CallbackConcurrency::Serialized
	} else if hook.concurrency > 1 {
		CallbackConcurrency::Concurrent { limit: hook.concurrency }
	} else {
		return Err(SealedRegistryEvidenceError::Malformed);
	};
	let on_failure = hook
		.on_failure
		.as_deref()
		.map(seal_hook_failure)
		.transpose()?;
	let timeout = hook.timeout.as_deref().map(seal_duration).transpose()?;
	let event_on_failure = seal_hook_failure(&hook.event_on_failure)?;
	let event_timeout = seal_duration(&hook.event_timeout)?;
	let event_default = match hook.event_default.as_deref() {
		None => JsonValue::Null,
		Some("allow") => json!({"kind": "allow"}),
		_ => return Err(SealedRegistryEvidenceError::Malformed),
	};
	let composition = hook
		.composition
		.into_iter()
		.map(|(field, value)| {
			let value = match value.as_str() {
				"replace" => HookFieldComposition::Replace,
				"append" => HookFieldComposition::Append,
				"intersect" => HookFieldComposition::Intersect,
				_ => return Err(SealedRegistryEvidenceError::Malformed),
			};
			Ok((field, value))
		})
		.collect::<Result<_, _>>()?;
	let providers = hook
		.when
		.as_ref()
		.and_then(|when| when.provider.clone())
		.map(Vec::into_boxed_slice);
	let servers = hook
		.when
		.as_ref()
		.and_then(|when| when.server.clone())
		.map(Vec::into_boxed_slice);
	let method_globs = hook
		.when
		.map(|when| when.method_globs.into_boxed_slice())
		.unwrap_or_default();
	Ok(SealedHookRegistration {
		event: hook.event,
		phase: hook.phase,
		name: hook.name,
		order: hook.order,
		on_failure,
		timeout,
		concurrency,
		providers,
		servers,
		method_globs,
		event_revision: hook.event_rev,
		event_on_failure,
		event_default,
		event_timeout,
		composition,
	})
}

fn seal_hook_failure(value: &str) -> Result<HookFailurePolicy, SealedRegistryEvidenceError> {
	match value {
		"defer" => Ok(HookFailurePolicy::Defer),
		"deny" => Ok(HookFailurePolicy::Deny),
		_ => Err(SealedRegistryEvidenceError::Malformed),
	}
}

fn seal_duration(value: &str) -> Result<Duration, SealedRegistryEvidenceError> {
	value
		.parse::<omp_core::Duration>()
		.and_then(omp_core::Duration::to_std)
		.map_err(|_| SealedRegistryEvidenceError::Malformed)
}

fn seal_documents(
	manifest: &ExtensionManifest,
	kind: &str,
	documents: Vec<JsonValue>,
) -> Result<Vec<JsonValue>, SealedRegistryEvidenceError> {
	let expected = manifest
		.static_declarations()
		.ordered
		.iter()
		.filter(|row| row.kind.as_str() == kind)
		.map(|row| row.key.as_str())
		.collect::<BTreeSet<_>>();
	let actual = document_ids(&documents)?;
	if !manifest.runtime_declarations_trusted() && expected != actual {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	Ok(documents)
}

fn document_ids(documents: &[JsonValue]) -> Result<BTreeSet<&str>, SealedRegistryEvidenceError> {
	let mut ids = BTreeSet::new();
	for document in documents {
		let id = document
			.get("id")
			.and_then(JsonValue::as_str)
			.filter(|id| !id.is_empty())
			.ok_or(SealedRegistryEvidenceError::Malformed)?;
		if !ids.insert(id) {
			return Err(SealedRegistryEvidenceError::Duplicate);
		}
	}
	Ok(ids)
}

fn validate_callback_documents(
	manifest: &ExtensionManifest,
	kind: &str,
	documents: &[JsonValue],
) -> Result<(), SealedRegistryEvidenceError> {
	let expected = manifest
		.static_declarations()
		.ordered
		.iter()
		.filter(|row| row.kind.as_str() == kind)
		.map(|row| row.key.as_str())
		.collect::<BTreeSet<_>>();
	let actual = document_ids(documents)?;
	if !manifest.runtime_declarations_trusted() && expected != actual {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	for document in documents {
		let id = document
			.get("id")
			.and_then(JsonValue::as_str)
			.ok_or(SealedRegistryEvidenceError::Malformed)?;
		let callback = document
			.get("callable")
			.and_then(JsonValue::as_object)
			.and_then(|callback| callback.get("$omp.callable"))
			.and_then(JsonValue::as_str)
			.ok_or(SealedRegistryEvidenceError::Malformed)?;
		let module = manifest_module_for_callback(manifest, callback)?;
		if !manifest.runtime_declarations_trusted() {
			let declaration = manifest
				.static_declarations()
				.ordered
				.iter()
				.find(|row| row.kind.as_str() == kind && row.key.as_str() == id)
				.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
			if module != declaration.module.as_str() {
				return Err(SealedRegistryEvidenceError::ManifestDrift);
			}
		}
	}
	Ok(())
}

fn manifest_module_for_callback<'a>(
	manifest: &'a ExtensionManifest,
	callback: &str,
) -> Result<&'a str, SealedRegistryEvidenceError> {
	std::iter::once(&manifest.entry)
		.chain(manifest.declaration_modules.iter())
		.filter(|module| {
			callback == module.as_str()
				|| callback
					.strip_prefix(module.as_str())
					.is_some_and(|suffix| suffix.starts_with('.'))
		})
		.max_by_key(|module| module.len())
		.map(Str::as_str)
		.ok_or(SealedRegistryEvidenceError::SourceModule)
}

fn seal_ui(
	manifest: &ExtensionManifest,
	identity: &ControlConnectionIdentity,
	commands: Vec<FrozenCommand>,
	shortcuts: Vec<FrozenShortcut>,
	completions: Vec<FrozenCompletion>,
	message_renderers: Vec<FrozenNamedUiCallback>,
	markdown_transformers: Vec<FrozenNamedUiCallback>,
	renderers: Vec<FrozenRenderer>,
) -> Result<(RegisterUi, VerifiedUiRoster), SealedRegistryEvidenceError> {
	let mut registration = RegisterUi {
		generation: identity.host_generation,
		extension_id: identity.extension.to_string(),
		..Default::default()
	};
	for command in commands {
		let module = manifest_module_for_callback(manifest, &command.handler.callable)?;
		let row = manifest
			.static_declarations()
			.ui
			.commands
			.iter()
			.find(|row| row.key.as_str() == command.name)
			.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
		if row.module.as_str() != module {
			return Err(SealedRegistryEvidenceError::ManifestDrift);
		}
		registration.commands.push(CommandDecl {
			name:                    command.name,
			description:             command.description,
			hint:                    command.hint,
			aliases:                 command.aliases,
			args:                    command
				.args
				.into_iter()
				.map(|arg| CommandArgDecl {
					name:        arg.name,
					description: arg.description,
					usage:       arg.usage,
				})
				.collect(),
			declaration_id:          row.id.to_string(),
			callback:                command.handler.callable,
			module:                  module.to_owned(),
			activation_trigger:      if command.trigger.is_empty() {
				row.trigger.to_string()
			} else {
				command.trigger
			},
			arg_completion_callback: command.arg_completions.map(|callback| callback.callable),
			props:                   None,
		});
	}
	registration.shortcuts = shortcuts
		.into_iter()
		.map(|shortcut| {
			let module = manifest_module_for_callback(manifest, &shortcut.handler.callable)?;
			let row = manifest
				.static_declarations()
				.ui
				.shortcuts
				.iter()
				.find(|row| row.key.as_str() == shortcut.chord)
				.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
			if row.module.as_str() != module {
				return Err(SealedRegistryEvidenceError::ManifestDrift);
			}
			Ok(ShortcutDecl {
				chord:              shortcut.chord,
				action_id:          shortcut.action_id,
				description:        shortcut.description,
				when:               shortcut.when.unwrap_or_default(),
				declaration_id:     row.id.to_string(),
				callback:           shortcut.handler.callable,
				module:             module.to_owned(),
				activation_trigger: if shortcut.trigger.is_empty() {
					row.trigger.to_string()
				} else {
					shortcut.trigger
				},
				props:              None,
			})
		})
		.collect::<Result<Vec<_>, SealedRegistryEvidenceError>>()?;
	registration.triggers = completions
		.into_iter()
		.map(|completion| seal_completion(manifest, completion))
		.collect::<Result<Vec<_>, _>>()?;

	let mut verified = verify_ui_registration(manifest.static_declarations(), registration.clone())?;
	verified.message_renderers = message_renderers
		.into_iter()
		.map(|renderer| {
			if renderer.kind != "message_renderer" || renderer.name.is_empty() {
				return Err(SealedRegistryEvidenceError::ManifestDrift);
			}
			let row = manifest
				.static_declarations()
				.ui
				.message_renderers
				.iter()
				.find(|row| row.key.as_str() == renderer.name)
				.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
			let module = manifest_module_for_callback(manifest, &renderer.value.callable)?;
			if row.module.as_str() != module
				|| (!row.trigger.is_empty() && row.trigger.as_str() != renderer.trigger)
			{
				return Err(SealedRegistryEvidenceError::ManifestDrift);
			}
			Ok(VerifiedMessageRendererDeclaration {
				declaration_id: row.id.clone(),
				custom_type:    Str::new(renderer.name),
				callback:       Str::new(renderer.value.callable),
				module:         row.module.clone(),
			})
		})
		.collect::<Result<Vec<_>, _>>()?
		.into_boxed_slice();
	verified.markdown_transformers = markdown_transformers
		.into_iter()
		.map(|transformer| {
			if transformer.kind != "markdown_transformer" || transformer.name.is_empty() {
				return Err(SealedRegistryEvidenceError::ManifestDrift);
			}
			let row = manifest
				.static_declarations()
				.ui
				.message_renderers
				.iter()
				.find(|row| row.key.as_str() == transformer.name)
				.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
			let module = manifest_module_for_callback(manifest, &transformer.value.callable)?;
			if row.module.as_str() != module
				|| (!row.trigger.is_empty() && row.trigger.as_str() != transformer.trigger)
			{
				return Err(SealedRegistryEvidenceError::ManifestDrift);
			}
			Ok(VerifiedMarkdownTransformer {
				declaration_id: row.id.clone(),
				name:           Str::new(transformer.name),
				callback:       Str::new(transformer.value.callable),
				module:         row.module.clone(),
			})
		})
		.collect::<Result<Vec<_>, _>>()?
		.into_boxed_slice();
	let mut renderer_keys = BTreeSet::new();
	verified.renderers = renderers
		.into_iter()
		.map(|renderer| {
			if !renderer_keys.insert(renderer.name.clone()) {
				return Err(SealedRegistryEvidenceError::Duplicate);
			}
			seal_renderer(manifest, renderer)
		})
		.collect::<Result<Vec<_>, _>>()?
		.into_boxed_slice();
	let expected_renderers = manifest
		.static_declarations()
		.ui
		.verdict_renderers
		.iter()
		.map(|row| row.id.as_str())
		.collect::<BTreeSet<_>>();
	let actual_renderers = verified
		.renderers
		.iter()
		.map(|renderer| renderer.declaration_id.as_str())
		.collect::<BTreeSet<_>>();
	if expected_renderers != actual_renderers {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	Ok((registration, verified))
}

fn seal_completion(
	manifest: &ExtensionManifest,
	completion: FrozenCompletion,
) -> Result<TriggerDecl, SealedRegistryEvidenceError> {
	if completion.kind != "completion"
		|| completion.name.is_empty()
		|| completion.metadata.prefix != completion.name
		|| completion.metadata.max_results == 0
	{
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	let row = manifest
		.static_declarations()
		.ui
		.completions
		.iter()
		.find(|row| row.key.as_str() == completion.name)
		.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
	let module = manifest_module_for_callback(manifest, &completion.value.callable)?;
	if row.module.as_str() != module
		|| (!row.trigger.is_empty() && row.trigger.as_str() != completion.trigger)
	{
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	Ok(TriggerDecl {
		prefix:             completion.name,
		kind:               "completion".to_owned(),
		at_line_start:      completion.metadata.at_line_start,
		min_chars:          completion.metadata.min_chars,
		debounce_ms:        completion_duration_millis(&completion.metadata.debounce)?,
		max_results:        completion.metadata.max_results.min(100),
		cache_ms:           completion_duration_millis(&completion.metadata.cache)?,
		refine_locally:     completion.metadata.refine_locally,
		declaration_id:     row.id.to_string(),
		callback:           completion.value.callable,
		module:             module.to_owned(),
		activation_trigger: if completion.trigger.is_empty() {
			row.trigger.to_string()
		} else {
			completion.trigger
		},
		props:              None,
	})
}

fn completion_duration_millis(value: &JsonValue) -> Result<u64, SealedRegistryEvidenceError> {
	if let Some(milliseconds) = value.as_u64() {
		return Ok(milliseconds);
	}
	let text = value
		.as_str()
		.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
	let (number, multiplier) = if let Some(number) = text.strip_suffix("ms") {
		(number, 1.0)
	} else if let Some(number) = text.strip_suffix('s') {
		(number, 1_000.0)
	} else if let Some(number) = text.strip_suffix('m') {
		(number, 60_000.0)
	} else if let Some(number) = text.strip_suffix('h') {
		(number, 3_600_000.0)
	} else {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	};
	let milliseconds = number
		.parse::<f64>()
		.map_err(|_| SealedRegistryEvidenceError::ManifestDrift)?
		* multiplier;
	if !milliseconds.is_finite() || milliseconds < 0.0 || milliseconds > u64::MAX as f64 {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	Ok(milliseconds.round() as u64)
}

fn seal_renderer(
	manifest: &ExtensionManifest,
	renderer: FrozenRenderer,
) -> Result<VerifiedRendererDeclaration, SealedRegistryEvidenceError> {
	if renderer.kind != "verdict_renderer" || renderer.name.0.is_empty() {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	let (name, family, revision) = renderer.name;
	let key = if family.is_empty() && revision == 0 {
		name.clone()
	} else {
		format!("{name}@{family}.{revision}")
	};
	let row = manifest
		.static_declarations()
		.ui
		.verdict_renderers
		.iter()
		.find(|row| row.key.as_str() == key)
		.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
	let callback = renderer.value.function.callable;
	let module = manifest_module_for_callback(manifest, &callback)?;
	if row.module.as_str() != module
		|| (!row.trigger.is_empty() && row.trigger.as_str() != renderer.trigger)
	{
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	let reduce = renderer
		.value
		.reduce
		.map(|reduce| {
			let callable = Str::new(reduce.callable);
			manifest_module_for_callback(manifest, callable.as_str()).map(|_| callable)
		})
		.transpose()?;
	Ok(VerifiedRendererDeclaration {
		declaration_id: row.id.clone(),
		identity: ToolIdentity {
			name: Str::new(name),
			rev:  Rev { family: Str::new(family), n: revision },
		},
		callback: Str::new(callback),
		reduce,
		decorates: renderer.value.decorates,
		module: row.module.clone(),
	})
}

#[derive(Clone)]
pub(crate) struct PyCallbackRoute {
	target: Arc<RwLock<PyCallbackTarget>>,
}

#[derive(Clone)]
struct PyCallbackTarget {
	control:   ControlHandle,
	authority: ControlInvocationAuthority,
}

impl PyCallbackRoute {
	pub(crate) fn new(control: ControlHandle, authority: ControlInvocationAuthority) -> Self {
		Self { target: Arc::new(RwLock::new(PyCallbackTarget { control, authority })) }
	}

	pub(crate) fn replace(&self, control: ControlHandle, authority: ControlInvocationAuthority) {
		*self.target.write() = PyCallbackTarget { control, authority };
	}

	/// Dispatches through the currently installed extension-host generation.
	pub(crate) async fn dispatch(
		&self,
		dispatch: ControlDispatch,
	) -> Result<JsonValue, super::control::ControlRuntimeError> {
		let target = self.current();
		target.control.dispatch(dispatch).await
	}

	/// Cancels one live invocation through the currently installed generation.
	pub(crate) async fn cancel_dispatch(
		&self,
		invocation: &str,
	) -> Result<(), super::control::ControlRuntimeError> {
		let target = self.current();
		target.control.cancel(invocation).await
	}

	/// Clones the current host-issued authority template.
	pub(crate) fn authority(&self) -> ControlInvocationAuthority {
		self.current().authority
	}

	fn current(&self) -> PyCallbackTarget {
		self.target.read().clone()
	}
}

#[derive(Clone)]
struct PyCallback {
	route:    PyCallbackRoute,
	callable: Str,
	timeout:  Duration,
}

impl PyCallback {
	fn dispatch(
		&self,
		operation: &'static str,
		mut arguments: Map<String, JsonValue>,
	) -> (ControlHandle, ControlDispatch) {
		arguments.insert("callable".into(), JsonValue::String(self.callable.to_string()));
		let target = self.route.current();
		let dispatch = ControlDispatch {
			operation: Str::new_static(operation),
			arguments,
			authority: target.authority,
			policy: CallbackConcurrency::Serialized,
			deadline: EventDeadline { at: Instant::now() + self.timeout },
		};
		(target.control, dispatch)
	}

	async fn call_async(
		&self,
		operation: &'static str,
		arguments: Map<String, JsonValue>,
	) -> Result<JsonValue, PyExtensionError> {
		let (control, dispatch) = self.dispatch(operation, arguments);
		Ok(control.dispatch(dispatch).await?)
	}

	fn call_sync(
		&self,
		operation: &'static str,
		arguments: Map<String, JsonValue>,
	) -> Result<JsonValue, PyExtensionError> {
		let runtime =
			tokio::runtime::Handle::try_current().map_err(|_| PyExtensionError::NoRuntime)?;
		let (control, dispatch) = self.dispatch(operation, arguments);
		let (tx, rx) = flume::bounded(1);
		std::thread::spawn(move || {
			let _ = tx.send(runtime.block_on(control.dispatch(dispatch)));
		});
		let result = rx
			.recv_timeout(self.timeout)
			.map_err(|_| PyExtensionError::Timeout)?;
		Ok(result?)
	}
}

/// Director backed by one callable in a killable Python extension host.
///
/// The adapter retains only CONTROL routing metadata. Durable callback state is
/// returned as `StateUpdate`s and committed on the Director element.
pub struct PyDirector {
	id:       Str,
	callback: PyCallback,
	claims:   Vec<Slot>,
	binds:    Vec<(Str, BindValue)>,
}

impl PyDirector {
	/// Creates an admitted Python Director.
	pub fn new(
		id: Str,
		callable: Str,
		control: ControlHandle,
		authority: ControlInvocationAuthority,
		claims: Vec<Slot>,
		binds: Vec<(Str, BindValue)>,
		timeout: Option<Duration>,
	) -> Self {
		Self::with_route(
			id,
			callable,
			PyCallbackRoute::new(control, authority),
			claims,
			binds,
			timeout,
		)
	}

	fn with_route(
		id: Str,
		callable: Str,
		route: PyCallbackRoute,
		claims: Vec<Slot>,
		binds: Vec<(Str, BindValue)>,
		timeout: Option<Duration>,
	) -> Self {
		Self {
			id,
			callback: PyCallback {
				route,
				callable,
				timeout: timeout.unwrap_or(DEFAULT_EXTENSION_HOOK_TIMEOUT),
			},
			claims,
			binds,
		}
	}

	fn child(&self, result: &JsonValue) -> Option<Self> {
		let child = result.get("child")?.as_object()?;
		let id = required_str(child, "id").ok()?;
		let callable = callable_id(child).ok()?;
		let claims = child
			.get("claims")
			.and_then(JsonValue::as_array)
			.into_iter()
			.flatten()
			.map(|value| Slot::from_str(value.as_str()?).ok())
			.collect::<Option<Vec<_>>>()?;
		let binds = child
			.get("binds")
			.and_then(JsonValue::as_object)
			.into_iter()
			.flat_map(|values| values.iter())
			.map(|(name, value)| Some((Str::new(name), bind_value(value)?)))
			.collect::<Option<Vec<_>>>()?;
		Some(Self {
			id,
			callback: PyCallback {
				route: self.callback.route.clone(),
				callable,
				timeout: self.callback.timeout,
			},
			claims,
			binds,
		})
	}
}

impl Director for PyDirector {
	fn id(&self) -> &str {
		self.id.as_str()
	}

	fn claims(&self) -> &[Slot] {
		&self.claims
	}

	fn binds(&self) -> &[(Str, BindValue)] {
		&self.binds
	}

	fn before_inference<'a>(
		&'a self,
		cx: &'a mut MutDirectorCx<'_>,
		req: &'a omp_ai::ChatRequest,
	) -> BoxFut<'a, Result<Prepared, DirectorError>> {
		Box::pin(async move {
			let mut arguments = Map::new();
			arguments.insert("director".into(), JsonValue::String(self.id.to_string()));
			arguments.insert("state".into(), director_state(cx.director_node()));
			arguments.insert(
				"request".into(),
				json!({
					"message_count": req.messages.len(),
					"tool_count": req.tools.len(),
					"max_output_tokens": req.max_output_tokens,
				}),
			);
			let result = self
				.callback
				.call_async("omp.extensions.director.before_inference", arguments)
				.await
				.map_err(|_| DirectorError::ExtensionCallback)?;
			if let Some(ops) = result.get("ops") {
				let ops: Vec<Op> =
					serde_json::from_value(ops.clone()).map_err(|_| DirectorError::ExtensionCallback)?;
				if !ops.is_empty() {
					let cause = cx.session.head().ok_or(DirectorError::MissingDirectors)?;
					cx.session.patch(Txn {
						cause,
						label: Some(sf!("extension.director.before_inference")),
						ops,
					})?;
				}
			}
			Ok(if result.get("prepared").and_then(JsonValue::as_str) == Some("rebuild") {
				Prepared::Rebuild
			} else {
				Prepared::Unchanged
			})
		})
	}

	fn evaluate(&self, _: &omp_dom::Dom, cx: &DirectorCx<'_>, turn: &TurnView) -> DirectorEffect {
		let arguments = json!({
			"director": self.id.as_str(),
			"state": director_state(cx.director_node()),
			"turn": {
				"had_tool_calls": turn.had_tool_calls,
				"assistant_text": turn.assistant_text.as_str(),
				"stop_reason": turn.stop_reason.as_str(),
			}
		})
		.as_object()
		.cloned()
		.unwrap_or_default();
		let Ok(result) = self
			.callback
			.call_sync("omp.extensions.director.on_yield", arguments)
		else {
			return DirectorEffect::new(Verdict::Fail(sf!(
				"Python extension Director callback failed"
			)));
		};
		let updates = result
			.get("updates")
			.and_then(JsonValue::as_object)
			.map(|updates| {
				updates
					.iter()
					.filter_map(|(key, value)| {
						bind_value(value).map(|value| StateUpdate::new(Str::new(key), value))
					})
					.collect()
			})
			.unwrap_or_default();
		let verdict = match result.get("verdict").and_then(JsonValue::as_str) {
			Some("pass") => Verdict::Pass,
			Some("continue") => Verdict::Continue {
				reminder: result
					.get("reminder")
					.and_then(JsonValue::as_str)
					.map(Str::new),
			},
			Some("yield") => Verdict::Yield,
			Some("done") => Verdict::Done,
			Some("push") => self.child(&result).map_or_else(
				|| Verdict::Fail(sf!("Python extension Director returned an invalid child")),
				|child| Verdict::Push(Box::new(child)),
			),
			Some("fail") => Verdict::Fail(
				result
					.get("reason")
					.and_then(JsonValue::as_str)
					.map_or_else(|| sf!("Python extension Director failed"), Str::new),
			),
			_ => Verdict::Fail(sf!("Python extension Director returned an invalid verdict")),
		};
		let mut effect = DirectorEffect::new(verdict);
		effect.updates = updates;
		effect
	}
}

/// Live Python Component adapter.
///
/// `reduce_live` invokes Python once and journals the returned operations as
/// `patch@1`. The `Component` implementation intentionally consumes no replay
/// entries: replay applies that patch directly and never calls Python again.
#[derive(Clone)]
pub struct PyComponent {
	id:         Str,
	callback:   PyCallback,
	interested: Arc<[Kind]>,
}

impl PyComponent {
	/// Creates an admitted journal-to-DOM Component adapter.
	pub fn new(
		id: Str,
		callable: Str,
		control: ControlHandle,
		authority: ControlInvocationAuthority,
		interested: Vec<Kind>,
		timeout: Option<Duration>,
	) -> Self {
		Self::with_route(id, callable, PyCallbackRoute::new(control, authority), interested, timeout)
	}

	fn with_route(
		id: Str,
		callable: Str,
		route: PyCallbackRoute,
		interested: Vec<Kind>,
		timeout: Option<Duration>,
	) -> Self {
		Self {
			id,
			callback: PyCallback {
				route,
				callable,
				timeout: timeout.unwrap_or(DEFAULT_EXTENSION_HOOK_TIMEOUT),
			},
			interested: interested.into(),
		}
	}

	fn reduce_ops(&self, entry: &Entry) -> Result<Vec<Op>, PyExtensionError> {
		let arguments = json!({
			"component": self.id.as_str(),
			"entry": {
				"id": entry.id.to_string(),
				"kind": entry.kind.name.as_str(),
				"rev": entry.kind.rev,
				"by": entry.by.map(|id| id.to_string()),
				"prior": entry.prior.map(|id| id.to_string()),
				"label": entry.label.as_deref(),
				"data": entry.data.as_str(),
			},
		})
		.as_object()
		.cloned()
		.unwrap_or_default();
		let result = self
			.callback
			.call_sync("omp.extensions.component.apply", arguments)?;
		serde_json::from_value::<Vec<Op>>(result.get("ops").cloned().unwrap_or_else(|| json!([])))
			.map_err(PyExtensionError::InvalidOps)
	}
}

impl Component for PyComponent {
	fn interested(&self, _: &Kind) -> bool {
		false
	}

	fn apply(&mut self, _: &Entry, _: &omp_dom::Dom, _: &mut Draft) {}
}

impl LiveComponent for PyComponent {
	fn id(&self) -> &str {
		self.id.as_str()
	}

	fn interested(&self, kind: &Kind) -> bool {
		self.interested.iter().any(|candidate| candidate == kind)
	}

	fn reduce(&self, entry: &Entry, _: &omp_dom::Dom) -> Result<Vec<Op>, LiveComponentError> {
		self
			.reduce_ops(entry)
			.map_err(|_| LiveComponentError::Callback)
	}
}

/// Lowers frozen Python registry metadata into engine registrations.
///
/// The returned components are the live invocation handles. Register clones in
/// `ExtensionRegistrar` consume no replay entries; callers invoke
/// [`PyComponent::reduce_live`] at the journal append boundary.
pub(crate) fn register_python_extensions(
	registrar: &mut ExtensionRegistrar,
	directors: &[JsonValue],
	components: &[JsonValue],
	route: PyCallbackRoute,
	timeout: Option<Duration>,
) -> Result<Vec<PyComponent>, PyExtensionError> {
	for row in directors {
		let row = row.as_object().ok_or(PyExtensionError::InvalidResult)?;
		let id = required_str(row, "id")?;
		let callable = callable_id(row)?;
		let claims = row
			.get("claims")
			.and_then(JsonValue::as_array)
			.ok_or(PyExtensionError::InvalidResult)?
			.iter()
			.map(|value| {
				value
					.as_str()
					.ok_or(PyExtensionError::InvalidResult)
					.and_then(|value| Slot::from_str(value).map_err(|_| PyExtensionError::InvalidResult))
			})
			.collect::<Result<Vec<_>, _>>()?;
		let binds = row
			.get("binds")
			.and_then(JsonValue::as_object)
			.ok_or(PyExtensionError::InvalidResult)?
			.iter()
			.map(|(name, value)| {
				bind_value(value)
					.map(|value| (Str::new(name), value))
					.ok_or(PyExtensionError::InvalidResult)
			})
			.collect::<Result<Vec<_>, _>>()?;
		registrar.director(Box::new(PyDirector::with_route(
			id,
			callable,
			route.clone(),
			claims,
			binds,
			timeout,
		)));
	}
	let mut live = Vec::with_capacity(components.len());
	for row in components {
		let row = row.as_object().ok_or(PyExtensionError::InvalidResult)?;
		let id = required_str(row, "id")?;
		let callable = callable_id(row)?;
		let interested = row
			.get("interested")
			.and_then(JsonValue::as_array)
			.ok_or(PyExtensionError::InvalidResult)?
			.iter()
			.map(|value| {
				let value = value.as_str().ok_or(PyExtensionError::InvalidResult)?;
				let (name, rev) = value
					.rsplit_once('@')
					.ok_or(PyExtensionError::InvalidResult)?;
				let rev = rev
					.parse::<u32>()
					.map_err(|_| PyExtensionError::InvalidResult)?;
				let kind = Kind::new(name, rev).map_err(|_| PyExtensionError::InvalidResult)?;
				kind
					.is_known()
					.then_some(kind)
					.ok_or(PyExtensionError::InvalidResult)
			})
			.collect::<Result<Vec<_>, _>>()?;
		let component = PyComponent::with_route(id, callable, route.clone(), interested, timeout);
		registrar.component(Box::new(component.clone()));
		live.push(component);
	}
	Ok(live)
}

fn required_str(row: &Map<String, JsonValue>, key: &str) -> Result<Str, PyExtensionError> {
	row.get(key)
		.and_then(JsonValue::as_str)
		.filter(|value| !value.is_empty())
		.map(Str::new)
		.ok_or(PyExtensionError::InvalidResult)
}

fn callable_id(row: &Map<String, JsonValue>) -> Result<Str, PyExtensionError> {
	row.get("callable")
		.and_then(JsonValue::as_object)
		.and_then(|value| value.get("$omp.callable"))
		.and_then(JsonValue::as_str)
		.filter(|value| !value.is_empty())
		.map(Str::new)
		.ok_or(PyExtensionError::InvalidResult)
}

fn director_state(node: Option<&Node>) -> JsonValue {
	let Some(node) = node else {
		return JsonValue::Object(Map::new());
	};
	JsonValue::Object(
		node
			.props
			.iter()
			.filter_map(|(key, value)| {
				let key = key.as_str().strip_prefix("state/")?;
				serde_json::to_value(value)
					.ok()
					.map(|value| (key.to_owned(), value))
			})
			.collect(),
	)
}

fn bind_value(value: &JsonValue) -> Option<BindValue> {
	match value {
		JsonValue::Bool(value) => Some(BindValue::Bool(*value)),
		JsonValue::Number(value) => value
			.as_i64()
			.map(BindValue::Int)
			.or_else(|| value.as_f64().map(BindValue::Float)),
		JsonValue::String(value) => Some(BindValue::Str(Str::new(value))),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use omp_con::{Ctx, Value as ConValue};
	use omp_core::{ArtifactDigest, Provenance, sf};
	use omp_ext::config::{
		DeploymentManifest, StaticDeclaration, StaticDeclarations, resolve_extension_settings,
	};

	use super::{
		ExtensionConvarError, ExtensionManifest, FrozenAvailability, FrozenDeclarationKey,
		FrozenPrelude, FrozenPreludeParam, FrozenTool, FrozenToolCallback,
		SealedRegistryEvidenceError, manifest_module_for_callback,
		register_extension_setting_convars, seal_availability, seal_preludes, seal_tools,
		validate_declaration_keys,
	};
	use crate::exthost::{DeclarationSet, ServiceManifest, ToolDeclarationKey};

	#[test]
	fn manifest_settings_register_owner_qualified_dynamic_convars() {
		let manifest = DeploymentManifest::parse(
			r#"
id = "demo"

[settings.verbose]
type = "boolean"
default = false

[settings.verbose.ui]
tab = "tools"
group = "Extensions"
label = "Verbose Demo"
description = "Show verbose extension output"
warning = "Changes take effect immediately"
ordered = true
options = [
	{ value = "false", label = "Disabled", description = "Keep verbose output disabled" },
	{ value = "true", label = "Enabled", description = "Show verbose extension output" },
]

[settings.severity]
type = "enum"
values = ["warning", "error"]
default = "warning"
"#,
		)
		.expect("deployment manifest");
		let mut resolved =
			resolve_extension_settings(&manifest, &Default::default(), &[]).expect("defaults");
		resolved.insert("verbose".into(), serde_json::json!(true));
		let ctx = Ctx::new();
		let writes = ctx.subscribe_session_writes();

		register_extension_setting_convars(&ctx, manifest.id.as_str(), &manifest.settings, &resolved)
			.expect("register dynamic convars");

		assert_eq!(ctx.get("ext::demo::verbose"), Some(ConValue::Bool(true)));
		assert_eq!(ctx.get("ext::demo::severity"), Some(ConValue::Str("warning".into())),);
		let verbose = ctx
			.dynamic_var_spec("ext::demo::verbose")
			.expect("verbose dynamic declaration");
		assert_eq!(
			verbose
				.meta
				.iter()
				.map(|(key, value)| (key.as_str(), value.as_str()))
				.collect::<Vec<_>>(),
			vec![
				("ui.tab", "tools"),
				("ui.group", "Extensions"),
				("ui.label", "Verbose Demo"),
				("ui.description", "Show verbose extension output"),
				("ui.warning", "Changes take effect immediately"),
				("ui.option.false", "Disabled"),
				("ui.option.false.desc", "Keep verbose output disabled"),
				("ui.option.true", "Enabled"),
				("ui.option.true.desc", "Show verbose extension output"),
				("ui.ordered", "true"),
			]
		);
		assert!(
			ctx.dynamic_var_spec("ext::demo::severity")
				.is_some_and(|spec| spec.meta.is_empty()),
			"manifest settings without explicit ui stay config-only"
		);
		assert_eq!(
			writes.try_recv().expect("effective override"),
			("ext::demo::verbose".into(), ConValue::Bool(true)),
		);
	}

	#[test]
	fn uniform_freeze_keys_reject_runtime_additions() {
		let declaration = StaticDeclaration {
			id: sf!("provider"),
			kind: sf!("provider"),
			module: sf!("extension"),
			trigger: sf!("lazy"),
			key: sf!("provider"),
			api: 1,
			failure: sf!("fail-closed"),
			..Default::default()
		};
		let mut manifest = ExtensionManifest::new_with_static(
			Provenance::new(
				sf!("publisher"),
				sf!("extension"),
				sf!("1.0.0"),
				ArtifactDigest::new([7; 32]),
				sf!("project"),
				sf!("trusted"),
				1,
			),
			"extension",
			[],
			DeclarationSet::default(),
			ServiceManifest::default(),
			StaticDeclarations {
				ordered: vec![declaration.clone()].into_boxed_slice(),
				providers: vec![declaration].into_boxed_slice(),
				..Default::default()
			},
			[],
			[],
		);
		assert!(
			validate_declaration_keys(&manifest, &[FrozenDeclarationKey {
				kind: sf!("provider"),
				key:  sf!("provider"),
			}],)
			.is_ok()
		);
		assert!(matches!(
			validate_declaration_keys(&manifest, &[
				FrozenDeclarationKey { kind: sf!("provider"), key: sf!("provider") },
				FrozenDeclarationKey { kind: sf!("service"), key: sf!("runtime.extra") },
			],),
			Err(SealedRegistryEvidenceError::ManifestDrift)
		));
		manifest.trust_runtime_declarations();
		assert!(
			validate_declaration_keys(&manifest, &[
				FrozenDeclarationKey { kind: sf!("provider"), key: sf!("provider") },
				FrozenDeclarationKey { kind: sf!("service"), key: sf!("runtime.extra") },
			],)
			.is_ok()
		);
	}

	#[test]
	fn callback_modules_choose_exact_then_longest_admitted_prefix() {
		let manifest = ExtensionManifest::new(
			Provenance::new(
				sf!("publisher"),
				sf!("extension"),
				sf!("1.0.0"),
				ArtifactDigest::new([8; 32]),
				sf!("project"),
				sf!("trusted"),
				1,
			),
			"extension",
			[sf!("extension.tools"), sf!("extension.tools.deep")],
			DeclarationSet::default(),
			ServiceManifest::default(),
			[],
			[],
		);
		assert_eq!(
			manifest_module_for_callback(&manifest, "extension.tools.deep.callback")
				.expect("longest callback module"),
			"extension.tools.deep"
		);
		assert_eq!(
			manifest_module_for_callback(&manifest, "extension.tools")
				.expect("exact callback module"),
			"extension.tools"
		);
		assert!(matches!(
			manifest_module_for_callback(&manifest, "extensionary.callback"),
			Err(SealedRegistryEvidenceError::SourceModule)
		));
	}

	#[test]
	fn preludes_and_availability_are_sealed_as_distinct_tables() {
		let manifest = ExtensionManifest::new(
			Provenance::new(
				sf!("publisher"),
				sf!("extension"),
				sf!("1.0.0"),
				ArtifactDigest::new([9; 32]),
				sf!("project"),
				sf!("trusted"),
				1,
			),
			"extension",
			[sf!("extension.tools")],
			DeclarationSet::new(
				[ToolDeclarationKey::new("helper", "prelude", 1)],
				[],
			),
			ServiceManifest::default(),
			[],
			[],
		);
		let preludes = seal_preludes(&manifest, vec![FrozenPrelude {
			name: String::from("helper"),
			rev: 1,
			doc: String::from("Helper docs."),
			summary: String::from("Helper summary."),
			source_module: String::from("extension.tools"),
			params: vec![FrozenPreludeParam {
				name: String::from("value"),
				kind: String::from("positional_or_keyword"),
				default_json: Some(String::from("7")),
				annotation: Some(String::from("int")),
			}],
			callback: FrozenToolCallback {
				operation: String::from("omp.devices.call"),
				path: String::from("helper"),
				family: String::from("prelude"),
				rev: 1,
			},
		}])
		.expect("seal prelude");
		assert_eq!(preludes[0].rev, "prelude.1");
		assert_eq!(preludes[0].prelude_params.len(), 1);

		let tool = FrozenTool {
			name: String::from("device"),
			family: String::from("extension"),
			rev: 1,
			description: String::new(),
			schema: serde_json::json!({}),
			strict: None,
			streams_args: false,
			source_module: String::from("extension.tools"),
			kind: String::from("soft"),
			place: String::from("host"),
			effects: None,
			constraint: None,
			serial: false,
			precedence: 0,
			replaces: None,
			summary: None,
			docs: serde_json::Value::Null,
			examples: Vec::new(),
			callback: FrozenToolCallback {
				operation: String::from("omp.devices.call"),
				path: String::from("device"),
				family: String::from("extension"),
				rev: 1,
			},
		};
		let availability = seal_availability(&[tool], vec![FrozenAvailability {
			name: String::from("device"),
			family: String::from("extension"),
			rev: 1,
			mounted: false,
			reason: Some(String::from("offline")),
		}])
		.expect("seal availability");
		assert!(!availability[0].mounted);
		assert_eq!(availability[0].reason.as_deref(), Some("offline"));
	}

	#[test]
	fn trusted_runtime_tool_from_declaration_module_is_admitted() {
		let mut manifest = ExtensionManifest::new(
			Provenance::new(
				sf!("publisher"),
				sf!("extension"),
				sf!("1.0.0"),
				ArtifactDigest::new([10; 32]),
				sf!("project"),
				sf!("trusted"),
				1,
			),
			"extension",
			[sf!("extension.tools")],
			DeclarationSet::default(),
			ServiceManifest::default(),
			[],
			[],
		);
		manifest.trust_runtime_declarations();
		let tools = seal_tools(&manifest, vec![FrozenTool {
			name: String::from("runtime_tool"),
			family: String::from("extension"),
			rev: 1,
			description: String::from("Trusted runtime tool"),
			schema: serde_json::json!({"type": "object"}),
			strict: None,
			streams_args: false,
			source_module: String::from("extension.tools"),
			kind: String::from("soft"),
			place: String::from("host"),
			effects: None,
			constraint: None,
			serial: false,
			precedence: 0,
			replaces: None,
			summary: None,
			docs: serde_json::Value::Null,
			examples: Vec::new(),
			callback: FrozenToolCallback {
				operation: String::from("omp.devices.call"),
				path: String::from("runtime_tool"),
				family: String::from("extension"),
				rev: 1,
			},
		}])
		.expect("trusted runtime tool");
		assert_eq!(
			tools[0].definition.as_ref().expect("definition").name,
			"runtime_tool"
		);
	}

	#[test]
	fn malformed_prelude_and_availability_fail_closed() {
		let mut manifest = ExtensionManifest::new(
			Provenance::new(
				sf!("publisher"),
				sf!("extension"),
				sf!("1.0.0"),
				ArtifactDigest::new([11; 32]),
				sf!("project"),
				sf!("trusted"),
				1,
			),
			"extension",
			[],
			DeclarationSet::default(),
			ServiceManifest::default(),
			[],
			[],
		);
		manifest.trust_runtime_declarations();
		assert!(matches!(
			seal_preludes(&manifest, vec![FrozenPrelude {
				name: String::from("helper"),
				rev: 1,
				doc: String::new(),
				summary: String::new(),
				source_module: String::from("foreign"),
				params: Vec::new(),
				callback: FrozenToolCallback {
					operation: String::from("omp.devices.call"),
					path: String::from("helper"),
					family: String::from("prelude"),
					rev: 1,
				},
			}]),
			Err(SealedRegistryEvidenceError::SourceModule | SealedRegistryEvidenceError::Malformed)
		));
		assert!(matches!(
			seal_availability(&[], vec![FrozenAvailability {
				name: String::from("extra"),
				family: String::new(),
				rev: 1,
				mounted: true,
				reason: None,
			}]),
			Err(SealedRegistryEvidenceError::ManifestDrift)
		));
	}

	#[test]
	fn setting_without_default_or_effective_value_is_rejected() {
		let manifest = DeploymentManifest::parse(
			r#"
id = "demo"

[settings.required]
type = "string"
"#,
		)
		.expect("deployment manifest");
		assert!(matches!(
			register_extension_setting_convars(
				&Ctx::new(),
				manifest.id.as_str(),
				&manifest.settings,
				&Default::default(),
			),
			Err(ExtensionConvarError::MissingValue { .. })
		));
	}
}
