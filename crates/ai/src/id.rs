//! Strongly typed identifiers for runtime inference state.

use omp_core::string_id;

string_id!(/// Identifies one logical inference request across all attempts.
	RequestId);
string_id!(/// Identifies a credential-bearing account without exposing its secret.
	AccountId);
string_id!(/// Identifies the authenticated principal that owns account affinity.
	PrincipalId);
string_id!(/// Identifies a cloud or account-scoped project.
	ProjectId);
string_id!(/// Identifies an account tenant.
	TenantId);
string_id!(/// Identifies an account organization.
	OrganizationId);
string_id!(/// Identifies a routing or billing region.
	RegionId);
string_id!(/// Identifies an append-only conversation.
	ConversationId);
string_id!(/// Identifies an immutable committed conversation revision.
	Revision);
string_id!(/// Identifies an idempotent conversation turn.
	TurnId);
string_id!(/// Identifies a canonical tool call.
	ToolCallId);
string_id!(/// Identifies a resumable media-generation job.
	GenerationHandle);
string_id!(/// Identifies an interactive authentication session.
	LoginSessionId);
