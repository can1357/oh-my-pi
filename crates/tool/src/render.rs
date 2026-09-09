//! Revision-keyed, synchronous tool renderer folds.

use std::{any::Any, collections::BTreeMap, iter, str, sync::Arc};

use bytes::Bytes;
use omp_core::{Str, StrMut};
use serde::de::DeserializeOwned;
use smallvec::SmallVec;
use thiserror::Error;

use crate::ToolIdentity;

const JTD_IMPORT_MAX_DEPTH: usize = 64;

/// A malformed or unsupported JSON Type Definition import.
#[derive(Debug, Error)]
pub enum JtdImportError {
	/// More than one JTD form, or a JSON-Schema-only keyword, was supplied.
	#[error("JTD import must contain exactly one supported RFC 8927 form")]
	InvalidForm,
	/// A primitive was outside the supported JTD vocabulary.
	#[error("JTD import contains an unsupported primitive type")]
	UnsupportedPrimitive,
	/// An enum was empty or contained a non-string value.
	#[error("JTD enum must be a non-empty array of strings")]
	InvalidEnum,
	/// A properties form did not contain object-valued property maps.
	#[error("JTD properties and optionalProperties must be objects")]
	InvalidProperties,
	/// A discriminator form was malformed.
	#[error("JTD discriminator requires a non-empty string and object mapping")]
	InvalidDiscriminator,
	/// Recursive input exceeded the bounded import depth.
	#[error("JTD import exceeds the maximum schema depth")]
	DepthLimit,
}

/// Converts one explicit JTD import into canonical JSON Schema.
///
/// This is intentionally an import seam, not a second schema authoring path:
/// the returned value uses JSON Schema exclusively and mixed JTD/JSON Schema
/// nodes are rejected.
pub fn import_jtd(schema: &serde_json::Value) -> Result<serde_json::Value, JtdImportError> {
	convert_jtd(schema, 0)
}

