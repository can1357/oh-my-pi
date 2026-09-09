//! Production admission adapter from authenticated guest prompts to the Core
//! mailbox.

use bytes::Bytes;
use omp_agent::{Interrupt, InterruptClass, MailboxSender, remote_principal_interrupt};
use omp_collab::host::{AuthorizedMutation, RemoteOperation};
use omp_core::Hash32;
use omp_proto::{
	inference::v1::{Value, ValueMap, value},
	thread::v1::{Blob, Item, Message, Part, Role, item, part},
};
use thiserror::Error;

const COLLAB_PROMPT_TYPE_PROP: &str = "omp/collab/custom-type";
const COLLAB_PROMPT_TYPE: &str = "collab-prompt";

/// Routes one host-admitted remote prompt through the agent's sole Core
/// mailbox.
///
/// Images remain canonical blob parts with content hashes. Effects caused by
/// the resulting turn use the same Environment grants and durable approval
/// route as a local prompt; this adapter never invokes a tool or environment
/// operation directly.
pub fn enqueue_prompt(
	mailbox: &MailboxSender,
	class: InterruptClass,
	mutation: AuthorizedMutation,
) -> Result<(), RemoteAdmissionError> {
	let RemoteOperation::Prompt(prompt) = mutation.operation else {
		return Err(RemoteAdmissionError::NotPrompt);
	};
	let mut parts = Vec::with_capacity(1 + prompt.images.len());
	parts.push(Part { kind: Some(part::Kind::Text(prompt.text)) });
	for image in prompt.images {
		let hash = Hash32::sum(&image.data);
		parts.push(Part {
			kind: Some(part::Kind::Blob(Blob {
				hash:   Bytes::copy_from_slice(hash.as_bytes()),
				mime:   image.mime_type,
				size:   u64::try_from(image.data.len()).expect("image byte length fits in u64"),
				inline: image.data,
				detail: 0,
			})),
		});
	}
	let mut props = ValueMap::default();
	props
		.fields
		.insert(COLLAB_PROMPT_TYPE_PROP.to_owned(), Value {
			kind: Some(value::Kind::String(COLLAB_PROMPT_TYPE.to_owned())),
		});
	let item = Item {
		seq:           0,
		created_at_ms: 0,
		kind:          Some(item::Kind::Message(Message {
			role:            Role::User as i32,
			parts,
			synthetic:       None,
			user_initiated:  None,
			completed_at_ms: None,
			usage:           None,
		})),
		props:         Some(props),
	};
	mailbox
		.try_enqueue(remote_principal_interrupt(item, class, mutation.principal))
		.map_err(RemoteAdmissionError::Mailbox)
}

/// Remote admission routing failure.
#[derive(Debug, Error)]
pub enum RemoteAdmissionError {
	/// The caller attempted to route a non-prompt operation through the prompt
	/// path.
	#[error("authorized remote operation is not a prompt")]
	NotPrompt,
	/// The authoritative agent mailbox closed before accepting the prompt.
	#[error("agent mailbox closed before accepting remote prompt")]
	Mailbox(#[source] Box<flume::TrySendError<Interrupt>>),
}
