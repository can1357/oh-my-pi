//! Dense URL-scheme dispatch and constructor-owned resolver primitives.

use std::{
	fs,
	future::Future,
	io,
	io::Read as _,
	ops::Range,
	path::{Component, Path, PathBuf},
	str::{self, FromStr as _},
	sync::Arc,
};

use bytes::Bytes;
use dashmap::DashMap;
use flate2::read::GzDecoder;
use omp_core::{
	CowBytes, Hash32, Str, sf, sparse_index::TrySparseIndex, sparse_map::SparseMap,
	sparse_set::SparseSet,
};
use omp_tool::{ArtifactLifetime, Diag};
use smallvec::{SmallVec, smallvec};
use strum::{EnumString, FromRepr, IntoStaticStr, VariantArray};

use super::{
	Fault,
	format::{self, LineSpan, ResolvedRangeText, TextFormatOptions},
	selector::{LineRange, ParsedSelector, SelectorError},
};

include!(concat!(env!("OUT_DIR"), "/omp_docs.rs"));

/// Constructor-owned compressed harness documentation corpus.
#[derive(Debug)]
pub struct DocsArchive {
	inflated: DashMap<Str, CowBytes<'static>>,
	dev_root: PathBuf,
}

impl Default for DocsArchive {
	fn default() -> Self {
		Self {
			inflated: DashMap::new(),
			dev_root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs"),
		}
	}
}

impl DocsArchive {
	/// Returns sorted packaged document names without inflating bodies.
	pub fn names(&self) -> impl ExactSizeIterator<Item = &'static str> + Clone {
		PACKAGED_DOCS.iter().map(|(name, _)| *name)
	}

	/// Lazily inflates one packaged document, with a confined monorepo fallback.
	pub fn read(&self, relative: &str) -> Result<Option<CowBytes<'static>>, Fault> {
		validate_doc_path(relative)?;
		if let Some(bytes) = self.inflated.get(relative).map(|entry| entry.clone()) {
			return Ok(Some(bytes));
		}
		if let Ok(index) = PACKAGED_DOCS.binary_search_by_key(&relative, |(name, _)| *name) {
			let mut decoder = GzDecoder::new(PACKAGED_DOCS[index].1);
			let mut body = Vec::new();
			decoder
				.read_to_end(&mut body)
				.map_err(|source| Fault::Source {
					message: Str::new(format!("Packaged documentation is corrupt: {source}")),
				})?;
			let bytes = CowBytes::from(body);
			let cached = self
				.inflated
				.entry(Str::new(relative))
				.or_insert_with(|| bytes.clone())
				.clone();
			return Ok(Some(cached));
		}
		self.read_dev_fallback(relative)
	}

	fn read_dev_fallback(&self, relative: &str) -> Result<Option<CowBytes<'static>>, Fault> {
		let root = match self.dev_root.canonicalize() {
			Ok(root) => root,
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
			Err(source) => {
				return Err(Fault::Source {
					message: Str::new(format!("Cannot open development documentation root: {source}")),
				});
			},
		};
		let candidate = self.dev_root.join(relative);
		let canonical = match candidate.canonicalize() {
			Ok(canonical) => canonical,
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
			Err(source) => {
				return Err(Fault::Source {
					message: Str::new(format!("Cannot open development documentation: {source}")),
				});
			},
		};
		if !canonical.starts_with(&root) {
			return Err(Fault::Invalid {
				message: Str::new_static("omp:// documentation paths cannot escape the docs root."),
			});
		}
		let bytes = fs::read(canonical).map_err(|source| Fault::Source {
			message: Str::new(format!("Cannot read development documentation: {source}")),
		})?;
		Ok(Some(CowBytes::from(bytes)))
	}
}

fn validate_doc_path(relative: &str) -> Result<(), Fault> {
	let path = Path::new(relative);
	if relative.is_empty()
		|| relative.contains('\\')
		|| path.is_absolute()
		|| path
			.components()
			.any(|component| !matches!(component, Component::Normal(_)))
	{
		return Err(Fault::Invalid {
			message: Str::new_static(
				"Invalid omp:// documentation path; use a relative forward-slash path from the index.",
			),
		});
	}
	Ok(())
}

/// Scores a case-insensitive fuzzy subsequence match.
///
/// Exact, prefix, and substring matches outrank scattered subsequences.
pub fn fuzzy_score(query: &str, candidate: &str) -> Option<u32> {
	if query.is_empty() {
		return Some(1);
	}
	let query = query.to_ascii_lowercase();
	let candidate = candidate.to_ascii_lowercase();
	if candidate == query {
		return Some(4_000);
	}
	if candidate.starts_with(&query) {
		return Some(3_000u32.saturating_sub(candidate.len() as u32));
	}
	if let Some(index) = candidate.find(&query) {
		return Some(2_000u32.saturating_sub(index as u32));
	}
	let mut query_bytes = query.bytes();
	let mut wanted = query_bytes.next()?;
	let mut gaps = 0u32;
	for byte in candidate.bytes() {
		if byte == wanted {
			let Some(next) = query_bytes.next() else {
				return Some(1_000u32.saturating_sub(gaps));
			};
			wanted = next;
		} else {
			gaps = gaps.saturating_add(1);
		}
	}
	None
}

/// Canonical generated-data input shared with the frozen Python URL parser.
pub const URL_VOCABULARY_JSON: &str = include_str!("../../url-vocab.json");