fn convert_jtd(
	schema: &serde_json::Value,
	depth: usize,
) -> Result<serde_json::Value, JtdImportError> {
	use serde_json::{Map, Value, json};

	if depth >= JTD_IMPORT_MAX_DEPTH {
		return Err(JtdImportError::DepthLimit);
	}
	let object = schema.as_object().ok_or(JtdImportError::InvalidForm)?;
	if object.is_empty() {
		return Ok(json!({}));
	}
	let forms = [
		"type",
		"enum",
		"elements",
		"values",
		"properties",
		"optionalProperties",
		"discriminator",
		"ref",
	];
	let form_count = forms
		.iter()
		.filter(|key| object.contains_key(**key))
		.count();
	let properties_form =
		object.contains_key("properties") || object.contains_key("optionalProperties");
	let effective_forms = form_count
		.saturating_sub(usize::from(properties_form && object.contains_key("properties")))
		.saturating_sub(usize::from(properties_form && object.contains_key("optionalProperties")))
		.saturating_add(usize::from(properties_form));
	if effective_forms != 1 {
		return Err(JtdImportError::InvalidForm);
	}
	let allowed_companion = |key: &str| {
		matches!(key, "nullable" | "metadata")
			|| (key == "mapping" && object.contains_key("discriminator"))
	};
	if object
		.keys()
		.any(|key| !forms.contains(&key.as_str()) && !allowed_companion(key))
	{
		return Err(JtdImportError::InvalidForm);
	}

	let mut converted = if let Some(kind) = object.get("type") {
		let kind = kind.as_str().ok_or(JtdImportError::UnsupportedPrimitive)?;
		let kind = match kind {
			"boolean" => "boolean",
			"string" | "timestamp" => "string",
			"float32" | "float64" => "number",
			"int8" | "uint8" | "int16" | "uint16" | "int32" | "uint32" => "integer",
			_ => return Err(JtdImportError::UnsupportedPrimitive),
		};
		json!({ "type": kind })
	} else if let Some(values) = object.get("enum") {
		let values = values.as_array().ok_or(JtdImportError::InvalidEnum)?;
		if values.is_empty() || values.iter().any(|value| !value.is_string()) {
			return Err(JtdImportError::InvalidEnum);
		}
		json!({ "enum": values })
	} else if let Some(elements) = object.get("elements") {
		json!({ "type": "array", "items": convert_jtd(elements, depth + 1)? })
	} else if let Some(values) = object.get("values") {
		json!({
			"type": "object",
			"additionalProperties": convert_jtd(values, depth + 1)?
		})
	} else if properties_form {
		let mut properties = Map::new();
		let mut required = Vec::new();
		if let Some(values) = object.get("properties") {
			let values = values
				.as_object()
				.ok_or(JtdImportError::InvalidProperties)?;
			for (name, schema) in values {
				properties.insert(name.clone(), convert_jtd(schema, depth + 1)?);
				required.push(Value::String(name.clone()));
			}
		}
		if let Some(values) = object.get("optionalProperties") {
			let values = values
				.as_object()
				.ok_or(JtdImportError::InvalidProperties)?;
			for (name, schema) in values {
				if properties.contains_key(name) {
					return Err(JtdImportError::InvalidProperties);
				}
				properties.insert(name.clone(), convert_jtd(schema, depth + 1)?);
			}
		}
		let mut result = Map::from_iter([
			("type".to_owned(), Value::String("object".to_owned())),
			("properties".to_owned(), Value::Object(properties)),
			("additionalProperties".to_owned(), Value::Bool(false)),
		]);
		if !required.is_empty() {
			result.insert("required".to_owned(), Value::Array(required));
		}
		Value::Object(result)
	} else if let Some(discriminator) = object.get("discriminator") {
		let discriminator = discriminator
			.as_str()
			.filter(|value| !value.is_empty())
			.ok_or(JtdImportError::InvalidDiscriminator)?;
		let mapping = object
			.get("mapping")
			.and_then(Value::as_object)
			.ok_or(JtdImportError::InvalidDiscriminator)?;
		if mapping.is_empty() {
			return Err(JtdImportError::InvalidDiscriminator);
		}
		let mut one_of = Vec::with_capacity(mapping.len());
		for (tag, schema) in mapping {
			let Value::Object(mut variant) = convert_jtd(schema, depth + 1)? else {
				return Err(JtdImportError::InvalidDiscriminator);
			};
			if variant.get("type").and_then(Value::as_str) != Some("object") {
				return Err(JtdImportError::InvalidDiscriminator);
			}
			let properties = variant
				.get_mut("properties")
				.and_then(Value::as_object_mut)
				.ok_or(JtdImportError::InvalidDiscriminator)?;
			properties.insert(discriminator.to_owned(), json!({ "const": tag }));
			let required = variant
				.entry("required")
				.or_insert_with(|| Value::Array(Vec::new()))
				.as_array_mut()
				.ok_or(JtdImportError::InvalidDiscriminator)?;
			if !required
				.iter()
				.any(|value| value.as_str() == Some(discriminator))
			{
				required.push(Value::String(discriminator.to_owned()));
			}
			one_of.push(Value::Object(variant));
		}
		json!({ "oneOf": one_of })
	} else if let Some(reference) = object.get("ref") {
		let reference = reference
			.as_str()
			.filter(|value| !value.is_empty())
			.ok_or(JtdImportError::InvalidForm)?;
		json!({ "$ref": format!("#/$defs/{reference}") })
	} else {
		return Err(JtdImportError::InvalidForm);
	};

	if object.get("nullable") == Some(&Value::Bool(true)) {
		converted = json!({ "anyOf": [converted, { "type": "null" }] });
	}
	Ok(converted)
}

