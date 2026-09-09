//! Embedding request negotiation, batching, truncation, and vector validation.

use std::{
	future::{Future, poll_fn},
	num::NonZeroU32,
	sync::Arc,
	task::{Context, Poll},
};

use omp_core::{Str, sf};
use tower::Service;

use crate::{
	answer::{Answer, AnswerBody, EmbeddingBatch},
	call::{
		Call, EmbedRequest, EmbeddingInput, EmulationPolicy, MismatchPolicy, OperationCall, Setting,
		TruncationPolicy, UnknownCapabilityPolicy,
	},
	catalog::{
		Availability, DimensionRange, EmbeddingCapabilities, EmbeddingInputBits, Emulation,
		ModalityBits, OperationKind,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	operation::{OperationRequest, OperationResponse, merge_receipts},
	receipt::{Adjustment, ExecutionReceipt, FeatureId, ReasonId},
};

/// Native normalization behavior of a constructed embedding backend.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NormalizationSupport {
	/// The request can enable or disable normalization natively.
	Selectable,
	/// Every returned vector is normalized.
	Always,
	/// The backend always returns its original vector magnitude.
	Never,
}

/// Operation-layer facts that supplement catalog embedding capabilities.
#[derive(Clone, Debug)]
pub struct EmbeddingServiceConfig {
	/// Catalog-advertised embedding constraints.
	pub capabilities:           EmbeddingCapabilities,
	/// Backend normalization behavior.
	pub normalization:          NormalizationSupport,
	/// Maximum token identifiers accepted per pre-tokenized input.
	pub maximum_input_tokens:   Option<u32>,
	/// Whether the backend implements requested text truncation.
	pub native_text_truncation: bool,
}

/// Concrete embedding service over a route-local typed backend.
#[derive(Clone, Debug)]
pub struct EmbeddingService<S> {
	inner:         S,
	config:        EmbeddingServiceConfig,
	maximum_batch: NonZeroU32,
}

impl<S> EmbeddingService<S> {
	/// Constructs a batching service from advertised and executable backend
	/// facts.
	pub fn new(inner: S, config: EmbeddingServiceConfig) -> Result<Self, Error> {
		if !config
			.capabilities
			.input_modalities
			.contains(ModalityBits::TEXT)
			|| config.capabilities.input_kinds.bits() == 0
		{
			return Err(planning_error(
				"embedding.input_kind",
				"embedding_service_has_no_constructible_input",
			));
		}
		let maximum = config.capabilities.maximum_batch.unwrap_or(u32::MAX);
		let Some(maximum_batch) = NonZeroU32::new(maximum) else {
			return Err(planning_error("embedding.maximum_batch", "zero_batch_capacity"));
		};
		Ok(Self { inner, config, maximum_batch })
	}

	/// Validates all explicit options and returns a request split into backend
	/// pages.
	pub fn plan(&self, request: &EmbedRequest) -> Result<EmbeddingPlan, Error> {
		plan_embedding(request, &self.config, self.maximum_batch)
	}
}

/// Fully negotiated embedding pages and local post-processing obligations.
#[derive(Clone, Debug)]
pub struct EmbeddingPlan {
	/// Ordered non-empty backend pages.
	pub pages:             Vec<Arc<EmbedRequest>>,
	/// Whether the operation layer must unit-normalize provider vectors.
	pub normalize_locally: bool,
	/// Receipt evidence for negotiated native/emulated/dropped settings.
	pub adjustments:       Vec<Adjustment>,
}