/// A built-in URL scheme.
///
/// The discriminants are deliberately dense because [`ResolverTable`] uses
/// them as [`SparseMap`] keys on every read.
#[derive(
	IntoStaticStr,
	VariantArray,
	Clone,
	Copy,
	Debug,
	EnumString,
	Eq,
	FromRepr,
	Hash,
	PartialEq,
	serde::Deserialize,
	serde::Serialize,
)]
#[repr(u8)]
#[serde(rename_all = "lowercase")]
#[strum(ascii_case_insensitive, serialize_all = "lowercase")]
pub enum Scheme {
	/// A workspace or environment file path.
	File,
	/// HTTP or HTTPS.
	#[strum(to_string = "http", serialize = "https")]
	Http,
	/// A session artifact or durable content digest.
	Artifact,
	/// A read-only transcript.
	History,
	/// Settled subagent output.
	Agent,
	/// Session scratch storage.
	Local,
	/// Project memory.
	Memory,
	/// An MCP-owned resource URI.
	Mcp,
	/// Installed skill content.
	Skill,
	/// Installed rule content.
	Rule,
	/// Bundled harness documentation.
	Omp,
	/// A cached GitHub issue.
	Issue,
	/// A cached GitHub pull request.
	Pr,
	/// A remote SSH resource.
	Ssh,
	/// Project-owned security reports and validated advisories.
	Security,
	/// A granted vault resource.
	Vault,
	/// Detached-job output.
	Job,
	/// A session-owned attachment commit target.
	Attachment,
	/// A session-registered merge conflict region.
	Conflict,
	/// A syntactically valid scheme outside the built-in vocabulary.
	Unknown,
}

impl Scheme {
	/// Every dense built-in variant in discriminant order.
	pub const ALL: &'static [Self] = <Self as VariantArray>::VARIANTS;

	/// Parses a caller spelling, mapping syntactically valid unrecognized names
	/// to [`Scheme::Unknown`].
	pub fn parse(value: &str) -> Self {
		Self::from_str(value).unwrap_or(Self::Unknown)
	}

	/// Whether this scheme's resource grammar permits a trailing read selector.
	pub const fn accepts_selectors(self) -> bool {
		!matches!(self, Self::Mcp | Self::Unknown)
	}
}

/// An invalid dense scheme index.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("invalid scheme index {0}")]
pub struct SchemeIndexError(usize);

impl TrySparseIndex for Scheme {
	type Error = SchemeIndexError;

	fn index(&self) -> usize {
		usize::from(*self as u8)
	}

	fn try_from_index(index: usize) -> Result<Self, Self::Error> {
		let repr = u8::try_from(index).map_err(|_| SchemeIndexError(index))?;
		Self::from_repr(repr).ok_or(SchemeIndexError(index))
	}
}

/// A compact index into constructor-owned resolver state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResolverId(usize);

impl ResolverId {
	/// Returns the resolver's constructor-order index.
	pub const fn index(self) -> usize {
		self.0
	}
}

/// Resolves one URL scheme to readable bytes.
///
/// Implement this trait on a concrete resolver or on an enum containing every
/// resolver kind used by a host. That keeps the future unboxed and the state
/// constructor-owned without a per-call trait-object allocation.
pub trait Resolve: Send + Sync + 'static {
	/// Reads the addressed resource, applying `selector` when supported.
	fn read<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> impl Future<Output = Result<CowBytes<'static>, Fault>> + Send + 'a;

	/// Reads a resource together with structured harness diagnostics.
	fn read_with_diags<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> impl Future<Output = Result<ResolvedRead, Fault>> + Send + 'a {
		async move {
			self
				.read(resource, selector)
				.await
				.map(|data| ResolvedRead { data, diags: smallvec![] })
		}
	}

	/// Reads a resource with its URI query preserved.
	///
	/// Resolvers which do not own query semantics inherit the ordinary read
	/// path. Query-aware resolvers override this without forcing allocations on
	/// the common query-free path.
	fn read_query<'a>(
		&'a self,
		resource: &'a str,
		query: Option<&'a str>,
		selector: &'a ParsedSelector,
	) -> impl Future<Output = Result<CowBytes<'static>, Fault>> + Send + 'a {
		let _ = query;
		self.read(resource, selector)
	}

	/// Reads a query-preserving resource together with structured diagnostics.
	fn read_query_with_diags<'a>(
		&'a self,
		resource: &'a str,
		query: Option<&'a str>,
		selector: &'a ParsedSelector,
	) -> impl Future<Output = Result<ResolvedRead, Fault>> + Send + 'a {
		async move {
			self
				.read_query(resource, query, selector)
				.await
				.map(|data| ResolvedRead { data, diags: smallvec![] })
		}
	}

	/// Lists direct entries below the addressed resource.
	fn list<'a>(
		&'a self,
		_resource: &'a str,
		_max_entries: usize,
		_max_bytes: usize,
	) -> impl Future<Output = Result<ResourceList, Fault>> + Send + 'a {
		async { Err(Fault::Invalid { message: Str::new_static("This resource cannot be listed.") }) }
	}

	/// Resolves the addressed resource to an Environment URI without reading
	/// bytes.
	fn path<'a>(
		&'a self,
		_resource: &'a str,
	) -> impl Future<Output = Result<Option<Str>, Fault>> + Send + 'a {
		async {
			Err(Fault::Invalid {
				message: Str::new_static("This resource has no materializable path."),
			})
		}
	}

	/// Returns bounded local completion candidates.
	fn complete<'a>(
		&'a self,
		_query: &'a str,
		_max_results: usize,
	) -> impl Future<Output = Result<Vec<ResourceCompletion>, Fault>> + Send + 'a {
		async { Ok(Vec::new()) }
	}
}

/// One deterministic resource-list entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceEntry {
	/// Canonical internal URI.
	pub uri:       Str,
	/// Display name.
	pub name:      Str,
	/// Whether this entry is a directory.
	pub directory: bool,
	/// Exact byte length when known, otherwise zero.
	pub size:      u64,
}

