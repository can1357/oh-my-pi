//! Bounded read-only `memory://` projections for the active session.

use std::sync;

use omp_core::{CowBytes, Str};
use omp_memory::{runtime::MemoryProjection, store::MemoryTier};
use omp_tools::read::{
	Fault,
	resolver::{
		LineOffsetCache, Resolve, ResourceCompletion, ResourceEntry, ResourceList, fuzzy_score,
	},
	selector::ParsedSelector,
};
use serde::Serialize;

use super::select_bytes;

const MAX_RECORDS: usize = 100;
const MAX_BYTES: usize = 1024 * 1024;

pub(crate) struct MemoryUrlResolver {
	runtime: sync::Arc<omp_memory::MemoryRuntime>,
	lines:   LineOffsetCache,
}

impl MemoryUrlResolver {
	pub(super) fn new(runtime: sync::Arc<omp_memory::MemoryRuntime>) -> Self {
		Self { runtime, lines: LineOffsetCache::default() }
	}

	fn runtime(&self) -> Result<&omp_memory::MemoryRuntime, Fault> {
		self
			.runtime
			.capabilities()
			.resolvable
			.then_some(self.runtime.as_ref())
			.ok_or(Fault::Source {
				message: Str::new_static("Mnemopi memory is not active for this session."),
			})
	}
}

impl Resolve for MemoryUrlResolver {
	async fn read<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		let runtime = self.runtime()?;
		let projection = runtime
			.projection(resource, MAX_RECORDS, MAX_BYTES)
			.map_err(memory_fault)?;
		let bytes = render_projection(projection)?;
		select_bytes(&self.lines, resource, CowBytes::from(bytes), selector)
	}

	async fn list(
		&self,
		resource: &str,
		max_entries: usize,
		max_bytes: usize,
	) -> Result<ResourceList, Fault> {
		let runtime = self.runtime()?;
		let resource = resource.trim_matches('/');
		let projection = runtime
			.projection(
				if resource.is_empty() {
					"root"
				} else {
					resource
				},
				max_entries.min(MAX_RECORDS),
				max_bytes.min(MAX_BYTES),
			)
			.map_err(memory_fault)?;
		let mut entries = Vec::new();
		let mut bytes = 0usize;
		let mut truncated = false;
		match projection {
			MemoryProjection::Root { status } => {
				for bank in status.recall_banks {
					let uri = Str::new(format!("memory://root/{bank}"));
					let entry_bytes = uri.len().saturating_add(bank.as_str().len());
					if entries.len() == max_entries || bytes.saturating_add(entry_bytes) > max_bytes {
						truncated = true;
						break;
					}
					bytes += entry_bytes;
					entries.push(ResourceEntry {
						uri,
						name: Str::new(bank.as_str()),
						directory: true,
						size: 0,
					});
				}
			},
			MemoryProjection::Bank { records, truncated: projection_truncated, .. } => {
				truncated |= projection_truncated;
				for record in records {
					let uri = Str::new(format!("memory://{}", record.id));
					let entry_bytes = uri.len().saturating_add(record.content.len());
					if entries.len() == max_entries || bytes.saturating_add(entry_bytes) > max_bytes {
						truncated = true;
						break;
					}
					bytes += entry_bytes;
					entries.push(ResourceEntry {
						uri,
						name: record.id,
						directory: false,
						size: record.content.len() as u64,
					});
				}
			},
			MemoryProjection::Record { .. } => {
				return Err(Fault::Invalid {
					message: Str::new_static("A memory record cannot be listed as a directory."),
				});
			},
		}
		Ok(ResourceList { entries, truncated })
	}

	async fn complete(
		&self,
		query: &str,
		max_results: usize,
	) -> Result<Vec<ResourceCompletion>, Fault> {
		let runtime = self.runtime()?;
		let MemoryProjection::Root { status } = runtime
			.projection("root", MAX_RECORDS, MAX_BYTES)
			.map_err(memory_fault)?
		else {
			return Ok(Vec::new());
		};
		let mut completions = status
			.recall_banks
			.into_iter()
			.filter_map(|bank| {
				let value = Str::new(format!("memory://root/{bank}"));
				let score = fuzzy_score(query, value.as_str())?;
				Some(ResourceCompletion { value, description: Str::new("Mnemopi bank"), score })
			})
			.collect::<Vec<_>>();
		completions.sort_unstable_by(|left, right| {
			right
				.score
				.cmp(&left.score)
				.then_with(|| left.value.cmp(&right.value))
		});
		completions.truncate(max_results.min(MAX_RECORDS));
		Ok(completions)
	}
}

#[derive(Serialize)]
struct RecordFrontmatter<'a> {
	id:         &'a str,
	bank:       &'a str,
	store:      MemoryTier,
	immutable:  bool,
	source:     Option<&'a str>,
	timestamp:  &'a str,
	importance: f64,
	guidance:   &'static str,
}

fn render_projection(projection: MemoryProjection) -> Result<Vec<u8>, Fault> {
	match projection {
		MemoryProjection::Root { status } => serde_yaml::to_string(&status)
			.map(String::into_bytes)
			.map_err(yaml_fault),
		MemoryProjection::Bank { bank, records, .. } => {
			let mut rendered = String::new();
			for record in records {
				rendered.push_str("- id: ");
				rendered.push_str(record.id.as_str());
				rendered.push_str("\n  bank: ");
				rendered.push_str(bank.as_str());
				rendered.push_str("\n  content: ");
				rendered.push_str(record.content.lines().next().unwrap_or_default());
				rendered.push('\n');
			}
			Ok(rendered.into_bytes())
		},
		MemoryProjection::Record { record, immutable } => {
			let header = RecordFrontmatter {
				id: record.id.as_str(),
				bank: record.bank.as_str(),
				store: record.tier,
				immutable,
				source: record.source.as_deref(),
				timestamp: record.timestamp.as_str(),
				importance: record.importance,
				guidance: if immutable {
					"Extracted facts are immutable; retain a corrected fact instead of editing this \
					 projection."
				} else {
					"Use memory_edit for scoped mutation; this URL is read-only."
				},
			};
			let yaml = serde_yaml::to_string(&header).map_err(yaml_fault)?;
			let mut rendered = String::with_capacity(yaml.len() + record.content.len() + 10);
			rendered.push_str("---\n");
			rendered.push_str(&yaml);
			rendered.push_str("---\n");
			rendered.push_str(record.content.as_str());
			Ok(rendered.into_bytes())
		},
	}
}

fn memory_fault(error: omp_memory::Error) -> Fault {
	match error {
		omp_memory::Error::InvalidIdentifier => Fault::Invalid {
			message: Str::new_static(
				"Memory resource was not found or was outside the active scoped banks.",
			),
		},
		omp_memory::Error::ProjectionTooLarge | omp_memory::Error::InputTooLarge => Fault::Invalid {
			message: Str::new_static("Memory projection exceeded its bounded output limit."),
		},
		_ => Fault::Source { message: Str::new_static("Memory projection could not be read.") },
	}
}

fn yaml_fault(_error: serde_yaml::Error) -> Fault {
	Fault::Source { message: Str::new_static("Memory projection could not be encoded.") }
}
