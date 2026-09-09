import json
from dataclasses import asdict
from types import MappingProxyType

import omp
from omp import ui


def render_notice(message: ui.MessageView, ctx: ui.RenderCtx):
    return ui.tml("<callout icon=info>{body}</callout>", body=message.text)


def transform_markdown(markdown: str) -> str:
    return markdown.replace("[qa]", "QA")


async def complete(query: str, ctx: omp.Context):
    return (ui.CompletionItem(insert=query + "-done", label="done", icon="check"),)


@omp.tool(kind="hard")
async def hello(name: str = "world") -> dict:
    escaped = ui.text("<unsafe>&")
    tree = ui.tml(
        "<box title='QA' border=round><col gap=1>{body}{items}</col></box>",
        body=ui.join((escaped, ui.md("**bold**"), ui.icon("check", fg=ui.Token.OK)), sep=" | "),
        items=(ui.text(name), ui.Tml.raw("<text bold>raw</text>")),
    )
    assert isinstance(tree, ui.Tml)
    slot_options = ui.SlotOptions(
        order=7,
        visible_in=frozenset((ui.Phase.WORKING,)),
        collapse=ui.Collapse.TRUNCATE,
    )
    overlay_options = ui.OverlayOptions(
        width=ui.Pct(75),
        anchor=ui.Anchor.TOP_RIGHT,
        margin=ui.Margin(1, 2, 3, 4),
        modal=False,
    )
    item = ui.SelectItem("one", label="One", preview=tree)
    field = ui.Field("title", "text", "Title", value="draft")
    question = ui.AskQuestion("choice", "Choose", options=(item,))
    answer = ui.AskAnswer("choice", selected=("one",))
    ghost = ui.Ghost("suggestion", id="ghost-1")
    event = ui.OverlayEvent(ui.EventKind.CHANGED, "choice", "one")
    action = ui.Action("qa-action", "ctrl+q", ui.Phase.IDLE)
    invocation = ui.Invocation("qa-ui", ("one",), "one", ui.InvocationMode.HEADLESS)
    arg_query = ui.ArgQuery("o", ("first",))
    completion_item = ui.CompletionItem("one", label="One")
    message = ui.MessageView("m1", "notice", None, "hello", {"tone": "quiet"})
    render_ctx = ui.RenderCtx(
        80, ui.Charset.UNICODE, ui.Appearance.DARK, ui.Graphics.CELLS,
        True, False, False, ui.RenderPlace.TRANSCRIPT, {"tone": "quiet"},
    )
    rendered = render_notice(message, render_ctx)
    transformed = transform_markdown("[qa] projection")
    assert isinstance(rendered, ui.Tml) and transformed == "QA projection"
    assert ghost.id == "ghost-1" and event.value == "one"
    projection = {
        "tml": {"tree": type(tree).__name__, "rendered": type(rendered).__name__},
        "slot": {"order": slot_options.order, "phase": next(iter(slot_options.visible_in)).value},
        "overlay": {
            "width": overlay_options.width.value,
            "anchor": overlay_options.anchor.value,
            "margin": asdict(overlay_options.margin),
        },
        "dialog": {
            "item": item.value,
            "field": field.id,
            "question": question.id,
            "answer": answer.selected,
        },
        "fold": {
            "message": message.kind,
            "place": render_ctx.place.value,
            "transformed": transformed,
            "completion": completion_item.insert,
            "query": arg_query.prefix,
        },
        "dispatch": {"action": action.action_id, "command": invocation.name},
    }
    return json.dumps(projection, sort_keys=True, separators=(",", ":"))