/// Bounded list returned by one resolver.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ResourceList {
	/// Deterministically ordered entries.
	pub entries:   Vec<ResourceEntry>,
	/// Whether the resolver omitted entries or bytes.
	pub truncated: bool,
}

/// One internal-resource completion candidate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceCompletion {
	/// Complete URI inserted for the caller.
	pub value:       Str,
	/// One-line human-facing description.
	pub description: Str,
	/// Match quality; higher values sort first.
	pub score:       u32,
}

/// Immutable capability and catalog stamp for one scheme.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResourceStamp {
	/// Device catalog digest.
	pub device_hash: [u8; 32],
	/// Catalog revision.
	pub revision:    u64,
	/// Whether bytes from this scheme are edit-locked.
	pub immutable:   bool,
}

/// One installed resolver's live capabilities.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceCapability {
	/// Canonical scheme spelling.
	pub scheme:      &'static str,
	/// Bounded content reads.
	pub read:        bool,
	/// Deterministic entry listing.
	pub list:        bool,
	/// Canonical path-only lookup.
	pub path:        bool,
	/// Local autocomplete.
	pub complete:    bool,
	/// Immutable capability/catalog stamp.
	pub stamp:       ResourceStamp,
	/// Human-facing capability description.
	pub description: Str,
}

/// Resolver bytes with structured harness diagnostics.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedRead {
	/// Returned bytes.
	pub data:  CowBytes<'static>,
	/// Structured harness notices.
	pub diags: SmallVec<Diag, 2>,
}

/// Result of a bounded resource read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceRead {
	/// Returned bytes; empty for path-only operations.
	pub data:               CowBytes<'static>,
	/// Canonical Environment path URI when one exists.
	pub canonical_path_uri: Option<Str>,
	/// Whether data was cut at the request ceiling.
	pub truncated:          bool,
	/// Immutable capability/catalog stamp.
	pub stamp:              ResourceStamp,
}

/// Canonical metadata for one resolver registration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SchemeEntry {
	/// Dense scheme identity.
	pub scheme:      Scheme,
	/// Generated Python enum member spelling.
	pub member:      Str,
	/// Whether reads route to the registered resolver under current policy.
	pub readable:    bool,
	/// Whether the current policy permits minting this scheme.
	pub mintable:    bool,
	/// Whether direct entry listing is supported.
	pub listable:    bool,
	/// Whether canonical path-only resolution is supported.
	pub pathable:    bool,
	/// Whether local autocomplete is supported.
	pub completable: bool,
	/// Whether resolved resources are edit-locked.
	pub immutable:   bool,
	/// Resolver-owned monotone content/catalog revision.
	pub revision:    u64,
	/// Whether the scheme resource grammar accepts trailing read selectors.
	pub selectors:   bool,
	/// Whether bounded dispatch must return the complete body.
	pub whole_body:  bool,
	/// Human-readable live capability description.
	pub description: Str,
}

impl SchemeEntry {
	/// Constructs metadata, deriving canonical member and selector vocabulary
	/// from the dense scheme.
	pub fn new(scheme: Scheme, readable: bool, mintable: bool, description: impl Into<Str>) -> Self {
		Self {
			scheme,
			member: Str::new(format!("{scheme:?}").to_ascii_uppercase()),
			readable,
			mintable,
			listable: false,
			pathable: false,
			completable: false,
			immutable: true,
			revision: 1,
			selectors: scheme.accepts_selectors(),
			whole_body: false,
			description: description.into(),
		}
	}

	/// Declares list, path, and completion capabilities.
	pub const fn with_capabilities(
		mut self,
		listable: bool,
		pathable: bool,
		completable: bool,
	) -> Self {
		self.listable = listable;
		self.pathable = pathable;
		self.completable = completable;
		self
	}

	/// Bypasses generic byte truncation because the resolver owns a complete
	/// bounded body (used by installed skill/rule documents).
	pub const fn with_whole_body(mut self, whole_body: bool) -> Self {
		self.whole_body = whole_body;
		self
	}

	/// Sets editability and the resolver-owned revision.
	pub const fn with_stamp(mut self, immutable: bool, revision: u64) -> Self {
		self.immutable = immutable;
		self.revision = revision;
		self
	}
}

/// Device-hash-keyed resolver metadata shared with extension hosts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SchemeSnapshot {
	/// Registry device-side digest that invalidates this snapshot.
	pub device_hash: [u8; 32],
	/// Constructor-order scheme metadata.
	pub entries:     Box<[SchemeEntry]>,
}

/// Error constructing a resolver table.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ResolverTableError {
	/// Two resolver values claimed one scheme.
	#[error("duplicate resolver for {0:?}")]
	Duplicate(Scheme),
	/// Unknown schemes cannot be registered.
	#[error("the unknown scheme cannot have a resolver")]
	Unknown,
}

/// Builder for one immutable constructor-owned resolver table.
#[derive(Debug)]
pub struct ResolverTableBuilder<R> {
	claimed:          SparseSet<Scheme>,
	entries:          Vec<SchemeEntry>,
	resolvers:        Vec<R>,
	unknown_fallback: Option<R>,
}

impl<R> Default for ResolverTableBuilder<R> {
	fn default() -> Self {
		Self {
			claimed:          SparseSet::with_capacity(Scheme::ALL.len()),
			entries:          Vec::new(),
			resolvers:        Vec::new(),
			unknown_fallback: None,
		}
	}
}

