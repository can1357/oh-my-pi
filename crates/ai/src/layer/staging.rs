//! Secure request-body staging before retryable route execution.

use std::{
	future::poll_fn,
	mem,
	sync::Arc,
	task::{Context, Poll},
};

use tower::Service;

use crate::{
	body::{NativeBodySource, NativeStreamDeclaration, Replayability},
	call::{ContentPart, MediaInput, NativePayload, OperationCall, ToolResultContent},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	layer::{ExecutionContext, LayerCall},
	plan::ReplayPlan,
	receipt::ReasonId,
	staging::{StagingPolicy, stage_body},
};

/// Stages explicitly authorized one-shot inputs before any route attempt.
#[derive(Clone, Copy, Debug, Default)]
pub struct StagingLayer;

/// Service implementing the secure staging preflight.
#[derive(Clone, Debug)]
pub struct StagingService<S> {
	inner: S,
}

impl<S> tower::Layer<S> for StagingLayer {
	type Service = StagingService<S>;

	fn layer(&self, inner: S) -> Self::Service {
		StagingService { inner }
	}
}

impl<S> Service<LayerCall<crate::call::Call>> for StagingService<S>
where
	S: Service<LayerCall<crate::call::Call>, Error = Error> + Clone,
{
	type Error = Error;
	type Response = S::Response;

	type Future = impl Future<Output = Result<Self::Response, Self::Error>>;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.inner.poll_ready(cx)
	}

	fn call(&mut self, mut request: LayerCall<crate::call::Call>) -> Self::Future {
		let replacement = self.inner.clone();
		let mut service = mem::replace(&mut self.inner, replacement);
		async move {
			stage_call(&mut request.payload, &request.context).await?;
			poll_fn(|cx| service.poll_ready(cx)).await?;
			service.call(request).await
		}
	}
}

async fn stage_call(call: &mut crate::call::Call, context: &ExecutionContext) -> Result<(), Error> {
	let replay = call.execution.as_ref().map(|plan| plan.replay);
	let Some(ReplayPlan::SecureStaging { maximum_bytes }) = replay else {
		call.staging = None;
		return Ok(());
	};
	let staging = call
		.staging
		.take()
		.ok_or_else(|| invariant(context, "staging-policy-missing"))?;
	if staging.policy.max_bytes() < maximum_bytes {
		return Err(invariant(context, "staging-policy-weaker-than-plan"));
	}
	let mut receipt = context.receipt();
	let original_staging_records = receipt.staging.len();
	let result = stage_operation(
		&mut call.operation,
		&staging.policy,
		&call.budget,
		&staging.cancellation,
		&mut receipt,
	)
	.await;
	let new_records = receipt.staging[original_staging_records..].to_vec();
	context.with_receipt(|target| target.staging.extend(new_records));
	match result {
		Ok(0) => Err(invariant(context, "secure-staging-plan-had-no-one-shot-body")),
		Ok(_) => Ok(()),
		Err(mut error) => {
			error.replace_receipt(context.receipt());
			Err(error)
		},
	}
}