/// A typed, pure renderer for one exact tool revision.
///
/// Updates are folded into [`State`](Self::State) synchronously. `view`
/// receives the current state and, after settlement, the typed durable outcome.
/// Returning `None` declines to the generic data fallback.
pub trait RenderFold: Send + Sync + 'static {
	/// Incrementally retained fold state.
	type State: Default + Send + Sync + 'static;
	/// Typed ephemeral update decoded from exact JSON bytes.
	type Update: DeserializeOwned;
	/// Typed durable outcome decoded from exact JSON bytes.
	type Outcome: DeserializeOwned;

	/// Incorporates one update in arrival order.
	fn fold(&self, state: &mut Self::State, update: Self::Update);
	/// Incorporates the latest lenient parse of the streaming argument text.
	///
	/// Hosts call this whenever more argument bytes arrive (`complete = false`)
	/// and once more with the committed arguments (`complete = true`). `args`
	/// is the accumulated parse of everything received so far, never a delta,
	/// so overriding renderers replace prior argument state instead of
	/// appending. The default ignores arguments; renderers that preview
	/// arguments while they stream override it.
	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, complete: bool) {
		let _ = (state, args, complete);
	}

	/// Produces TML or deterministic display data for the current fold position.
	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str>;
}

/// Compact retained state for one live or settled rendered call.
///
/// Unknown revisions retain their few raw updates inline for the generic
/// fallback. A registered renderer replaces those bytes with its typed
/// accumulator on the first fold.
#[derive(Default)]
pub struct ViewState {
	identity:    Option<Arc<ToolIdentity>>,
	fold:        FoldState,
	decorations: BTreeMap<u64, Box<dyn Any + Send + Sync>>,
}

enum FoldState {
	Updates(SmallVec<Bytes, 4>),
	Reduced(Box<dyn Any + Send + Sync>),
}

impl Default for FoldState {
	fn default() -> Self {
		Self::Updates(SmallVec::new())
	}
}

impl ViewState {
	/// Creates an empty fold state, not yet bound to an identity.
	pub fn new() -> Self {
		Self::default()
	}

	/// Borrows the exact identity bound by the first fold or view.
	pub fn identity(&self) -> Option<&ToolIdentity> {
		self.identity.as_deref()
	}

	/// Returns the number of raw updates retained for a generic fallback.
	pub const fn raw_update_count(&self) -> usize {
		match &self.fold {
			FoldState::Updates(updates) => updates.len(),
			FoldState::Reduced(_) => 0,
		}
	}

	fn bind(&mut self, identity: &ToolIdentity) -> Result<(), RenderRegistryError> {
		match &self.identity {
			Some(bound) if bound.as_ref() != identity => Err(RenderRegistryError::StateIdentity {
				bound:     bound.clone(),
				requested: identity.clone(),
			}),
			Some(_) => Ok(()),
			None => {
				self.identity = Some(Arc::new(identity.clone()));
				Ok(())
			},
		}
	}

	fn check(&self, identity: &ToolIdentity) -> Result<(), RenderRegistryError> {
		match &self.identity {
			Some(bound) if bound.as_ref() != identity => Err(RenderRegistryError::StateIdentity {
				bound:     bound.clone(),
				requested: identity.clone(),
			}),
			_ => Ok(()),
		}
	}
}

/// Deterministic renderer registration or dispatch failure.
#[derive(Debug, Error)]
pub enum RenderRegistryError {
	/// The exact `(name, revision)` key already has a renderer.
	#[error("renderer already registered: {0:?}")]
	Duplicate(ToolIdentity),
	/// One retained state was presented under another exact identity.
	#[error("render state for {bound:?} cannot be dispatched as {requested:?}")]
	StateIdentity {
		/// Identity which first bound the state.
		bound:     Arc<ToolIdentity>,
		/// Identity requested by the caller.
		requested: ToolIdentity,
	},
	/// An update did not match the renderer's typed update vocabulary.
	#[error("renderer update decode failed for {identity:?}: {source}")]
	Update {
		/// Exact renderer identity.
		identity: ToolIdentity,
		/// JSON decoder failure.
		source:   serde_json::Error,
	},
	/// A durable outcome did not match the renderer's typed outcome vocabulary.
	#[error("renderer outcome decode failed for {identity:?}: {source}")]
	Outcome {
		/// Exact renderer identity.
		identity: ToolIdentity,
		/// JSON decoder failure.
		source:   serde_json::Error,
	},
	/// Retained erased state did not belong to its registered renderer.
	#[error("renderer state type mismatch for {0:?}")]
	StateType(ToolIdentity),
	/// Generic fallback data was not UTF-8 JSON.
	#[error("generic renderer data is not UTF-8 for {identity:?}: {source}")]
	Utf8 {
		/// Exact requested identity.
		identity: ToolIdentity,
		/// UTF-8 decoder failure.
		source:   str::Utf8Error,
	},
}

