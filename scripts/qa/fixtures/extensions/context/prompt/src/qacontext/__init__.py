from __future__ import annotations
import omp

PROMPT = "QA_CONTEXT_PROMPT_SLOT_91"
PATCH = "QA_CONTEXT_PATCH_91"

@omp.prompt_slot("guidance", priority=321, cls=omp.SlotClass.STABLE)
def context_marker(ctx: omp.PromptContext) -> str:
    assert ctx.slot == "guidance"
    return f"{PROMPT} session={ctx.session_id}"

@omp.hook("thread_projection")
async def patch_context(view: omp.ContextView, ctx: omp.Context) -> omp.ContextPatch | None:
    del ctx
    prior = next((ref for ref in reversed(view.messages) if ref.kind is omp.MessageKind.ASSISTANT), None)
    if prior is None:
        return None
    return omp.ContextPatch(insert=[omp.Insert(
        parts=(omp.Part.text(f"{PATCH} id={prior.id} seq={prior.seq} preview={prior.preview}"),),
        anchor=omp.Anchor.tail(), role="system", ephemeral=True, dedupe_key="qa-context-91",
    )], note="QA provider-visible patch")