impl<R> ResolverTableBuilder<R> {
	/// Registers one resolver and its live policy metadata.
	pub fn register(&mut self, entry: SchemeEntry, resolver: R) -> Result<(), ResolverTableError> {
		if entry.scheme == Scheme::Unknown {
			return Err(ResolverTableError::Unknown);
		}
		if !self.claimed.insert(entry.scheme) {
			return Err(ResolverTableError::Duplicate(entry.scheme));
		}
		self.entries.push(entry);
		self.resolvers.push(resolver);
		Ok(())
	}

	/// Installs one raw-scheme fallback without registering
	/// [`Scheme::Unknown`] in the dense built-in table.
	pub fn install_unknown_fallback(&mut self, resolver: R) -> Result<(), ResolverTableError> {
		if self.unknown_fallback.replace(resolver).is_some() {
			return Err(ResolverTableError::Duplicate(Scheme::Unknown));
		}
		Ok(())
	}

	/// Freezes registrations into an O(1) dispatch table.
	pub fn build(self) -> ResolverTable<R> {
		let mut routes = SparseMap::with_capacity(Scheme::ALL.len());
		let mut hasher = Hash32::hasher();
		for (index, entry) in self.entries.iter().enumerate() {
			if entry.readable || entry.listable || entry.pathable || entry.completable {
				routes.insert(entry.scheme, ResolverId(index));
			}
			let scheme: &'static str = entry.scheme.into();
			hasher
				.update(scheme)
				.update([entry.readable as u8, entry.listable as u8, entry.pathable as u8])
				.update([entry.completable as u8, entry.immutable as u8, entry.whole_body as u8])
				.update(entry.revision.to_le_bytes())
				.update(entry.description.as_bytes());
		}
		let device_hash = hasher.finalize().into_bytes();
		let revision = u64::from_le_bytes(
			device_hash[..8]
				.try_into()
				.expect("a 32-byte hash always has an 8-byte prefix"),
		)
		.max(1);
		ResolverTable {
			routes,
			entries: self.entries.into_boxed_slice(),
			resolvers: self.resolvers.into_boxed_slice(),
			unknown_fallback: self.unknown_fallback,
			device_hash,
			revision,
		}
	}
}

/// O(1) scheme dispatch into concrete, constructor-owned resolver state.
#[derive(Debug)]
pub struct ResolverTable<R> {
	routes:           SparseMap<Scheme, ResolverId>,
	entries:          Box<[SchemeEntry]>,
	resolvers:        Box<[R]>,
	unknown_fallback: Option<R>,
	device_hash:      [u8; 32],
	revision:         u64,
}

impl<R> Default for ResolverTable<R> {
	fn default() -> Self {
		ResolverTableBuilder::default().build()
	}
}

impl<R> ResolverTable<R> {
	/// Starts an empty metadata-bearing resolver builder.
	pub fn builder() -> ResolverTableBuilder<R> {
		ResolverTableBuilder::default()
	}

	/// Returns the dense route map used by dispatch.
	pub const fn routes(&self) -> &SparseMap<Scheme, ResolverId> {
		&self.routes
	}

	/// Returns every registered scheme's live metadata.
	pub const fn entries(&self) -> &[SchemeEntry] {
		&self.entries
	}

	/// Captures immutable metadata under the constructor-derived device digest.
	pub fn snapshot(&self) -> SchemeSnapshot {
		SchemeSnapshot { device_hash: self.device_hash, entries: self.entries.clone() }
	}

	/// Returns the constructor-derived device digest.
	pub const fn device_hash(&self) -> [u8; 32] {
		self.device_hash
	}

	/// Returns the immutable device-hash-keyed catalog revision.
	pub const fn revision(&self) -> u64 {
		self.revision
	}

	/// Whether this deployment has a bounded raw-scheme fallback.
	pub const fn has_unknown_fallback(&self) -> bool {
		self.unknown_fallback.is_some()
	}

	/// Returns metadata for one installed scheme.
	pub fn entry(&self, scheme: Scheme) -> Option<&SchemeEntry> {
		let id = *self.routes.get(scheme)?;
		self.entries.get(id.index())
	}

	/// Returns the live capability for one installed scheme.
	pub fn capability(&self, scheme: Scheme) -> Option<ResourceCapability> {
		let entry = self.entry(scheme)?;
		Some(ResourceCapability {
			scheme:      entry.scheme.into(),
			read:        entry.readable,
			list:        entry.listable,
			path:        entry.pathable,
			complete:    entry.completable,
			stamp:       ResourceStamp {
				device_hash: self.device_hash,
				revision:    entry.revision,
				immutable:   entry.immutable,
			},
			description: entry.description.clone(),
		})
	}

	/// Iterates installed capabilities in constructor order without allocation.
	pub fn capabilities(&self) -> impl ExactSizeIterator<Item = ResourceCapability> + '_ {
		self.entries.iter().map(|entry| ResourceCapability {
			scheme:      entry.scheme.into(),
			read:        entry.readable,
			list:        entry.listable,
			path:        entry.pathable,
			complete:    entry.completable,
			stamp:       ResourceStamp {
				device_hash: self.device_hash,
				revision:    entry.revision,
				immutable:   entry.immutable,
			},
			description: entry.description.clone(),
		})
	}

	/// Returns the resolver selected for `scheme`.
	pub fn get(&self, scheme: Scheme) -> Option<&R> {
		let id = *self.routes.get(scheme)?;
		self.resolvers.get(id.index())
	}
}