const _: () = assert!(
	std::mem::size_of::<RenderRegistryError>() <= 128,
	"RenderRegistryError must stay compact"
);

trait ErasedRender: Send + Sync {
	fn initial(&self) -> Box<dyn Any + Send + Sync>;
	fn fold(
		&self,
		identity: &ToolIdentity,
		state: &mut dyn Any,
		update: &[u8],
	) -> Result<(), RenderRegistryError>;
	fn fold_args(
		&self,
		identity: &ToolIdentity,
		state: &mut dyn Any,
		args: &omp_core::slopjson::Value,
		complete: bool,
	) -> Result<(), RenderRegistryError>;
	fn view(
		&self,
		identity: &ToolIdentity,
		state: &dyn Any,
		outcome: Option<&[u8]>,
	) -> Result<Option<Str>, RenderRegistryError>;
}

struct RegisteredRender<R>(R);

impl<R: RenderFold> ErasedRender for RegisteredRender<R> {
	fn initial(&self) -> Box<dyn Any + Send + Sync> {
		Box::new(<R::State as Default>::default())
	}

	fn fold(
		&self,
		identity: &ToolIdentity,
		state: &mut dyn Any,
		update: &[u8],
	) -> Result<(), RenderRegistryError> {
		let state = state
			.downcast_mut::<R::State>()
			.ok_or_else(|| RenderRegistryError::StateType(identity.clone()))?;
		let update = serde_json::from_slice(update)
			.map_err(|source| RenderRegistryError::Update { identity: identity.clone(), source })?;
		self.0.fold(state, update);
		Ok(())
	}

	fn fold_args(
		&self,
		identity: &ToolIdentity,
		state: &mut dyn Any,
		args: &omp_core::slopjson::Value,
		complete: bool,
	) -> Result<(), RenderRegistryError> {
		let state = state
			.downcast_mut::<R::State>()
			.ok_or_else(|| RenderRegistryError::StateType(identity.clone()))?;
		self.0.fold_args(state, args, complete);
		Ok(())
	}

	fn view(
		&self,
		identity: &ToolIdentity,
		state: &dyn Any,
		outcome: Option<&[u8]>,
	) -> Result<Option<Str>, RenderRegistryError> {
		let state = state
			.downcast_ref::<R::State>()
			.ok_or_else(|| RenderRegistryError::StateType(identity.clone()))?;
		let outcome = outcome
			.map(serde_json::from_slice::<R::Outcome>)
			.transpose()
			.map_err(|source| RenderRegistryError::Outcome { identity: identity.clone(), source })?;
		Ok(self.0.view(state, outcome.as_ref()))
	}
}

/// Borrowed, cached exact-revision renderer lookup.
#[derive(Clone, Copy)]
pub struct RenderEntry<'a> {
	identity: &'a Arc<ToolIdentity>,
	render:   &'a dyn ErasedRender,
}

