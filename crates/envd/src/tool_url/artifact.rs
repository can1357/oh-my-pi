//! Content-addressed artifact resolver backed directly by the journal blob CAS.

use std::{fmt, fs, io, ops::Range};

use omp_core::{CowBytes, Str};
use omp_journal::blob::{BlobRef, BlobStore};
use omp_tool::ArtifactLifetime;
use omp_tools::read::{
	Fault,
	resolver::{
		ArtifactCatalog, ArtifactRecord, ArtifactResolver, BlobAuthority, BlobStat, Resolve,
		ResourceCompletion, ResourceList,
	},
	selector::ParsedSelector,
};
use url::Url;

const MAX_INLINE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug)]
struct BlobStoreAuthority {
	store: BlobStore,
}

impl BlobStoreAuthority {
	fn reference(&self, digest: &str) -> Result<BlobRef, Fault> {
		let probe = BlobRef::parse_hex(digest, 0).map_err(storage_fault)?;
		let size = fs::metadata(self.store.path(&probe))
			.map_err(io_fault)?
			.len();
		BlobRef::parse_hex(digest, size).map_err(storage_fault)
	}
}

#[derive(Clone, Debug)]
struct DigestCatalog {
	blobs: BlobStoreAuthority,
}

impl ArtifactCatalog for DigestCatalog {
	async fn by_ordinal(&self, _ordinal: u64) -> Result<Option<ArtifactRecord>, Fault> {
		Ok(None)
	}

	async fn by_digest<'a>(&'a self, digest: &'a str) -> Result<Option<ArtifactRecord>, Fault> {
		match self.blobs.reference(digest) {
			Ok(_) => Ok(Some(ArtifactRecord {
				digest:   Str::new(digest),
				lifetime: ArtifactLifetime::Durable,
			})),
			Err(Fault::Source { .. }) => Ok(None),
			Err(error) => Err(error),
		}
	}
}

impl BlobAuthority for BlobStoreAuthority {
	async fn stat<'a>(&'a self, digest: &'a str) -> Result<BlobStat, Fault> {
		Ok(BlobStat { byte_len: self.reference(digest)?.size })
	}

	async fn read_range<'a>(
		&'a self,
		digest: &'a str,
		range: Range<u64>,
	) -> Result<CowBytes<'static>, Fault> {
		let reference = self.reference(digest)?;
		let bytes = self.store.get(&reference).map_err(storage_fault)?;
		let start = usize::try_from(range.start).map_err(|_| Fault::Invalid {
			message: Str::new_static("Artifact range exceeds host address limits."),
		})?;
		let end = usize::try_from(range.end).map_err(|_| Fault::Invalid {
			message: Str::new_static("Artifact range exceeds host address limits."),
		})?;
		if start > end || end > bytes.len() {
			return Err(Fault::Invalid {
				message: Str::new_static("Artifact range exceeds stored content."),
			});
		}
		Ok(CowBytes::from(bytes.slice(start..end)))
	}
}

/// Production artifact resolver for durable `artifact://sha256/<digest>` data.
pub(crate) struct ArtifactUrlResolver {
	inner: ArtifactResolver<DigestCatalog, BlobStoreAuthority>,
	blobs: BlobStoreAuthority,
}

impl ArtifactUrlResolver {
	pub(super) fn open(store: BlobStore, _session: &str) -> Result<Self, io::Error> {
		let blobs = BlobStoreAuthority { store };
		let catalog = DigestCatalog { blobs: blobs.clone() };
		Ok(Self { inner: ArtifactResolver::new(catalog, blobs.clone()), blobs })
	}

	fn digest<'a>(&self, resource: &'a str) -> Result<&'a str, Fault> {
		let digest = resource.strip_prefix("sha256/").unwrap_or(resource);
		if digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
			Ok(digest)
		} else {
			Err(Fault::Invalid {
				message: Str::new_static(
					"Artifact addresses must be artifact://sha256/<64-hex-digest>.",
				),
			})
		}
	}
}

impl Resolve for ArtifactUrlResolver {
	async fn read<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		let digest = self.digest(resource)?;
		let reference = self.blobs.reference(digest)?;
		if reference.size > MAX_INLINE_BYTES
			&& matches!(selector, ParsedSelector::None | ParsedSelector::Raw)
		{
			return Err(Fault::Invalid {
				message: Str::new(format!(
					"Artifact {digest} is {} bytes; use a line selector or path-only mode.",
					reference.size
				)),
			});
		}
		self.inner.read(digest, selector).await
	}

	async fn list(
		&self,
		resource: &str,
		_max_entries: usize,
		_max_bytes: usize,
	) -> Result<ResourceList, Fault> {
		if resource.trim_matches('/').is_empty() {
			Ok(ResourceList { entries: Vec::new(), truncated: false })
		} else {
			Err(Fault::Invalid {
				message: Str::new_static(
					"Content-addressed artifacts do not expose a directory listing.",
				),
			})
		}
	}

	async fn path(&self, resource: &str) -> Result<Option<Str>, Fault> {
		let reference = self.blobs.reference(self.digest(resource)?)?;
		let url =
			Url::from_file_path(self.blobs.store.path(&reference)).map_err(|()| Fault::Invalid {
				message: Str::new_static("Artifact path cannot be represented as a file URI."),
			})?;
		Ok(Some(Str::new(url.as_str())))
	}

	async fn complete(
		&self,
		_query: &str,
		_max_results: usize,
	) -> Result<Vec<ResourceCompletion>, Fault> {
		Ok(Vec::new())
	}
}

impl fmt::Debug for ArtifactUrlResolver {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("ArtifactUrlResolver(..)")
	}
}

fn storage_fault(error: impl fmt::Display) -> Fault {
	Fault::Source { message: Str::new(format!("Artifact storage failed: {error}")) }
}

fn io_fault(source: io::Error) -> Fault {
	Fault::Source { message: Str::new(format!("Artifact storage I/O failed: {source}")) }
}