impl<R: Resolve> ResolverTable<R> {
	/// Dispatches one raw-scheme read through the separately installed
	/// fallback. The complete authored URI is preserved for the host.
	pub async fn read_unknown(
		&self,
		uri: &str,
		selector: &ParsedSelector,
	) -> Option<Result<CowBytes<'static>, Fault>> {
		Some(self.unknown_fallback.as_ref()?.read(uri, selector).await)
	}

	/// Dispatches one raw-scheme read with its structured diagnostics.
	pub async fn read_unknown_with_diags(
		&self,
		uri: &str,
		selector: &ParsedSelector,
	) -> Option<Result<ResolvedRead, Fault>> {
		Some(
			self
				.unknown_fallback
				.as_ref()?
				.read_with_diags(uri, selector)
				.await,
		)
	}

	/// Dispatches one read, returning `None` when this deployment has no reader
	/// for the scheme.
	pub async fn read(
		&self,
		scheme: Scheme,
		resource: &str,
		selector: &ParsedSelector,
	) -> Option<Result<CowBytes<'static>, Fault>> {
		self.read_query(scheme, resource, None, selector).await
	}

	/// Dispatches one query-preserving read.
	pub async fn read_query(
		&self,
		scheme: Scheme,
		resource: &str,
		query: Option<&str>,
		selector: &ParsedSelector,
	) -> Option<Result<CowBytes<'static>, Fault>> {
		let entry = self.entry(scheme)?;
		entry.readable.then_some(())?;
		Some(
			self
				.get(scheme)?
				.read_query(resource, query, selector)
				.await,
		)
	}

	/// Dispatches one query-preserving read with its structured diagnostics.
	pub async fn read_query_with_diags(
		&self,
		scheme: Scheme,
		resource: &str,
		query: Option<&str>,
		selector: &ParsedSelector,
	) -> Option<Result<ResolvedRead, Fault>> {
		let entry = self.entry(scheme)?;
		entry.readable.then_some(())?;
		Some(
			self
				.get(scheme)?
				.read_query_with_diags(resource, query, selector)
				.await,
		)
	}

	/// Performs a byte-bounded read or path-only lookup.
	pub async fn read_bounded(
		&self,
		scheme: Scheme,
		resource: &str,
		selector: &ParsedSelector,
		max_bytes: usize,
		path_only: bool,
	) -> Option<Result<ResourceRead, Fault>> {
		self
			.read_bounded_query(scheme, resource, None, selector, max_bytes, path_only)
			.await
	}

	/// Performs a query-preserving byte-bounded read or path-only lookup.
	pub async fn read_bounded_query(
		&self,
		scheme: Scheme,
		resource: &str,
		query: Option<&str>,
		selector: &ParsedSelector,
		max_bytes: usize,
		path_only: bool,
	) -> Option<Result<ResourceRead, Fault>> {
		let entry = self.entry(scheme)?;
		if !entry.readable || (path_only && !entry.pathable) {
			return None;
		}
		let resolver = self.get(scheme)?;
		let canonical_path_uri = if entry.pathable {
			match resolver.path(resource).await {
				Ok(path) => path,
				Err(error) if path_only => return Some(Err(error)),
				Err(_) => None,
			}
		} else {
			None
		};
		let stamp = ResourceStamp {
			device_hash: self.device_hash,
			revision:    entry.revision,
			immutable:   entry.immutable,
		};
		if path_only {
			return Some(Ok(ResourceRead {
				data: CowBytes::default(),
				canonical_path_uri,
				truncated: false,
				stamp,
			}));
		}
		let bytes = match resolver.read_query(resource, query, selector).await {
			Ok(bytes) => bytes,
			Err(error) => return Some(Err(error)),
		};
		let truncated = !entry.whole_body && bytes.len() > max_bytes;
		let data = if truncated {
			bytes.slice(..max_bytes).into_owned()
		} else {
			bytes
		};
		Some(Ok(ResourceRead { data, canonical_path_uri, truncated, stamp }))
	}

	/// Performs a bounded deterministic listing.
	pub async fn list(
		&self,
		scheme: Scheme,
		resource: &str,
		max_entries: usize,
		max_bytes: usize,
	) -> Option<Result<ResourceList, Fault>> {
		let entry = self.entry(scheme)?;
		entry.listable.then_some(())?;
		let resolver = self.get(scheme)?;
		let mut listing = match resolver.list(resource, max_entries, max_bytes).await {
			Ok(listing) => listing,
			Err(error) => return Some(Err(error)),
		};
		listing.entries.sort_unstable_by(|left, right| {
			left
				.name
				.cmp(&right.name)
				.then_with(|| left.uri.cmp(&right.uri))
		});
		let mut retained = listing.entries.len().min(max_entries);
		let mut used = 0usize;
		for (index, entry) in listing.entries[..retained].iter().enumerate() {
			let bytes = entry.uri.len().saturating_add(entry.name.len());
			if used.saturating_add(bytes) > max_bytes {
				retained = index;
				break;
			}
			used += bytes;
		}
		if retained < listing.entries.len() {
			listing.entries.truncate(retained);
			listing.truncated = true;
		}
		Some(Ok(listing))
	}

	/// Resolves a canonical Environment path without reading bytes.
	pub async fn path(&self, scheme: Scheme, resource: &str) -> Option<Result<ResourceRead, Fault>> {
		self
			.read_bounded(scheme, resource, &ParsedSelector::None, 0, true)
			.await
	}

	/// Returns bounded, deterministically sorted completion candidates.
	pub async fn complete(
		&self,
		scheme: Scheme,
		query: &str,
		max_results: usize,
	) -> Option<Result<(Vec<ResourceCompletion>, bool), Fault>> {
		let entry = self.entry(scheme)?;
		entry.completable.then_some(())?;
		let resolver = self.get(scheme)?;
		let requested = max_results.saturating_add(1);
		let mut completions = match resolver.complete(query, requested).await {
			Ok(completions) => completions,
			Err(error) => return Some(Err(error)),
		};
		completions.sort_unstable_by(|left, right| {
			right
				.score
				.cmp(&left.score)
				.then_with(|| left.value.cmp(&right.value))
		});
		let truncated = completions.len() > max_results;
		completions.truncate(max_results);
		Some(Ok((completions, truncated)))
	}
}