impl RenderEntry<'_> {
	/// Borrows the exact registered identity.
	pub fn identity(&self) -> &ToolIdentity {
		self.identity
	}

	/// Folds the accumulated streaming argument parse into retained state.
	///
	/// Retained raw updates are reduced first so argument context and typed
	/// updates land in one accumulator regardless of arrival order.
	pub fn fold_args(
		self,
		state: &mut ViewState,
		args: &omp_core::slopjson::Value,
		complete: bool,
	) -> Result<(), RenderRegistryError> {
		state.bind(self.identity)?;
		match &mut state.fold {
			FoldState::Reduced(reduced) => {
				self
					.render
					.fold_args(self.identity.as_ref(), reduced.as_mut(), args, complete)
			},
			FoldState::Updates(updates) => {
				let mut reduced = self.render.initial();
				for prior in updates.iter() {
					self
						.render
						.fold(self.identity.as_ref(), reduced.as_mut(), prior)?;
				}
				self
					.render
					.fold_args(self.identity.as_ref(), reduced.as_mut(), args, complete)?;
				state.fold = FoldState::Reduced(reduced);
				Ok(())
			},
		}
	}

	/// Folds one serialized update synchronously into retained state.
	pub fn fold(self, state: &mut ViewState, update: &[u8]) -> Result<(), RenderRegistryError> {
		state.bind(self.identity)?;
		match &mut state.fold {
			FoldState::Reduced(reduced) => {
				self
					.render
					.fold(self.identity.as_ref(), reduced.as_mut(), update)
			},
			FoldState::Updates(updates) => {
				let mut reduced = self.render.initial();
				for prior in updates.iter() {
					self
						.render
						.fold(self.identity.as_ref(), reduced.as_mut(), prior)?;
				}
				self
					.render
					.fold(self.identity.as_ref(), reduced.as_mut(), update)?;
				state.fold = FoldState::Reduced(reduced);
				Ok(())
			},
		}
	}

	/// Renders the current state and optional serialized durable outcome.
	pub fn view(
		self,
		state: &ViewState,
		outcome: Option<&[u8]>,
	) -> Result<Option<Str>, RenderRegistryError> {
		state.check(self.identity)?;
		match &state.fold {
			FoldState::Reduced(reduced) => {
				self
					.render
					.view(self.identity.as_ref(), reduced.as_ref(), outcome)
			},
			FoldState::Updates(updates) => {
				let mut reduced = self.render.initial();
				for update in updates {
					self
						.render
						.fold(self.identity.as_ref(), reduced.as_mut(), update)?;
				}
				self
					.render
					.view(self.identity.as_ref(), reduced.as_ref(), outcome)
			},
		}
	}
}

/// Immutable-by-key registry of exact-revision renderer folds.
#[derive(Default)]
pub struct RenderRegistry {
	entries:           BTreeMap<Arc<ToolIdentity>, Box<dyn ErasedRender>>,
	extension_entries: BTreeMap<Arc<ToolIdentity>, Box<dyn ErasedRender>>,
	decorations:       BTreeMap<Arc<ToolIdentity>, Vec<(u64, Box<dyn ErasedRender>)>>,
	next_extension_id: u64,
}

impl RenderRegistry {
	/// Creates an empty renderer registry.
	pub fn new() -> Self {
		Self::default()
	}

	/// Iterates exact registered renderer identities in stable key order.
	pub fn identities(
		&self,
	) -> impl DoubleEndedIterator<Item = &ToolIdentity> + iter::FusedIterator {
		self
			.entries
			.keys()
			.chain(self.extension_entries.keys())
			.chain(self.decorations.keys())
			.map(Arc::as_ref)
	}

	/// Registers one native renderer for one exact `(name, revision)` identity.
	pub fn register<R: RenderFold>(
		&mut self,
		identity: ToolIdentity,
		render: R,
	) -> Result<(), RenderRegistryError> {
		let identity = Arc::new(identity);
		if self.entries.contains_key(&identity) {
			return Err(RenderRegistryError::Duplicate((*identity).clone()));
		}
		self.extension_entries.remove(&identity);
		self
			.entries
			.insert(identity, Box::new(RegisteredRender(render)));
		Ok(())
	}