async fn stage_operation(
	operation: &mut OperationCall,
	policy: &StagingPolicy,
	budget: &crate::receipt::ExecutionBudget,
	cancellation: &crate::staging::StagingCancellation,
	receipt: &mut crate::receipt::ExecutionReceipt,
) -> Result<usize, Error> {
	let mut staged = 0;
	match operation {
		OperationCall::Chat(request) => {
			let request = Arc::make_mut(request);
			for message in Arc::make_mut(&mut request.messages) {
				for content in Arc::make_mut(&mut message.content) {
					match content {
						ContentPart::Image(media)
						| ContentPart::Audio(media)
						| ContentPart::Document(media) => {
							staged += stage_media(media, policy, budget, cancellation, receipt).await?;
						},
						ContentPart::ToolResult { content, .. } => {
							for value in Arc::make_mut(content) {
								if let ToolResultContent::Image(media)
								| ToolResultContent::Document(media) = value
								{
									staged +=
										stage_media(media, policy, budget, cancellation, receipt).await?;
								}
							}
						},
						_ => {},
					}
				}
			}
		},
		OperationCall::GenerateImage(request) => {
			let request = Arc::make_mut(request);
			for media in Arc::make_mut(&mut request.references) {
				staged += stage_media(media, policy, budget, cancellation, receipt).await?;
			}
			if let Some(media) = &mut request.mask {
				staged += stage_media(media, policy, budget, cancellation, receipt).await?;
			}
		},
		OperationCall::GenerateVideo(request) => {
			if let Some(media) = &mut Arc::make_mut(request).reference {
				staged += stage_media(media, policy, budget, cancellation, receipt).await?;
			}
		},
		OperationCall::Transcribe(request) => {
			staged +=
				stage_media(&mut Arc::make_mut(request).audio, policy, budget, cancellation, receipt)
					.await?;
		},
		OperationCall::Native(request) => {
			let request = Arc::make_mut(request);
			if let Some(NativePayload::Body(body)) = &mut request.payload
				&& body.source().replayability() == Replayability::OneShot
			{
				let staged_body =
					stage_body(body.source(), policy, budget, cancellation, receipt).await?;
				*body = NativeBodySource::new(
					staged_body.into_body_source(),
					NativeStreamDeclaration::Replayable,
				)
				.map_err(|_| invariant_from_receipt(receipt, "staged-native-body-invalid"))?;
				staged += 1;
			}
		},
		_ => {},
	}
	Ok(staged)
}

async fn stage_media(
	media: &mut MediaInput,
	policy: &StagingPolicy,
	budget: &crate::receipt::ExecutionBudget,
	cancellation: &crate::staging::StagingCancellation,
	receipt: &mut crate::receipt::ExecutionReceipt,
) -> Result<usize, Error> {
	let MediaInput::Body { body, .. } = media else {
		return Ok(0);
	};
	if body.replayability() != Replayability::OneShot {
		return Ok(0);
	}
	let staged = stage_body(body, policy, budget, cancellation, receipt).await?;
	*body = staged.into_body_source();
	Ok(1)
}

fn invariant(context: &ExecutionContext, reason: &'static str) -> Error {
	invariant_from_receipt(&context.receipt(), reason)
}

fn invariant_from_receipt(
	receipt: &crate::receipt::ExecutionReceipt,
	reason: &'static str,
) -> Error {
	Error::new(
		ErrorKind::InternalInvariant,
		ErrorPhase::Artifact,
		RetryAction::Never,
		receipt.clone(),
	)
	.detail(ErrorDetail::protocol(ReasonId::new_static(reason)))
}
#[cfg(test)]
mod tests {
	use bytes::Bytes;
	use futures::stream;
	use omp_core::Str;

	use super::stage_media;
	use crate::{
		body::{BodySource, Replayability},
		call::MediaInput,
		receipt::{ExecutionBudget, ExecutionReceipt},
		staging::{StagingCancellation, StagingPolicy},
	};

	#[tokio::test]
	async fn one_shot_media_becomes_staged_before_attempts() {
		let source = BodySource::from_stream(Box::pin(stream::iter([Ok::<_, crate::Error>(
			Bytes::from_static(b"attachment"),
		)])));
		let mut media = MediaInput::Body {
			media_type: Str::new_static("application/octet-stream"),
			body:       source,
			name:       None,
		};
		let mut receipt = ExecutionReceipt::default();
		let staged = stage_media(
			&mut media,
			&StagingPolicy::memory_only(64, 64),
			&ExecutionBudget { max_staging_bytes: 64, ..ExecutionBudget::default() },
			&StagingCancellation::new(),
			&mut receipt,
		)
		.await
		.unwrap();
		assert_eq!(staged, 1);
		assert!(matches!(
			media,
			MediaInput::Body { ref body, .. }
				if body.replayability() == Replayability::Staged
		));
		assert_eq!(receipt.staging.len(), 1);
	}
}