/// A resolver marker used when a host installs no internal URL readers.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoResolver;

impl Resolve for NoResolver {
	fn read<'a>(
		&'a self,
		_resource: &'a str,
		_selector: &'a ParsedSelector,
	) -> impl Future<Output = Result<CowBytes<'static>, Fault>> + Send + 'a {
		async { unreachable!("NoResolver is never installed in a ResolverTable") }
	}
}

/// Exact byte length reported by the authoritative blob store.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BlobStat {
	/// Exact stored byte length.
	pub byte_len: u64,
}

/// Immutable artifact metadata resolved by ordinal or digest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactRecord {
	/// Content digest in the environment blob namespace.
	pub digest:   Str,
	/// Retention tier controlling whether digest-form addressing is legal.
	pub lifetime: ArtifactLifetime,
}

/// Resolves artifact names to immutable artifact records.
pub trait ArtifactCatalog: Send + Sync + 'static {
	/// Resolves a short ordinal in the current session.
	fn by_ordinal(
		&self,
		ordinal: u64,
	) -> impl Future<Output = Result<Option<ArtifactRecord>, Fault>> + Send + '_;
	/// Resolves a content digest visible across sessions.
	fn by_digest<'a>(
		&'a self,
		digest: &'a str,
	) -> impl Future<Output = Result<Option<ArtifactRecord>, Fault>> + Send + 'a;
}

/// Authoritative artifact-byte storage.
pub trait BlobAuthority: Send + Sync + 'static {
	/// Stats stored bytes. This value, never a peer's claimed size, determines
	/// the legal read range.
	fn stat<'a>(
		&'a self,
		digest: &'a str,
	) -> impl Future<Output = Result<BlobStat, Fault>> + Send + 'a;
	/// Reads one exact byte range from an immutable blob.
	fn read_range<'a>(
		&'a self,
		digest: &'a str,
		range: Range<u64>,
	) -> impl Future<Output = Result<CowBytes<'static>, Fault>> + Send + 'a;
}

#[derive(Debug)]
struct LineOffsets {
	starts: Box<[usize]>,
	len:    usize,
}

impl LineOffsets {
	fn scan(bytes: &[u8]) -> Self {
		let mut starts = Vec::with_capacity(bytecount::count(bytes, b'\n').saturating_add(1));
		starts.push(0);
		for (index, byte) in bytes.iter().copied().enumerate() {
			if byte == b'\n' {
				starts.push(index + 1);
			}
		}
		Self { starts: starts.into_boxed_slice(), len: bytes.len() }
	}

	fn line_count(&self, raw: bool) -> usize {
		if raw || self.len == 0 || self.starts.last().copied() != Some(self.len) {
			self.starts.len()
		} else {
			self.starts.len().saturating_sub(1)
		}
	}

	fn byte_range_mode(&self, range: LineRange, raw: bool) -> Result<Range<usize>, SelectorError> {
		let total_lines = self.line_count(raw);
		let start_line = usize::try_from(range.start_line).unwrap_or(usize::MAX);
		if start_line == 0 || start_line > total_lines {
			return Err(SelectorError::from_message(format!(
				"Line {} is out of bounds; resource has {total_lines} lines.",
				range.start_line
			)));
		}
		let end_line = range
			.end_line
			.map_or(total_lines, |end| usize::try_from(end).unwrap_or(usize::MAX))
			.min(total_lines);
		let start = self.starts[start_line - 1];
		let end = self.starts.get(end_line).copied().unwrap_or(self.len);
		Ok(start..end)
	}

	fn byte_range(&self, range: LineRange) -> Result<Range<usize>, SelectorError> {
		let start_line = usize::try_from(range.start_line).unwrap_or(usize::MAX);
		if start_line == 0 || start_line > self.starts.len() {
			return Err(SelectorError::from_message(format!(
				"Line {} is out of bounds; resource has {} lines.",
				range.start_line,
				self.starts.len()
			)));
		}
		let end_line = range
			.end_line
			.map_or(self.starts.len(), |end| usize::try_from(end).unwrap_or(usize::MAX))
			.min(self.starts.len());
		let start = self.starts[start_line - 1];
		let end = self.starts.get(end_line).copied().unwrap_or(self.len);
		Ok(start..end)
	}
}

/// Cached line-to-byte offsets for immutable resolver resources.
///
/// Cache entries retain offsets only. Returned slices share the resolver's
/// [`CowBytes`] backing allocation.
#[derive(Debug, Default)]
pub struct LineOffsetCache(DashMap<Str, Arc<LineOffsets>>);

impl LineOffsetCache {
	/// Returns cached offsets for `key`, if the resource has been scanned.
	fn get(&self, key: &str) -> Option<Arc<LineOffsets>> {
		self.0.get(key).map(|entry| Arc::clone(&entry))
	}

	/// Installs offsets produced by a bounded streaming scan.
	fn insert(&self, key: &str, offsets: LineOffsets) -> Arc<LineOffsets> {
		let offsets = Arc::new(offsets);
		self
			.0
			.entry(Str::new(key))
			.or_insert_with(|| offsets.clone())
			.clone()
	}

	/// Scans and caches an immutable resource once.
	fn index(&self, key: &str, bytes: &[u8]) -> Arc<LineOffsets> {
		if let Some(offsets) = self.get(key) {
			return offsets;
		}
		let offsets = Arc::new(LineOffsets::scan(bytes));
		self
			.0
			.entry(Str::new(key))
			.or_insert_with(|| offsets.clone())
			.clone()
	}