impl<S> Service<Call> for EmbeddingService<S>
where
	S: Service<
			OperationRequest<EmbedRequest>,
			Response = OperationResponse<EmbeddingBatch>,
			Error = Error,
		> + Clone
		+ Send
		+ 'static,
	S::Future: Send + 'static,
{
	type Error = Error;
	type Response = Answer;

	type Future = impl Future<Output = Result<Answer, Error>> + Send;

	fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.inner.poll_ready(context)
	}

	fn call(&mut self, call: Call) -> Self::Future {
		let plan = match &call.operation {
			OperationCall::Embed(request) => self
				.plan(request)
				.map(|plan| (plan, OperationRequest::from_call(&call, Arc::clone(request)))),
			_ => Err(wrong_operation(&call)),
		};
		let mut later_backend = self.inner.clone();
		let first = plan.as_ref().ok().and_then(|(plan, template)| {
			plan.pages.first().map(|page| {
				self.inner.call(OperationRequest {
					id:             template.id.clone(),
					target:         template.target.clone(),
					deadline:       template.deadline,
					budget:         template.budget.clone(),
					session:        template.session.clone(),
					debug_session:  template.debug_session.clone(),
					affinity:       template.affinity.clone(),
					response_hooks: template.response_hooks.clone(),
					attribution:    template.attribution.clone(),
					execution:      template.execution.clone(),
					payload:        Arc::clone(page),
				})
			})
		});

		async move {
			let (plan, template) = plan?;
			let Some(first) = first else {
				return Err(request_error("embedding.inputs", "empty_embedding_batch"));
			};
			let mut aggregate = first.await?;
			let first_page_len = plan.pages[0].inputs.len();
			validate_embedding_batch(&aggregate.output, first_page_len)?;
			aggregate
				.output
				.embeddings
				.sort_by_key(|embedding| embedding.index);
			let mut next_index = first_page_len;

			for page in plan.pages.iter().skip(1) {
				poll_fn(|context| later_backend.poll_ready(context)).await?;
				let request = OperationRequest {
					id:             template.id.clone(),
					target:         template.target.clone(),
					deadline:       template.deadline,
					budget:         template.budget.clone(),
					session:        template.session.clone(),
					debug_session:  template.debug_session.clone(),
					affinity:       template.affinity.clone(),
					response_hooks: template.response_hooks.clone(),
					attribution:    template.attribution.clone(),
					execution:      template.execution.clone(),
					payload:        Arc::clone(page),
				};
				let mut later = match later_backend.call(request).await {
					Ok(later) => later,
					Err(mut error) => {
						let mut receipt = aggregate.receipt;
						merge_receipts(&mut receipt, error.take_receipt());
						error.replace_receipt(receipt);
						return Err(error);
					},
				};
				ensure_same_route(&aggregate, &later)?;
				validate_embedding_batch(&later.output, page.inputs.len())?;
				later
					.output
					.embeddings
					.sort_by_key(|embedding| embedding.index);
				if aggregate.output.dimensions != later.output.dimensions {
					return Err(protocol_error("embedding_page_dimensions_changed"));
				}
				for mut embedding in later.output.embeddings {
					embedding.index = embedding.index.saturating_add(next_index as u32);
					aggregate.output.embeddings.push(embedding);
				}
				aggregate.output.usage += later.output.usage;
				merge_receipts(&mut aggregate.receipt, later.receipt);
				next_index = next_index.saturating_add(page.inputs.len());
			}

			if plan.normalize_locally {
				for embedding in &mut aggregate.output.embeddings {
					normalize_vector(&mut embedding.values)?;
				}
			}
			validate_final(&aggregate.output, next_index, &template.payload.dimensions)?;
			aggregate.receipt.adjustments.extend(plan.adjustments);
			Ok(aggregate.into_answer(AnswerBody::Embeddings))
		}
	}
}