	/// Registers one extension renderer for one exact revision.
	///
	/// Non-decorating extension folds fill revisions without a native fold.
	/// Native folds remain authoritative regardless of registration order.
	/// Decorating folds are composed after the winning base renderer.
	pub fn register_extension<R: RenderFold>(
		&mut self,
		identity: ToolIdentity,
		render: R,
		decorates: bool,
	) -> Result<bool, RenderRegistryError> {
		let identity = Arc::new(identity);
		if decorates {
			let id = self.next_extension_id;
			self.next_extension_id = self.next_extension_id.wrapping_add(1);
			self
				.decorations
				.entry(identity)
				.or_default()
				.push((id, Box::new(RegisteredRender(render))));
			return Ok(true);
		}
		if self.entries.contains_key(&identity) || self.extension_entries.contains_key(&identity) {
			return Ok(false);
		}
		self
			.extension_entries
			.insert(identity, Box::new(RegisteredRender(render)));
		Ok(true)
	}

	/// Returns whether a native fold is authoritative for this exact revision.
	pub fn has_native(&self, identity: &ToolIdentity) -> bool {
		self.entries.contains_key(identity)
	}

	/// Returns whether this exact revision has a base fold or decoration.
	pub fn contains(&self, identity: &ToolIdentity) -> bool {
		self.entries.contains_key(identity)
			|| self.extension_entries.contains_key(identity)
			|| self.decorations.contains_key(identity)
	}

	/// Borrows the renderer cached for this exact identity.
	pub fn get(&self, identity: &ToolIdentity) -> Option<RenderEntry<'_>> {
		let (stored, render) = self
			.entries
			.get_key_value(identity)
			.or_else(|| self.extension_entries.get_key_value(identity))?;
		Some(RenderEntry { identity: stored, render: render.as_ref() })
	}

	/// Folds the accumulated streaming argument parse for an exact revision.
	///
	/// Unknown revisions ignore arguments: the generic fallback renders
	/// updates and outcomes only.
	pub fn fold_args(
		&self,
		identity: &ToolIdentity,
		state: &mut ViewState,
		args: &omp_core::slopjson::Value,
		complete: bool,
	) -> Result<(), RenderRegistryError> {
		if let Some(entry) = self.get(identity) {
			entry.fold_args(state, args, complete)?;
		}
		state.bind(identity)?;
		if let Some(decorations) = self.decorations.get(identity) {
			for (id, render) in decorations {
				let reduced = state
					.decorations
					.entry(*id)
					.or_insert_with(|| render.initial());
				render.fold_args(identity, reduced.as_mut(), args, complete)?;
			}
		}
		Ok(())
	}

	/// Resolves the latest registered identity for a tool name.
	///
	/// Streaming argument previews run before the exact revision is known;
	/// an active session invokes the newest registration, so ties across
	/// revision families break toward the highest revision number.
	pub fn resolve_name(&self, name: &str) -> Option<&ToolIdentity> {
		self
			.entries
			.keys()
			.chain(self.extension_entries.keys())
			.chain(self.decorations.keys())
			.filter(|identity| identity.name == name)
			.max_by_key(|identity| identity.rev.n)
			.map(Arc::as_ref)
	}

	/// Folds one update, retaining raw bytes only when the exact revision is
	/// unknown.
	pub fn fold(
		&self,
		identity: &ToolIdentity,
		state: &mut ViewState,
		update: Bytes,
	) -> Result<(), RenderRegistryError> {
		state.bind(identity)?;
		if let Some(entry) = self.get(identity) {
			entry.fold(state, &update)?;
		} else {
			match &mut state.fold {
				FoldState::Updates(updates) => {
					if updates.len() == 4 {
						let _ = updates.remove(0);
					}
					updates.push(update.clone());
				},
				FoldState::Reduced(_) => {
					return Err(RenderRegistryError::StateType(identity.clone()));
				},
			}
		}
		if let Some(decorations) = self.decorations.get(identity) {
			for (id, render) in decorations {
				if let Some(reduced) = state.decorations.get_mut(id) {
					render.fold(identity, reduced.as_mut(), &update)?;
					continue;
				}
				let mut reduced = render.initial();
				if self.get(identity).is_none()
					&& let FoldState::Updates(updates) = &state.fold
				{
					for prior in updates {
						render.fold(identity, reduced.as_mut(), prior)?;
					}
				} else {
					render.fold(identity, reduced.as_mut(), &update)?;
				}
				state.decorations.insert(*id, reduced);
			}
		}
		Ok(())
	}

	/// Replays a complete retained update stream through this registry.
	pub fn replay<I>(
		&self,
		identity: &ToolIdentity,
		updates: I,
		outcome: Option<&[u8]>,
	) -> Result<Str, RenderRegistryError>
	where
		I: IntoIterator<Item = Bytes>,
	{
		let mut state = ViewState::new();
		for update in updates {
			self.fold(identity, &mut state, update)?;
		}
		self.view(identity, &state, outcome)
	}

	/// Dispatches an exact-revision renderer or the generic built-in fallback.
	///
	/// No name-only lookup is attempted when the revision is unknown.
	pub fn view(
		&self,
		identity: &ToolIdentity,
		state: &ViewState,
		outcome: Option<&[u8]>,
	) -> Result<Str, RenderRegistryError> {
		state.check(identity)?;
		let mut rendered = if let Some(entry) = self.get(identity) {
			entry
				.view(state, outcome)?
				.unwrap_or(generic_view(identity, state, outcome)?)
		} else {
			generic_view(identity, state, outcome)?
		};
		if let Some(decorations) = self.decorations.get(identity) {
			for (id, render) in decorations {
				let decoration = if let Some(reduced) = state.decorations.get(id) {
					render.view(identity, reduced.as_ref(), outcome)?
				} else {
					let mut reduced = render.initial();
					if let FoldState::Updates(updates) = &state.fold {
						for update in updates {
							render.fold(identity, reduced.as_mut(), update)?;
						}
					}
					render.view(identity, reduced.as_ref(), outcome)?
				};
				if let Some(decoration) = decoration {
					let mut composed = StrMut::with_capacity(rendered.len() + decoration.len());
					composed.push_str(&rendered);
					composed.push_str(&decoration);
					rendered = composed.freeze();
				}
			}
		}
		Ok(rendered)
	}
}