	/// Applies one line range without copying its backing blob.
	pub fn slice<'a>(
		&self,
		key: &str,
		bytes: &CowBytes<'a>,
		range: LineRange,
	) -> Result<CowBytes<'a>, SelectorError> {
		let offsets = self.index(key, bytes);
		Ok(bytes.slice(offsets.byte_range(range)?))
	}
}

/// Artifact resolver backed by a catalog and authoritative blob store.
#[derive(Debug)]
pub struct ArtifactResolver<C, B> {
	catalog: C,
	blobs:   B,
	lines:   LineOffsetCache,
}

impl<C, B> ArtifactResolver<C, B> {
	/// Constructs an artifact resolver with an empty line-offset cache.
	pub fn new(catalog: C, blobs: B) -> Self {
		Self { catalog, blobs, lines: LineOffsetCache::default() }
	}
}

impl<C: ArtifactCatalog, B: BlobAuthority> ArtifactResolver<C, B> {
	async fn record(&self, resource: &str) -> Result<ArtifactRecord, Fault> {
		let record = if resource.len() == 64 && resource.bytes().all(|byte| byte.is_ascii_hexdigit())
		{
			let record = self.catalog.by_digest(resource).await?;
			record.filter(|entry| entry.lifetime == ArtifactLifetime::Durable)
		} else {
			let ordinal = resource.parse::<u64>().map_err(|_| Fault::Invalid {
				message: sf!(
					"Invalid artifact address '{resource}'; use a session ordinal or 64-hex durable \
					 digest"
				),
			})?;
			self.catalog.by_ordinal(ordinal).await?
		};
		record.ok_or_else(|| Fault::source(format!("Artifact '{resource}' not found")))
	}

	async fn all_bytes(
		&self,
		record: &ArtifactRecord,
		size: u64,
	) -> Result<CowBytes<'static>, Fault> {
		self.blobs.read_range(&record.digest, 0..size).await
	}

	async fn offsets(&self, record: &ArtifactRecord, size: u64) -> Result<Arc<LineOffsets>, Fault> {
		if let Some(offsets) = self.lines.get(&record.digest) {
			return Ok(offsets);
		}
		let len = usize::try_from(size)
			.map_err(|_| Fault::Invalid { message: sf!("Artifact exceeds host address limits") })?;
		let mut starts = vec![0usize];
		let mut utf8_tail = Vec::new();
		let mut position = 0usize;
		while position < len {
			let chunk_len = if position == 0 {
				1
			} else {
				(64 * 1024).min(len - position)
			};
			let end = position.saturating_add(chunk_len);
			let bytes = self
				.blobs
				.read_range(
					&record.digest,
					u64::try_from(position).unwrap_or(u64::MAX)..u64::try_from(end).unwrap_or(u64::MAX),
				)
				.await?;
			if bytes.len() != chunk_len {
				return Err(Fault::Source {
					message: sf!("Artifact blob authority returned a short range read"),
				});
			}
			for (index, byte) in bytes.iter().copied().enumerate() {
				if byte == b'\n' {
					starts.push(position + index + 1);
				}
			}
			utf8_tail.extend_from_slice(&bytes);
			match str::from_utf8(&utf8_tail) {
				Ok(_) => utf8_tail.clear(),
				Err(error) if error.error_len().is_some() => {
					return Err(Fault::Invalid {
						message: sf!("Artifact selectors require UTF-8 text"),
					});
				},
				Err(error) => {
					utf8_tail = utf8_tail.split_off(error.valid_up_to());
				},
			}
			position = end;
		}
		if str::from_utf8(&utf8_tail).is_err() {
			return Err(Fault::Invalid { message: sf!("Artifact selectors require UTF-8 text") });
		}
		Ok(self
			.lines
			.insert(&record.digest, LineOffsets { starts: starts.into_boxed_slice(), len }))
	}

	async fn selected_bytes(
		&self,
		resource: &str,
		record: &ArtifactRecord,
		size: u64,
		ranges: &[LineRange],
		raw: bool,
	) -> Result<ResolvedRead, Fault> {
		let offsets = self.offsets(record, size).await?;
		let total_lines = offsets.line_count(raw);
		let mut spans = Vec::with_capacity(ranges.len());
		for range in ranges {
			let start = usize::try_from(range.start_line).unwrap_or(usize::MAX);
			if start == 0 || start > total_lines {
				continue;
			}
			let requested_end = range
				.end_line
				.map_or(total_lines, |end| usize::try_from(end).unwrap_or(usize::MAX))
				.min(total_lines);
			let (start_line, end_line) = if ranges.len() == 1 && !raw {
				(
					start.saturating_sub(1).max(1),
					if range.end_line.is_some() {
						requested_end.saturating_add(3).min(total_lines)
					} else {
						requested_end
					},
				)
			} else {
				(start, requested_end)
			};
			spans.push(LineSpan { start_line, end_line });
		}

		let selected_bytes = spans.iter().try_fold(0usize, |total, span| {
			let range = offsets
				.byte_range_mode(
					LineRange {
						start_line: u64::try_from(span.start_line).unwrap_or(u64::MAX),
						end_line:   Some(u64::try_from(span.end_line).unwrap_or(u64::MAX)),
					},
					raw,
				)
				.map_err(selector_fault)?;
			total
				.checked_add(range.len())
				.ok_or_else(|| Fault::Invalid { message: sf!("Artifact range byte length overflow") })
		})?;
		if selected_bytes > 8 * 1024 * 1024 {
			return Err(Fault::Invalid {
				message: sf!(
					"Selected artifact ranges total {selected_bytes} bytes; narrow the selection below \
					 the 8 MiB inline safety bound"
				),
			});
		}

		let mut loaded = Vec::with_capacity(spans.len());
		for span in &spans {
			let range = offsets
				.byte_range_mode(
					LineRange {
						start_line: u64::try_from(span.start_line).unwrap_or(u64::MAX),
						end_line:   Some(u64::try_from(span.end_line).unwrap_or(u64::MAX)),
					},
					raw,
				)
				.map_err(selector_fault)?;
			let bytes = self
				.blobs
				.read_range(&record.digest, usize_range_to_u64(range)?)
				.await?;
			str::from_utf8(&bytes).map_err(|_| Fault::Invalid {
				message: sf!("Artifact selectors require UTF-8 text"),
			})?;
			loaded.push(bytes);
		}
		let resolved = spans
			.iter()
			.zip(&loaded)
			.map(|(span, bytes)| ResolvedRangeText {
				span: *span,
				text: str::from_utf8(bytes).expect("validated above"),
			})
			.collect::<Vec<_>>();
		let label = format!("artifact://{resource}");
		let rendered = format::format_resolved_ranges(
			&resolved,
			ranges,
			raw,
			total_lines,
			TextFormatOptions::new(&label),
		);
		Ok(ResolvedRead { data: CowBytes::from(Bytes::from(rendered.text)), diags: rendered.diags })
	}

	async fn read_resolved(
		&self,
		resource: &str,
		selector: &ParsedSelector,
	) -> Result<ResolvedRead, Fault> {
		let record = self.record(resource).await?;
		let size = self.blobs.stat(&record.digest).await?.byte_len;
		match selector {
			ParsedSelector::Lines { ranges, raw } => {
				self
					.selected_bytes(resource, &record, size, ranges, *raw)
					.await
			},
			ParsedSelector::None | ParsedSelector::Raw if size > 8 * 1024 * 1024 => {
				Err(Fault::Invalid {
					message: sf!(
						"artifact://{resource} is too large for a raw inline read ({size} bytes); \
						 select a bounded line range"
					),
				})
			},
			ParsedSelector::None | ParsedSelector::Raw | ParsedSelector::Conflicts => self
				.all_bytes(&record, size)
				.await
				.map(|data| ResolvedRead { data, diags: smallvec![] }),
			ParsedSelector::Image => Err(Fault::Invalid {
				message: Str::new_static(
					"The ':img' selector only supports local .svg and .svgz files.",
				),
			}),
		}
	}
}

