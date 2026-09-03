//! Validated, indexed access to the checked-in binary catalog snapshot.

use std::{fs, io, mem, path::Path, sync::LazyLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
	CatalogOverlay, OverlayStack, ResolveError, UnsafeTrustScope,
	compile::{CatalogAlias, CompileError, CompiledCatalog, CompilerCensus},
	contrib::RuntimeProviderRecords,
	discover::DiscoveryDefaults,
	id::{
		AuthSpecId, CatalogRevision, DiscoverySpecId, HeaderProfileId, ModelKey, OAuthSpecId,
		ProviderId, RouteId, ThinkingPolicyId, WirePolicyId,
	},
	model::ModelSpec,
	policy::WirePolicy,
	provider::{AuthSpec, DiscoverySpec, HeaderProfile, OAuthSpec, ProviderDef, RouteDef},
	thinking::ThinkingPolicy,
};

const MAGIC: &[u8; 8] = b"OMPLLCAT";
const SCHEMA_VERSION: u32 = 1;
const HEADER_LEN: usize = 8 + 4 + 32 + 32 + 32;
const EMBEDDED_BYTES: &[u8] = include_bytes!("../data/catalog.postcard");
const OVERLAY_CACHE_SCHEMA: u32 = 1;

static EMBEDDED: LazyLock<Result<Catalog, SnapshotError>> = LazyLock::new(load_embedded);

/// Provenance hashes bound into a generated snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SnapshotProvenance {
	/// Digest of the ordered source lock entries.
	pub source_digest: [u8; 32],
}

/// Deterministic checked-in outputs produced from one compiled catalog.
#[derive(Debug, Eq, PartialEq)]
pub struct SnapshotArtifacts {
	/// Canonical normalized JSON retained for review.
	pub normalized_json: Vec<u8>,
	/// Private indexed postcard representation loaded at runtime.
	pub postcard:        Vec<u8>,
}

/// Validated catalog with compact deterministic lookup indexes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Catalog {
	compiled:               CompiledCatalog,
	provider_models:        Box<[(u32, u32)]>,
	model_index:            Box<[u32]>,
	wire_policy_ids:        Box<[WirePolicyId]>,
	thinking_policy_ids:    Box<[ThinkingPolicyId]>,
	source_digest:          [u8; 32],
	normalized_json_sha256: [u8; 32],
}

#[derive(Serialize, Deserialize)]
struct SnapshotPayload {
	catalog:             CompiledCatalog,
	provider_models:     Box<[(u32, u32)]>,
	model_index:         Box<[u32]>,
	wire_policy_ids:     Box<[WirePolicyId]>,
	thinking_policy_ids: Box<[ThinkingPolicyId]>,
}

#[derive(Serialize, Deserialize)]
struct CachedOverlaySnapshot {
	schema:  u32,
	overlay: CatalogOverlay,
}

/// Writes one complete credential-blind discovery overlay for restart recovery.
#[tracing::instrument(
	name = "catalog_overlay_cache_write",
	level = "debug",
	skip_all,
	fields(path = %path.display())
)]
pub fn write_discovery_overlay_cache(
	path: &Path,
	overlay: &CatalogOverlay,
) -> Result<(), OverlayCacheError> {
	let encoded = serde_json::to_vec(&CachedOverlaySnapshot {
		schema:  OVERLAY_CACHE_SCHEMA,
		overlay: overlay.clone(),
	})?;
	let parent = path.parent().unwrap_or_else(|| Path::new("."));
	fs::create_dir_all(parent)?;
	let name = path
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or("catalog-cache");
	let temporary = parent.join(format!(".{name}.{}.tmp", std::process::id()));
	let byte_count = encoded.len();
	fs::write(&temporary, encoded)?;
	if let Err(source) = fs::rename(&temporary, path) {
		let _ = fs::remove_file(&temporary);
		return Err(OverlayCacheError::Io(source));
	}
	tracing::debug!(byte_count, "discovery overlay cache published");
	Ok(())
}

/// Loads a credential-blind discovery overlay, rejecting unsupported cache
/// schemas.
#[tracing::instrument(
	name = "catalog_overlay_cache_read",
	level = "debug",
	skip_all,
	fields(path = %path.display())
)]
pub fn read_discovery_overlay_cache(
	path: &Path,
) -> Result<Option<CatalogOverlay>, OverlayCacheError> {
	let encoded = match fs::read(path) {
		Ok(encoded) => encoded,
		Err(error) if error.kind() == io::ErrorKind::NotFound => {
			tracing::debug!("discovery overlay cache miss");
			return Ok(None);
		},
		Err(error) => return Err(error.into()),
	};
	let cached: CachedOverlaySnapshot = serde_json::from_slice(&encoded)?;
	if cached.schema != OVERLAY_CACHE_SCHEMA {
		tracing::warn!(
			schema = cached.schema,
			expected_schema = OVERLAY_CACHE_SCHEMA,
			"discovery overlay cache schema rejected"
		);
		return Err(OverlayCacheError::UnsupportedSchema(cached.schema));
	}
	tracing::debug!(byte_count = encoded.len(), "discovery overlay cache hit");
	Ok(Some(cached.overlay))
}