/// Negotiates explicit embedding options and creates non-empty ordered pages.
pub fn plan_embedding(
	request: &EmbedRequest,
	config: &EmbeddingServiceConfig,
	maximum_batch: NonZeroU32,
) -> Result<EmbeddingPlan, Error> {
	if request.inputs.is_empty() {
		return Err(request_error("embedding.inputs", "empty_embedding_batch"));
	}
	if request.inputs.len() > u32::MAX as usize {
		return Err(request_error("embedding.inputs", "embedding_batch_index_overflow"));
	}

	let mut adjustments = Vec::new();
	let dimensions = negotiate_dimensions(
		&request.dimensions,
		config.capabilities.dimensions.clone(),
		request,
		&mut adjustments,
	)?;
	let (normalization, normalize_locally) =
		negotiate_normalization(request, config.normalization, &mut adjustments)?;
	for input in request.inputs.iter() {
		let supported = match input {
			EmbeddingInput::Text(_) => config
				.capabilities
				.input_kinds
				.contains(EmbeddingInputBits::TEXT),
			EmbeddingInput::Tokens(_) => config
				.capabilities
				.input_kinds
				.contains(EmbeddingInputBits::TOKEN_IDS),
		};
		if !supported {
			return Err(planning_error(
				"embedding.input_kind",
				"embedding_input_representation_unsupported",
			));
		}
	}

	let mut inputs = Vec::with_capacity(request.inputs.len());
	for input in request.inputs.iter() {
		inputs.push(prepare_input(input, request.truncation, config)?);
	}

	let mut pages = Vec::with_capacity(inputs.len().div_ceil(maximum_batch.get() as usize));
	for chunk in inputs.chunks(maximum_batch.get() as usize) {
		pages.push(Arc::new(EmbedRequest {
			inputs:      Arc::from(chunk),
			dimensions:  dimensions.clone(),
			normalize:   normalization.clone(),
			truncation:  request.truncation,
			negotiation: request.negotiation.clone(),
		}));
	}
	Ok(EmbeddingPlan { pages, normalize_locally, adjustments })
}

fn negotiate_dimensions(
	setting: &Setting<u32>,
	availability: Availability<DimensionRange>,
	request: &EmbedRequest,
	adjustments: &mut Vec<Adjustment>,
) -> Result<Setting<u32>, Error> {
	let (value, required) = match setting {
		Setting::Unset => return Ok(Setting::Unset),
		Setting::Require(value) => (*value, true),
		Setting::Prefer(value) => (*value, false),
	};
	let supported = availability
		.constraints()
		.is_some_and(|range| value >= range.minimum && value <= range.maximum);
	if supported {
		adjustments.push(Adjustment::Native { feature: FeatureId(sf!("embedding.dimensions")) });
		return Ok(setting.clone());
	}
	if !required && request.negotiation.vendor_option_mismatch == MismatchPolicy::DropPreferred {
		adjustments.push(Adjustment::Dropped {
			feature: FeatureId(sf!("embedding.dimensions")),
			reason:  ReasonId(sf!("unsupported_preferred_dimensions")),
		});
		return Ok(Setting::Unset);
	}
	if matches!(availability, Availability::Unknown)
		&& !required
		&& request.negotiation.unknown == UnknownCapabilityPolicy::AllowPreferences
	{
		return Ok(setting.clone());
	}
	Err(planning_error("embedding.dimensions", "unsupported_embedding_dimensions"))
}

fn negotiate_normalization(
	request: &EmbedRequest,
	support: NormalizationSupport,
	adjustments: &mut Vec<Adjustment>,
) -> Result<(Setting<bool>, bool), Error> {
	let (wanted, preferred) = match request.normalize.clone() {
		Setting::Unset => return Ok((Setting::Unset, false)),
		Setting::Require(value) => (value, false),
		Setting::Prefer(value) => (value, true),
	};
	match (wanted, support) {
		(_, NormalizationSupport::Selectable)
		| (true, NormalizationSupport::Always)
		| (false, NormalizationSupport::Never) => {
			adjustments
				.push(Adjustment::Native { feature: FeatureId(sf!("embedding.normalization")) });
			Ok((request.normalize.clone(), false))
		},
		(true, NormalizationSupport::Never)
			if request.negotiation.emulation != EmulationPolicy::Forbid =>
		{
			adjustments.push(Adjustment::Emulated {
				feature: FeatureId(sf!("embedding.normalization")),
				method:  Emulation::ResponseTransform,
			});
			Ok((Setting::Unset, true))
		},
		_ if preferred
			&& request.negotiation.vendor_option_mismatch == MismatchPolicy::DropPreferred =>
		{
			adjustments.push(Adjustment::Dropped {
				feature: FeatureId(sf!("embedding.normalization")),
				reason:  ReasonId(sf!("unsupported_preferred_normalization")),
			});
			Ok((Setting::Unset, false))
		},
		_ => Err(planning_error("embedding.normalization", "unsupported_embedding_normalization")),
	}
}