impl<C: ArtifactCatalog, B: BlobAuthority> Resolve for ArtifactResolver<C, B> {
	async fn read<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		self
			.read_resolved(resource, selector)
			.await
			.map(|resolved| resolved.data)
	}

	async fn read_with_diags<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<ResolvedRead, Fault> {
		self.read_resolved(resource, selector).await
	}

	async fn read_query_with_diags<'a>(
		&'a self,
		resource: &'a str,
		_query: Option<&'a str>,
		selector: &'a ParsedSelector,
	) -> Result<ResolvedRead, Fault> {
		self.read_resolved(resource, selector).await
	}
}

fn selector_fault(error: SelectorError) -> Fault {
	Fault::Invalid { message: Str::new(error.to_string()) }
}

fn usize_range_to_u64(range: Range<usize>) -> Result<Range<u64>, Fault> {
	let start = u64::try_from(range.start).map_err(|_| Fault::Invalid {
		message: sf!("Artifact line offset exceeds the blob protocol range"),
	})?;
	let end = u64::try_from(range.end).map_err(|_| Fault::Invalid {
		message: sf!("Artifact line offset exceeds the blob protocol range"),
	})?;
	Ok(start..end)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[derive(Debug)]
	struct TestResolver;

	impl Resolve for TestResolver {
		async fn read<'a>(
			&'a self,
			_resource: &'a str,
			_selector: &'a ParsedSelector,
		) -> Result<CowBytes<'static>, Fault> {
			Ok(CowBytes::from(&b"abcdef"[..]))
		}

		async fn complete(
			&self,
			_query: &str,
			_max_results: usize,
		) -> Result<Vec<ResourceCompletion>, Fault> {
			Ok(vec![
				ResourceCompletion {
					value:       "skill://beta".into(),
					description: "second".into(),
					score:       10,
				},
				ResourceCompletion {
					value:       "skill://alpha".into(),
					description: "first".into(),
					score:       10,
				},
			])
		}
	}

	#[tokio::test]
	async fn table_stamps_and_bounds_reads_and_completions() {
		let mut builder = ResolverTable::builder();
		builder
			.register(
				SchemeEntry::new(Scheme::Skill, true, false, "skills")
					.with_capabilities(false, false, true)
					.with_stamp(true, 7),
				TestResolver,
			)
			.unwrap();
		let table = builder.build();
		let snapshot = table.snapshot();
		assert_ne!(snapshot.device_hash, [0; 32]);
		assert_ne!(table.revision(), 0);
		let read = table
			.read_bounded(Scheme::Skill, "alpha", &ParsedSelector::None, 3, false)
			.await
			.unwrap()
			.unwrap();
		assert_eq!(&*read.data, b"abc");
		assert!(read.truncated);
		assert!(read.stamp.immutable);
		let (completed, truncated) = table.complete(Scheme::Skill, "", 1).await.unwrap().unwrap();
		assert_eq!(completed[0].value, "skill://alpha");
		assert!(truncated);
	}

	#[test]
	fn packaged_docs_are_sorted_and_lazily_readable() {
		let docs = DocsArchive::default();
		let names = docs.names().collect::<Vec<_>>();
		assert!(!names.is_empty());
		assert!(names.windows(2).all(|pair| pair[0] < pair[1]));
		let bytes = docs.read(names[0]).unwrap().unwrap();
		assert!(!bytes.is_empty());
		assert!(docs.read("../Cargo.toml").is_err());
	}
}
