//! Bounded auxiliary-lane extraction and immutable fact persistence.

use omp_core::{Hash32, Str};

use crate::{
	Error, Result,
	store::{BankStore, NewFact},
};

/// Maximum transcript bytes sent to auxiliary inference.
pub const MAX_EXTRACTION_INPUT_BYTES: usize = 256 * 1024;
/// Maximum completion bytes parsed from auxiliary inference.
pub const MAX_EXTRACTION_OUTPUT_BYTES: usize = 256 * 1024;
/// Maximum jobs returned by one durable-queue read.
pub const MAX_EXTRACTION_BATCH_JOBS: usize = 16;
/// Maximum aggregate input bytes returned by one durable-queue read.
pub const MAX_EXTRACTION_BATCH_BYTES: usize = 1024 * 1024;

/// One memory-extraction completion request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtractionRequest {
	/// User-authored framed transcript only.
	pub input:      Str,
	/// Authoring session.
	pub session_id: Str,
	/// Durable source memory id.
	pub source_id:  Str,
}

/// App-owned auxiliary completion boundary.
pub trait ExtractionLane: Send + Sync {
	/// Completes one bounded extraction job. The lane resolves
	/// none/smol/remote/local-memory-model.
	fn complete(&self, request: &ExtractionRequest) -> impl Future<Output = Result<Str>> + Send;
}

/// Extracted immutable fact.
#[derive(Clone, Debug, PartialEq)]
pub struct ExtractedFact {
	/// Stable content-derived id.
	pub id:         Str,
	/// Subject.
	pub subject:    Str,
	/// Predicate.
	pub predicate:  Str,
	/// Object.
	pub object:     Str,
	/// Confidence in `[0, 1]`.
	pub confidence: f64,
}

/// Extraction persistence receipt.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ExtractionReport {
	/// Valid lines parsed.
	pub parsed:   usize,
	/// New immutable facts inserted.
	pub inserted: usize,
	/// Malformed or unsafe lines ignored.
	pub rejected: usize,
}

/// Runs one bounded completion, parses the line protocol, and persists
/// immutable facts.
pub async fn extract_and_store<L: ExtractionLane>(
	lane: &L,
	store: &BankStore,
	request: ExtractionRequest,
) -> Result<ExtractionReport> {
	if request.input.is_empty() || request.input.len() > MAX_EXTRACTION_INPUT_BYTES {
		return Err(Error::InputTooLarge);
	}
	let completion = lane.complete(&request).await?;
	if completion.len() > MAX_EXTRACTION_OUTPUT_BYTES {
		return Err(Error::InputTooLarge);
	}
	let (facts, rejected) = parse_facts(completion.as_str(), request.source_id.as_str());
	let borrowed = facts
		.iter()
		.map(|fact| NewFact {
			fact_id:          fact.id.as_str(),
			session_id:       request.session_id.as_str(),
			subject:          fact.subject.as_str(),
			predicate:        fact.predicate.as_str(),
			object:           fact.object.as_str(),
			timestamp:        None,
			source_memory_id: request.source_id.as_str(),
			confidence:       fact.confidence,
		})
		.collect::<Vec<_>>();
	let inserted = store.complete_extraction(request.source_id.as_str(), &borrowed)?;
	Ok(ExtractionReport { parsed: facts.len(), inserted, rejected })
}

/// Parses the compact extraction line format:
/// `FACT<TAB>subject<TAB>predicate<TAB>object<TAB>confidence`.
pub fn parse_facts(output: &str, source_id: &str) -> (Vec<ExtractedFact>, usize) {
	let mut facts = Vec::new();
	let mut rejected = 0usize;
	for (line_number, line) in output.lines().enumerate() {
		let line = line.trim();
		if line.is_empty() || line.starts_with('#') {
			continue;
		}
		let fields = line.split('\t').collect::<Vec<_>>();
		if fields.len() != 5 || fields[0] != "FACT" {
			rejected += 1;
			continue;
		}
		let subject = fields[1].trim();
		let predicate = fields[2].trim();
		let object = fields[3].trim();
		let confidence = fields[4].parse::<f64>().ok();
		if subject.is_empty()
			|| predicate.is_empty()
			|| object.is_empty()
			|| subject.len() > 512
			|| predicate.len() > 256
			|| object.len() > 4096
			|| confidence.is_none_or(|value| !value.is_finite())
		{
			rejected += 1;
			continue;
		}
		let material = format!("{source_id}\0{line_number}\0{subject}\0{predicate}\0{object}");
		let digest = Hash32::sum(material.as_bytes());
		facts.push(ExtractedFact {
			id:         Str::new(format!("fact_{}", &digest.to_hex().as_str()[..24])),
			subject:    Str::new(subject),
			predicate:  Str::new(predicate),
			object:     Str::new(object),
			confidence: confidence.unwrap_or(0.0).clamp(0.0, 1.0),
		});
	}
	(facts, rejected)
}