fn prepare_input(
	input: &EmbeddingInput,
	truncation: TruncationPolicy,
	config: &EmbeddingServiceConfig,
) -> Result<EmbeddingInput, Error> {
	match (input, config.maximum_input_tokens) {
		(EmbeddingInput::Tokens(tokens), Some(limit)) if tokens.len() > limit as usize => {
			let limit = limit as usize;
			match truncation {
				TruncationPolicy::Reject => {
					Err(request_error("embedding.truncation", "embedding_input_exceeds_token_limit"))
				},
				TruncationPolicy::Start => {
					Ok(EmbeddingInput::Tokens(Arc::from(&tokens[tokens.len() - limit..])))
				},
				TruncationPolicy::End => Ok(EmbeddingInput::Tokens(Arc::from(&tokens[..limit]))),
			}
		},
		(EmbeddingInput::Text(_), Some(_))
			if truncation != TruncationPolicy::Reject && !config.native_text_truncation =>
		{
			Err(planning_error("embedding.truncation", "text_truncation_requires_backend_tokenizer"))
		},
		_ => Ok(input.clone()),
	}
}

pub(crate) fn validate_embedding_batch(
	batch: &EmbeddingBatch,
	input_count: usize,
) -> Result<(), Error> {
	if batch.dimensions == 0 || batch.embeddings.len() != input_count {
		return Err(protocol_error("embedding_page_shape_mismatch"));
	}
	let mut seen = vec![false; input_count];
	for embedding in &batch.embeddings {
		let index = embedding.index as usize;
		if index >= input_count || seen[index] || embedding.values.len() != batch.dimensions as usize
		{
			return Err(protocol_error("embedding_page_index_or_dimension_mismatch"));
		}
		if embedding.values.iter().any(|value| !value.is_finite()) {
			return Err(protocol_error("embedding_vector_non_finite"));
		}
		seen[index] = true;
	}
	Ok(())
}

fn validate_final(
	batch: &EmbeddingBatch,
	input_count: usize,
	dimensions: &Setting<u32>,
) -> Result<(), Error> {
	if batch.embeddings.len() != input_count {
		return Err(protocol_error("embedding_batch_count_mismatch"));
	}
	if let Setting::Require(required) = dimensions
		&& batch.dimensions != *required
	{
		return Err(protocol_error("required_embedding_dimensions_not_returned"));
	}
	Ok(())
}

fn ensure_same_route(
	first: &OperationResponse<EmbeddingBatch>,
	later: &OperationResponse<EmbeddingBatch>,
) -> Result<(), Error> {
	if first.meta.provider != later.meta.provider
		|| first.meta.route != later.meta.route
		|| first.meta.model != later.meta.model
	{
		return Err(protocol_error("embedding_batch_route_changed"));
	}
	Ok(())
}

pub(crate) fn normalize_vector(values: &mut [f32]) -> Result<(), Error> {
	let mut squared = 0.0_f64;
	for value in values.iter() {
		if !value.is_finite() {
			return Err(protocol_error("embedding_vector_non_finite"));
		}
		squared = f64::mul_add(f64::from(*value), f64::from(*value), squared);
	}
	let magnitude = squared.sqrt();
	if !magnitude.is_finite() || magnitude == 0.0 {
		return Err(protocol_error("embedding_vector_not_normalizable"));
	}
	for value in values {
		*value = (*value as f64 / magnitude) as f32;
	}
	Ok(())
}