/// Discovery overlay cache failure.
#[derive(Debug, thiserror::Error)]
pub enum OverlayCacheError {
	/// Filesystem operation failed.
	#[error(transparent)]
	Io(#[from] io::Error),
	/// The cache body was malformed.
	#[error(transparent)]
	Json(#[from] serde_json::Error),
	/// The cache schema is newer or older than this runtime.
	#[error("unsupported discovery overlay cache schema {0}")]
	UnsupportedSchema(u32),
}

/// Failure to generate deterministic snapshot artifacts.
#[derive(Debug, thiserror::Error)]
pub enum SnapshotBuildError {
	/// The normalized review artifact could not be encoded.
	#[error(transparent)]
	Compile(#[from] CompileError),
	/// The private postcard payload could not be encoded.
	#[error("catalog postcard encoding failed: {0}")]
	Postcard(#[from] postcard::Error),
	/// Compiled records violate an index invariant.
	#[error(transparent)]
	Invalid(#[from] SnapshotError),
}

/// Failure to validate or decode a binary catalog snapshot.
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
	/// The snapshot ends before its complete header.
	#[error("catalog snapshot is truncated")]
	Truncated,
	/// The file does not carry the catalog snapshot magic.
	#[error("catalog snapshot magic is invalid")]
	InvalidMagic,
	/// The snapshot schema is not supported by this runtime.
	#[error("unsupported catalog snapshot schema {0}")]
	UnsupportedSchema(u32),
	/// The snapshot was generated from a different source lock.
	#[error("catalog snapshot source digest does not match the checked source lock")]
	SourceDigestMismatch,
	/// The postcard payload was changed after generation.
	#[error("catalog snapshot payload hash mismatch")]
	PayloadHashMismatch,
	/// The private postcard payload is malformed.
	#[error("catalog postcard decoding failed: {0}")]
	Postcard(#[from] postcard::Error),
	/// A compiled record or lookup index violates a catalog invariant.
	#[error("catalog snapshot invariant failed: {0}")]
	Invariant(&'static str),
	/// An overlay stack failed precedence or trust validation.
	#[error(transparent)]
	Overlay(#[from] ResolveError),
}

impl Catalog {
	/// Returns the process-wide embedded catalog, panicking with validation
	/// evidence on corruption.
	pub fn embedded() -> &'static Self {
		match Self::try_embedded() {
			Ok(catalog) => catalog,
			Err(error) => panic!("embedded catalog is invalid: {error}"),
		}
	}

	/// Tries to open the process-wide embedded catalog without parsing JSON.
	pub fn try_embedded() -> Result<&'static Self, &'static SnapshotError> {
		EMBEDDED.as_ref()
	}

	/// Produces canonical JSON and the private postcard snapshot from compiled
	/// records.
	pub fn encode(
		catalog: CompiledCatalog,
		provenance: SnapshotProvenance,
	) -> Result<SnapshotArtifacts, SnapshotBuildError> {
		validate_catalog(&catalog)?;
		let normalized_json = catalog.normalized_json()?;
		let normalized_json_sha256 = Sha256::digest(&normalized_json);
		let provider_models = provider_model_index(&catalog)?;
		let model_index = model_index(&catalog)?;
		let wire_policy_ids = catalog
			.wire_policies
			.iter()
			.map(WirePolicy::content_id)
			.collect::<Vec<_>>()
			.into_boxed_slice();
		let thinking_policy_ids = catalog
			.thinking_policies
			.iter()
			.map(ThinkingPolicy::content_id)
			.collect::<Vec<_>>()
			.into_boxed_slice();
		ensure_strictly_sorted(&wire_policy_ids, "wire policy ids are not unique and sorted")?;
		ensure_strictly_sorted(
			&thinking_policy_ids,
			"thinking policy ids are not unique and sorted",
		)?;
		let payload = postcard::to_allocvec(&SnapshotPayload {
			catalog,
			provider_models,
			model_index,
			wire_policy_ids,
			thinking_policy_ids,
		})?;
		let payload_sha256 = Sha256::digest(&payload);
		let mut postcard = Vec::with_capacity(HEADER_LEN + payload.len());
		postcard.extend_from_slice(MAGIC);
		postcard.extend_from_slice(&SCHEMA_VERSION.to_le_bytes());
		postcard.extend_from_slice(&provenance.source_digest);
		postcard.extend_from_slice(&normalized_json_sha256);
		postcard.extend_from_slice(&payload_sha256);
		postcard.extend_from_slice(&payload);
		Ok(SnapshotArtifacts { normalized_json, postcard })
	}

	/// Decodes and validates arbitrary snapshot bytes against their
	/// self-contained hashes.
	pub fn decode(bytes: &[u8]) -> Result<Self, SnapshotError> {
		Self::decode_inner(bytes, None)
	}

	/// Decodes snapshot bytes while requiring a particular source-lock digest.
	pub fn decode_for_source(bytes: &[u8], source_digest: [u8; 32]) -> Result<Self, SnapshotError> {
		Self::decode_inner(bytes, Some(source_digest))
	}

	fn decode_inner(bytes: &[u8], expected_source: Option<[u8; 32]>) -> Result<Self, SnapshotError> {
		if bytes.len() < HEADER_LEN {
			return Err(SnapshotError::Truncated);
		}
		if &bytes[..8] != MAGIC {
			return Err(SnapshotError::InvalidMagic);
		}
		let schema = u32::from_le_bytes(bytes[8..12].try_into().expect("fixed schema field"));
		if schema != SCHEMA_VERSION {
			return Err(SnapshotError::UnsupportedSchema(schema));
		}
		let source_digest: [u8; 32] = bytes[12..44].try_into().expect("fixed digest field");
		if expected_source.is_some_and(|expected| expected != source_digest) {
			return Err(SnapshotError::SourceDigestMismatch);
		}
		let normalized_json_sha256 = bytes[44..76].try_into().expect("fixed digest field");
		let expected_payload_hash: [u8; 32] = bytes[76..108].try_into().expect("fixed digest field");
		let actual_payload_hash: [u8; 32] = Sha256::digest(&bytes[HEADER_LEN..]).into();
		if actual_payload_hash != expected_payload_hash {
			return Err(SnapshotError::PayloadHashMismatch);
		}
		let payload: SnapshotPayload = postcard::from_bytes(&bytes[HEADER_LEN..])?;
		validate_catalog(&payload.catalog)?;
		let expected_provider_models = provider_model_index(&payload.catalog)?;
		let expected_model_index = model_index(&payload.catalog)?;
		if payload.model_index != expected_model_index {
			return Err(SnapshotError::Invariant("model key index does not match catalog records"));
		}
		if payload.provider_models != expected_provider_models {
			return Err(SnapshotError::Invariant(
				"provider/model index does not match catalog records",
			));
		}
		validate_policy_ids(&payload)?;
		Ok(Self {
			compiled: payload.catalog,
			provider_models: payload.provider_models,
			model_index: payload.model_index,
			wire_policy_ids: payload.wire_policy_ids,
			thinking_policy_ids: payload.thinking_policy_ids,
			source_digest,
			normalized_json_sha256,
		})
	}

	/// Rebuilds a validated immutable snapshot with one admitted
	/// `@omp.provider` contribution.
	///
	/// Registration and teardown are generation swaps: callers retain the old
	/// snapshot for in-flight requests and publish the returned snapshot through
	/// the inference registry only after every route service is constructed.
	pub fn with_runtime_provider(
		&self,
		records: &RuntimeProviderRecords,
	) -> Result<Self, SnapshotError> {
		let mut compiled = self.compiled.clone();
		upsert_record(&mut compiled.providers, records.provider.clone(), |record| record.id.clone());
		for auth in &records.auth_specs {
			upsert_record(&mut compiled.auth_specs, auth.clone(), |record| record.id.clone());
		}
		for oauth in &records.oauth_specs {
			upsert_record(&mut compiled.oauth_specs, oauth.clone(), |record| record.id.clone());
		}
		for route in &records.routes {
			upsert_record(&mut compiled.routes, route.clone(), |record| record.id.clone());
		}
		for model in &records.models {
			upsert_record(&mut compiled.models, model.clone(), |record| record.key.clone());
		}
		compiled.census.providers = compiled.providers.len();
		compiled.census.logical_models = compiled.models.len();
		let contribution = serde_json::to_vec(records)
			.map_err(|_| SnapshotError::Invariant("runtime provider records do not serialize"))?;
		let digest = Sha256::digest(contribution);
		let mut suffix = String::with_capacity(16);
		for byte in &digest[..8] {
			use std::fmt::Write as _;
			let _ = write!(suffix, "{byte:02x}");
		}
		compiled.revision =
			CatalogRevision::from(format!("{}+runtime-{suffix}", self.compiled.revision.as_str()));
		validate_catalog(&compiled)?;
		let provider_models = provider_model_index(&compiled)?;
		let model_index = model_index(&compiled)?;
		let wire_policy_ids = compiled
			.wire_policies
			.iter()
			.map(WirePolicy::content_id)
			.collect::<Vec<_>>()
			.into_boxed_slice();
		let thinking_policy_ids = compiled
			.thinking_policies
			.iter()
			.map(ThinkingPolicy::content_id)
			.collect::<Vec<_>>()
			.into_boxed_slice();
		let normalized_json = compiled
			.normalized_json()
			.map_err(|_| SnapshotError::Invariant("runtime catalog normalization failed"))?;
		Ok(Self {
			compiled,
			provider_models,
			model_index,
			wire_policy_ids,
			thinking_policy_ids,
			source_digest: self.source_digest,
			normalized_json_sha256: Sha256::digest(normalized_json).into(),
		})
	}

	/// Materializes an admitted overlay stack into a validated immutable
	/// catalog snapshot.
	///
	/// Layers are applied in stack precedence order. Security-sensitive route
	/// changes require the corresponding explicit [`UnsafeTrustScope`].
	pub fn with_overlay_stack(
		&self,
		stack: &OverlayStack,
		scope: UnsafeTrustScope,
	) -> Result<Self, SnapshotError> {
		let mut compiled =
			crate::resolve::materialize_overlay_stack(self.compiled.clone(), stack, scope)?;
		compiled.census.providers = compiled.providers.len();
		compiled.census.logical_models = compiled.models.len();
		let contribution = serde_json::to_vec(stack.overlays())
			.map_err(|_| SnapshotError::Invariant("overlay stack does not serialize"))?;
		let digest = Sha256::digest(contribution);
		let mut suffix = String::with_capacity(16);
		for byte in &digest[..8] {
			use std::fmt::Write as _;
			let _ = write!(suffix, "{byte:02x}");
		}
		compiled.revision =
			CatalogRevision::from(format!("{}+overlay-{suffix}", self.compiled.revision.as_str()));
		validate_catalog(&compiled)?;
		let provider_models = provider_model_index(&compiled)?;
		let model_index = model_index(&compiled)?;
		let wire_policy_ids = compiled
			.wire_policies
			.iter()
			.map(WirePolicy::content_id)
			.collect::<Vec<_>>()
			.into_boxed_slice();
		let thinking_policy_ids = compiled
			.thinking_policies
			.iter()
			.map(ThinkingPolicy::content_id)
			.collect::<Vec<_>>()
			.into_boxed_slice();
		let normalized_json = compiled
			.normalized_json()
			.map_err(|_| SnapshotError::Invariant("overlay catalog normalization failed"))?;
		Ok(Self {
			compiled,
			provider_models,
			model_index,
			wire_policy_ids,
			thinking_policy_ids,
			source_digest: self.source_digest,
			normalized_json_sha256: Sha256::digest(normalized_json).into(),
		})
	}

	/// Returns the immutable catalog revision.
	pub const fn revision(&self) -> &CatalogRevision {
		&self.compiled.revision
	}

	/// Returns the verified compiler census.
	pub const fn census(&self) -> CompilerCensus {
		self.compiled.census
	}

	/// Returns providers in stable identifier order.
	pub fn providers(&self) -> &[ProviderDef] {
		&self.compiled.providers
	}

	/// Returns routes in stable identifier order.
	pub fn routes(&self) -> &[RouteDef] {
		&self.compiled.routes
	}

	/// Returns models in stable key order.
	pub fn models(&self) -> &[ModelSpec] {
		&self.compiled.models
	}

	/// Returns interned authentication specifications in stable identifier
	/// order.
	pub fn auth_specs(&self) -> &[AuthSpec] {
		&self.compiled.auth_specs
	}

	/// Returns interned public OAuth flow specifications in stable identifier
	/// order.
	pub fn oauth_specs(&self) -> &[OAuthSpec] {
		&self.compiled.oauth_specs
	}

	/// Returns interned safe header profiles in stable identifier order.
	pub fn header_profiles(&self) -> &[HeaderProfile] {
		&self.compiled.header_profiles
	}

	/// Returns interned discovery specifications in stable identifier order.
	pub fn discovery_specs(&self) -> &[DiscoverySpec] {
		&self.compiled.discovery_specs
	}

	/// Returns aliases in stable selector order.
	pub fn aliases(&self) -> &[CatalogAlias] {
		&self.compiled.aliases
	}

	/// Returns the source-lock digest bound into this snapshot.
	pub const fn source_digest(&self) -> &[u8; 32] {
		&self.source_digest
	}

	/// Returns the hash of the normalized JSON reviewed with this snapshot.
	pub const fn normalized_json_sha256(&self) -> &[u8; 32] {
		&self.normalized_json_sha256
	}

	/// Returns the compiled catalog backing this snapshot.
	///
	/// Test harnesses clone this to derive modified catalogs and re-[`encode`]
	/// them; production code uses the indexed lookups instead.
	///
	/// [`encode`]: Catalog::encode
	pub const fn compiled(&self) -> &CompiledCatalog {
		&self.compiled
	}

	/// Looks up one provider by exact stable identifier.
	pub fn provider(&self, id: &ProviderId<str>) -> Option<&ProviderDef> {
		self
			.compiled
			.providers
			.binary_search_by(|record| record.id.as_str().cmp(id.as_str()))
			.ok()
			.map(|index| &self.compiled.providers[index])
	}

	/// Returns authored conservative discovery defaults for one exact provider.
	pub fn discovery_defaults(&self, id: &ProviderId<str>) -> Option<&DiscoveryDefaults> {
		self.provider(id)?.discovery_defaults.as_ref()
	}

	/// Looks up one route by exact stable identifier.
	pub fn route(&self, id: &RouteId<str>) -> Option<&RouteDef> {
		self
			.compiled
			.routes
			.binary_search_by(|record| record.id.as_str().cmp(id.as_str()))
			.ok()
			.map(|index| &self.compiled.routes[index])
	}

	/// Looks up one model by exact normalized key.
	pub fn model(&self, key: &ModelKey<str>) -> Option<&ModelSpec> {
		let index = self.model_position(key)?;
		Some(&self.compiled.models[index])
	}

	/// Looks up a model only when it is exposed by the requested provider.
	pub fn model_for_provider(
		&self,
		provider: &ProviderId<str>,
		key: &ModelKey<str>,
	) -> Option<&ModelSpec> {
		let provider_index = self
			.compiled
			.providers
			.binary_search_by(|record| record.id.as_str().cmp(provider.as_str()))
			.ok()?;
		let model_index = self.model_position(key)?;
		let pair = (u32::try_from(provider_index).ok()?, u32::try_from(model_index).ok()?);
		self
			.provider_models
			.binary_search(&pair)
			.ok()
			.map(|_| &self.compiled.models[model_index])
	}

	fn model_position(&self, key: &ModelKey<str>) -> Option<usize> {
		let position = self
			.model_index
			.binary_search_by(|index| {
				self.compiled.models[*index as usize]
					.key
					.as_str()
					.cmp(key.as_str())
			})
			.ok()?;
		usize::try_from(self.model_index[position]).ok()
	}

	/// Resolves an exact alias to its canonical model record.
	pub fn resolve_alias(&self, alias: &str) -> Option<&ModelSpec> {
		let index = self
			.compiled
			.aliases
			.binary_search_by(|record| record.alias.as_str().cmp(alias))
			.ok()?;
		self.model(&self.compiled.aliases[index].target)
	}

	/// Looks up an interned authentication specification.
	pub fn auth_spec(&self, id: &AuthSpecId<str>) -> Option<&AuthSpec> {
		self
			.compiled
			.auth_specs
			.binary_search_by(|record| record.id.as_str().cmp(id.as_str()))
			.ok()
			.map(|index| &self.compiled.auth_specs[index])
	}

	/// Looks up an interned public OAuth flow specification.
	pub fn oauth_spec(&self, id: &OAuthSpecId<str>) -> Option<&OAuthSpec> {
		self
			.compiled
			.oauth_specs
			.binary_search_by(|record| record.id.as_str().cmp(id.as_str()))
			.ok()
			.map(|index| &self.compiled.oauth_specs[index])
	}

	/// Looks up an interned safe header profile.
	pub fn header_profile(&self, id: &HeaderProfileId<str>) -> Option<&HeaderProfile> {
		self
			.compiled
			.header_profiles
			.binary_search_by(|record| record.id.as_str().cmp(id.as_str()))
			.ok()
			.map(|index| &self.compiled.header_profiles[index])
	}

	/// Looks up an interned discovery specification.
	pub fn discovery_spec(&self, id: &DiscoverySpecId<str>) -> Option<&DiscoverySpec> {
		self
			.compiled
			.discovery_specs
			.binary_search_by(|record| record.id.as_str().cmp(id.as_str()))
			.ok()
			.map(|index| &self.compiled.discovery_specs[index])
	}

	/// Looks up an interned wire policy without re-hashing it.
	pub fn wire_policy(&self, id: &WirePolicyId<str>) -> Option<&WirePolicy> {
		let index = self
			.wire_policy_ids
			.binary_search_by(|candidate| candidate.as_str().cmp(id.as_str()))
			.ok()?;
		Some(&self.compiled.wire_policies[index])
	}

	/// Looks up an interned thinking policy without re-hashing it.
	pub fn thinking_policy(&self, id: &ThinkingPolicyId<str>) -> Option<&ThinkingPolicy> {
		let index = self
			.thinking_policy_ids
			.binary_search_by(|candidate| candidate.as_str().cmp(id.as_str()))
			.ok()?;
		Some(&self.compiled.thinking_policies[index])
	}
}

fn upsert_record<T, K: Ord>(records: &mut Box<[T]>, value: T, key: impl Fn(&T) -> K) {
	let target = key(&value);
	let mut values = mem::take(records).into_vec();
	values.retain(|record| key(record) != target);
	values.push(value);
	values.sort_by_key(key);
	*records = values.into_boxed_slice();
}

fn validate_catalog(catalog: &CompiledCatalog) -> Result<(), SnapshotError> {
	if catalog.schema_version != SCHEMA_VERSION {
		return Err(SnapshotError::UnsupportedSchema(catalog.schema_version));
	}
	if catalog.revision.as_str().is_empty() {
		return Err(SnapshotError::Invariant("catalog revision is empty"));
	}
	ensure_sorted_by(&catalog.providers, |record| &record.id, "providers are not uniquely sorted")?;
	ensure_sorted_by(&catalog.routes, |record| &record.id, "routes are not uniquely sorted")?;
	model_index(catalog)?;
	ensure_sorted_by(
		&catalog.auth_specs,
		|record| &record.id,
		"auth specs are not uniquely sorted",
	)?;
	ensure_sorted_by(
		&catalog.oauth_specs,
		|record| &record.id,
		"OAuth specs are not uniquely sorted",
	)?;
	ensure_sorted_by(
		&catalog.header_profiles,
		|record| &record.id,
		"header profiles are not uniquely sorted",
	)?;
	ensure_sorted_by(
		&catalog.discovery_specs,
		|record| &record.id,
		"discovery specs are not uniquely sorted",
	)?;
	for auth in &catalog.auth_specs {
		if let Some(oauth) = &auth.oauth
			&& catalog
				.oauth_specs
				.binary_search_by(|record| record.id.cmp(oauth))
				.is_err()
		{
			return Err(SnapshotError::Invariant("auth spec references an unknown OAuth flow"));
		}
	}
	for route in &catalog.routes {
		if catalog
			.providers
			.binary_search_by(|record| record.id.cmp(&route.provider))
			.is_err()
		{
			return Err(SnapshotError::Invariant("route references an unknown provider"));
		}
	}
	for model in &catalog.models {
		for route in &model.routes {
			if catalog
				.routes
				.binary_search_by(|record| record.id.cmp(route))
				.is_err()
			{
				return Err(SnapshotError::Invariant("model references an unknown route"));
			}
		}
		for (route, _) in &model.wire_ids {
			if catalog
				.routes
				.binary_search_by(|record| record.id.cmp(route))
				.is_err()
			{
				return Err(SnapshotError::Invariant("wire model id references an unknown route"));
			}
		}
	}
	for pair in catalog.aliases.windows(2) {
		if pair[0].alias >= pair[1].alias {
			return Err(SnapshotError::Invariant("aliases are not uniquely sorted"));
		}
	}
	for alias in &catalog.aliases {
		if !catalog.models.iter().any(|model| model.key == alias.target) {
			return Err(SnapshotError::Invariant("alias references an unknown model"));
		}
	}
	Ok(())
}

fn model_index(catalog: &CompiledCatalog) -> Result<Box<[u32]>, SnapshotError> {
	let mut index = (0..catalog.models.len())
		.map(|index| {
			u32::try_from(index).map_err(|_| SnapshotError::Invariant("model index exceeds u32"))
		})
		.collect::<Result<Vec<_>, _>>()?;
	index.sort_unstable_by(|left, right| {
		catalog.models[*left as usize]
			.key
			.cmp(&catalog.models[*right as usize].key)
	});
	for pair in index.windows(2) {
		if catalog.models[pair[0] as usize].key == catalog.models[pair[1] as usize].key {
			return Err(SnapshotError::Invariant("model keys are not unique"));
		}
	}
	Ok(index.into_boxed_slice())
}

fn provider_model_index(catalog: &CompiledCatalog) -> Result<Box<[(u32, u32)]>, SnapshotError> {
	let mut pairs = Vec::new();
	for (model_index, model) in catalog.models.iter().enumerate() {
		for route_id in &model.routes {
			let route_index = catalog
				.routes
				.binary_search_by(|route| route.id.cmp(route_id))
				.map_err(|_| SnapshotError::Invariant("model references an unknown route"))?;
			let provider_index = catalog
				.providers
				.binary_search_by(|provider| provider.id.cmp(&catalog.routes[route_index].provider))
				.map_err(|_| SnapshotError::Invariant("route references an unknown provider"))?;
			pairs.push((
				u32::try_from(provider_index)
					.map_err(|_| SnapshotError::Invariant("provider index exceeds u32"))?,
				u32::try_from(model_index)
					.map_err(|_| SnapshotError::Invariant("model index exceeds u32"))?,
			));
		}
	}
	pairs.sort_unstable();
	pairs.dedup();
	Ok(pairs.into_boxed_slice())
}

fn validate_policy_ids(payload: &SnapshotPayload) -> Result<(), SnapshotError> {
	if payload.wire_policy_ids.len() != payload.catalog.wire_policies.len()
		|| payload.thinking_policy_ids.len() != payload.catalog.thinking_policies.len()
	{
		return Err(SnapshotError::Invariant("policy index length does not match policy table"));
	}
	ensure_strictly_sorted(&payload.wire_policy_ids, "wire policy ids are not uniquely sorted")?;
	ensure_strictly_sorted(
		&payload.thinking_policy_ids,
		"thinking policy ids are not uniquely sorted",
	)
}

fn ensure_sorted_by<T, K: Ord>(
	values: &[T],
	key: impl Fn(&T) -> &K,
	message: &'static str,
) -> Result<(), SnapshotError> {
	if values.windows(2).any(|pair| key(&pair[0]) >= key(&pair[1])) {
		return Err(SnapshotError::Invariant(message));
	}
	Ok(())
}

fn ensure_strictly_sorted<T: Ord>(
	values: &[T],
	message: &'static str,
) -> Result<(), SnapshotError> {
	if values.windows(2).any(|pair| pair[0] >= pair[1]) {
		return Err(SnapshotError::Invariant(message));
	}
	Ok(())
}

#[tracing::instrument(
	name = "catalog_snapshot_load",
	level = "debug",
	skip_all,
	fields(snapshot_bytes = EMBEDDED_BYTES.len())
)]
fn load_embedded() -> Result<Catalog, SnapshotError> {
	let catalog = Catalog::decode_for_source(EMBEDDED_BYTES, embedded_source_digest())?;
	tracing::debug!(
		provider_count = catalog.providers().len(),
		model_count = catalog.models().len(),
		route_count = catalog.routes().len(),
		"embedded catalog snapshot loaded"
	);
	Ok(catalog)
}

fn embedded_source_digest() -> [u8; 32] {
	decode_hex_digest(env!("OMP_LLM_CATALOG_SOURCE_DIGEST"))
		.expect("build.rs emits a validated source digest")
}

fn decode_hex_digest(value: &str) -> Option<[u8; 32]> {
	if value.len() != 64 {
		return None;
	}
	let mut digest = [0_u8; 32];
	for (index, byte) in digest.iter_mut().enumerate() {
		*byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
	}
	Some(digest)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{
		CatalogOverlayBuilder, ExactSelector, ModelOverlay, ModelPatch, OverlaySource,
		ProvenanceKind, ProvenanceSource, RouteOverlay, RoutePatch,
	};

	#[test]
	fn embedded_snapshot_opens_and_indexes_deterministically() {
		let catalog = Catalog::embedded();
		assert!(!catalog.providers().is_empty());
		assert!(!catalog.routes().is_empty());
		assert!(!catalog.models().is_empty());
		assert!(!catalog.oauth_specs().is_empty());
		for oauth in catalog.oauth_specs() {
			assert_eq!(catalog.oauth_spec(&oauth.id), Some(oauth));
		}
		for auth in catalog.auth_specs() {
			if let Some(oauth) = &auth.oauth {
				assert!(catalog.oauth_spec(oauth).is_some(), "OAuth reference must resolve");
			}
		}
		for provider in catalog.providers() {
			assert_eq!(catalog.provider(&provider.id), Some(provider));
		}
		for route in catalog.routes() {
			assert_eq!(catalog.route(&route.id), Some(route));
		}
		for model in catalog.models() {
			assert_eq!(catalog.model(&model.key), Some(model));
		}
	}

	#[test]
	fn embedded_anthropic_route_uses_subscription_bootstrap_discovery() {
		let catalog = Catalog::embedded();
		let route = catalog
			.routes()
			.iter()
			.find(|route| {
				route.provider.as_str() == "anthropic" && route.id.as_str() == "anthropic/primary"
			})
			.expect("embedded Anthropic route");
		let discovery = route
			.discovery
			.as_ref()
			.and_then(|id| catalog.discovery_spec(id))
			.expect("embedded Anthropic discovery specification");

		assert_eq!(discovery.kind, crate::DiscoveryKind::AccountModels);
		assert_eq!(discovery.path.as_str(), "/api/claude_cli/bootstrap?model=claude-sonnet-5");
	}

	#[test]
	fn discovery_defaults_are_borrowed_from_exact_provider_records() {
		let catalog = Catalog::embedded();
		for provider in catalog.providers() {
			assert_eq!(catalog.discovery_defaults(&provider.id), provider.discovery_defaults.as_ref(),);
		}
		assert!(
			catalog
				.discovery_defaults(ProviderId::from_ref("missing-provider"))
				.is_none()
		);
	}

	#[test]
	fn overlay_stack_materializes_patches_into_catalog_indexes() {
		let catalog = Catalog::embedded();
		let model = catalog
			.models()
			.iter()
			.find(|model| !model.routes.is_empty())
			.expect("catalog model");
		let route = catalog.route(&model.routes[0]).expect("model route");
		let source = ProvenanceSource {
			kind:           ProvenanceKind::Configured,
			origin:         omp_core::Str::new_static("test-overlay"),
			revision:       None,
			confidence:     crate::EvidenceConfidence::Verified,
			observed_at_ms: None,
		};
		let overlay = CatalogOverlayBuilder::new(source)
			.with_model(ModelOverlay {
				selector: ExactSelector::new(route.provider.clone(), model.key.clone()),
				added:    None,
				patch:    ModelPatch {
					availability: Some(crate::ModelAvailability::Disabled),
					..ModelPatch::default()
				},
			})
			.build();
		let stack = OverlayStack::from_layers([(OverlaySource::UserConfig, overlay)]);
		let materialized = catalog
			.with_overlay_stack(&stack, UnsafeTrustScope::NONE)
			.expect("materialized overlay");
		assert_eq!(
			materialized
				.model(&model.key)
				.expect("patched model")
				.availability,
			crate::ModelAvailability::Disabled
		);
		assert_eq!(
			materialized.model_for_provider(&route.provider, &model.key),
			materialized.model(&model.key)
		);
	}

	#[test]
	fn overlay_stack_materializes_complete_unknown_provider() {
		let catalog = Catalog::embedded();
		let source_model = catalog
			.models()
			.iter()
			.find(|model| !model.routes.is_empty())
			.expect("source model");
		let source_route = catalog
			.route(&source_model.routes[0])
			.expect("source route");
		let source_provider = catalog
			.provider(&source_route.provider)
			.expect("source provider");
		let provider_id = ProviderId::from("configured-provider");
		let route_id = RouteId::from("configured-provider/primary");
		let model_key = ModelKey::from("configured-provider/model");
		let mut provider = source_provider.clone();
		provider.id = provider_id.clone();
		provider.routes = Box::new([route_id.clone()]);
		let mut route = source_route.clone();
		route.id = route_id.clone();
		route.provider = provider_id.clone();
		let mut model = source_model.clone();
		model.key = model_key.clone();
		model.routes = Box::new([route_id.clone()]);
		model.wire_ids =
			Box::new([(route_id.clone(), crate::WireModelId::from("configured-wire-model"))]);
		let source = ProvenanceSource {
			kind:           ProvenanceKind::Configured,
			origin:         omp_core::Str::new_static("configured-provider-test"),
			revision:       None,
			confidence:     crate::EvidenceConfidence::Declared,
			observed_at_ms: None,
		};
		let overlay = CatalogOverlayBuilder::new(source)
			.with_provider(provider)
			.with_route(RouteOverlay {
				route: route_id.clone(),
				added: Some(route),
				patch: RoutePatch::default(),
			})
			.with_model(ModelOverlay {
				selector: ExactSelector::new(provider_id.clone(), model_key.clone()),
				added:    Some(model),
				patch:    ModelPatch::default(),
			})
			.build();
		let materialized = catalog
			.with_overlay_stack(
				&OverlayStack::from_layers([(OverlaySource::UserConfig, overlay)]),
				UnsafeTrustScope::ALL,
			)
			.expect("unknown provider materializes");
		assert!(materialized.provider(&provider_id).is_some());
		assert!(materialized.route(&route_id).is_some());
		assert!(
			materialized
				.model_for_provider(&provider_id, &model_key)
				.is_some()
		);
	}

	#[test]
	fn corruption_and_provenance_mismatch_fail_loudly() {
		let mut corrupt = EMBEDDED_BYTES.to_vec();
		let last = corrupt.last_mut().expect("embedded snapshot is nonempty");
		*last ^= 0x80;
		assert!(matches!(Catalog::decode(&corrupt), Err(SnapshotError::PayloadHashMismatch)));
		let mut wrong_source = embedded_source_digest();
		wrong_source[0] ^= 0x80;
		assert!(matches!(
			Catalog::decode_for_source(EMBEDDED_BYTES, wrong_source),
			Err(SnapshotError::SourceDigestMismatch)
		));
	}

	#[test]
	fn alias_and_provider_model_indexes_match_catalog_relationships() {
		let catalog = Catalog::embedded();
		for alias in &catalog.compiled.aliases {
			assert_eq!(
				catalog
					.resolve_alias(alias.alias.as_str())
					.map(|model| &model.key),
				Some(&alias.target)
			);
		}
		for model in catalog.models() {
			for route_id in &model.routes {
				let route = catalog.route(route_id).expect("validated model route");
				assert_eq!(catalog.model_for_provider(&route.provider, &model.key), Some(model));
			}
		}
	}
}