fn generic_view(
	identity: &ToolIdentity,
	state: &ViewState,
	outcome: Option<&[u8]>,
) -> Result<Str, RenderRegistryError> {
	let data = outcome.or_else(|| match &state.fold {
		FoldState::Updates(updates) => updates.last().map(Bytes::as_ref),
		FoldState::Reduced(_) => None,
	});
	let Some(data) = data else {
		return Ok(Str::new_static("{}"));
	};
	let data = str::from_utf8(data)
		.map_err(|source| RenderRegistryError::Utf8 { identity: identity.clone(), source })?;
	Ok(Str::new(data))
}

#[cfg(test)]
mod jtd_tests {
	use serde_json::json;

	use super::{JtdImportError, import_jtd};

	#[test]
	fn imports_properties_and_elements_into_closed_json_schema() {
		let converted = import_jtd(&json!({
			"properties": {
				"findings": { "elements": { "type": "string" } },
				"count": { "type": "uint32" }
			},
			"optionalProperties": {
				"note": { "type": "string" }
			}
		}))
		.expect("valid JTD");
		assert_eq!(
			converted,
			json!({
				"type": "object",
				"properties": {
					"findings": { "type": "array", "items": { "type": "string" } },
					"count": { "type": "integer" },
					"note": { "type": "string" }
				},
				"additionalProperties": false,
				"required": ["findings", "count"]
			})
		);
	}

	#[test]
	fn mixed_json_schema_is_not_an_import_format() {
		let error = import_jtd(&json!({
			"type": "string",
			"description": "JSON Schema annotation"
		}))
		.expect_err("mixed authoring formats must be rejected");
		assert!(matches!(error, JtdImportError::InvalidForm));
	}
}