fn wrong_operation(call: &Call) -> Error {
	Error::new(
		ErrorKind::InternalInvariant,
		ErrorPhase::Internal,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::capability(
		Str::new(OperationKind::Embed.to_string()),
		ReasonId(sf!("operation_service_mismatch")),
	))
	.request_id(call.id.clone())
}

fn request_error(feature: &'static str, reason: &'static str) -> Error {
	Error::planning(
		ErrorKind::InvalidRequest,
		ErrorDetail::capability(Str::new(feature), ReasonId(Str::new(reason))),
		ExecutionReceipt::default(),
	)
}

fn planning_error(feature: &'static str, reason: &'static str) -> Error {
	Error::planning(
		ErrorKind::CapabilityMismatch,
		ErrorDetail::capability(Str::new(feature), ReasonId(Str::new(reason))),
		ExecutionReceipt::default(),
	)
}

fn protocol_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Recovery,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

#[cfg(test)]
mod tests {
	use std::{num::NonZeroU32, sync::Arc};

	use super::{EmbeddingServiceConfig, NormalizationSupport, normalize_vector, plan_embedding};
	use crate::{
		call::{
			EmbedRequest, EmbeddingInput, EmulationPolicy, NegotiationPolicy, Setting,
			TruncationPolicy,
		},
		catalog::{
			Availability, DimensionRange, EmbeddingCapabilities, EmbeddingFormatBits,
			EmbeddingInputBits, ModalityBits,
		},
	};

	#[test]
	fn planning_batches_truncates_tokens_and_records_local_normalization() {
		let request = EmbedRequest {
			inputs:      Arc::new([
				EmbeddingInput::Tokens(Arc::new([1, 2, 3])),
				EmbeddingInput::Tokens(Arc::new([4, 5])),
				EmbeddingInput::Tokens(Arc::new([6])),
			]),
			dimensions:  Setting::Require(2),
			normalize:   Setting::Require(true),
			truncation:  TruncationPolicy::End,
			negotiation: NegotiationPolicy {
				emulation: EmulationPolicy::AllowLossless,
				..NegotiationPolicy::default()
			},
		};
		let plan = plan_embedding(
			&request,
			&EmbeddingServiceConfig {
				capabilities:           EmbeddingCapabilities {
					input_modalities: ModalityBits::TEXT,
					input_kinds:      EmbeddingInputBits::TOKEN_IDS,
					formats:          EmbeddingFormatBits::FLOAT,
					maximum_batch:    Some(2),
					dimensions:       Availability::Native(DimensionRange { minimum: 1, maximum: 4 }),
				},
				normalization:          NormalizationSupport::Never,
				maximum_input_tokens:   Some(2),
				native_text_truncation: false,
			},
			NonZeroU32::new(2).expect("non-zero"),
		)
		.expect("plan");
		assert_eq!(
			plan
				.pages
				.iter()
				.map(|page| page.inputs.len())
				.collect::<Vec<_>>(),
			[2, 1]
		);
		let EmbeddingInput::Tokens(tokens) = &plan.pages[0].inputs[0] else {
			panic!("token input");
		};
		assert_eq!(tokens.as_ref(), &[1, 2]);
		assert!(plan.normalize_locally);
	}

	#[test]
	fn local_normalization_rejects_zero_and_normalizes_finite_vectors() {
		assert!(normalize_vector(&mut [0.0, 0.0]).is_err());
		let mut values = [3.0, 4.0];
		normalize_vector(&mut values).expect("normalizable");
		assert!((values[0] - 0.6).abs() < f32::EPSILON * 2.0);
		assert!((values[1] - 0.8).abs() < f32::EPSILON * 2.0);
	}
}
