import json
import omp

@omp.tool(kind="hard")
async def hello() -> str:
    template = omp.scribe.Template(
        "{% if findings %}{{ findings | length | pluralize('finding') }}:\n"
        "{{ findings | bullets }}{% endif %}",
        name="lint-summary",
    )
    rendered = template.render({"findings": ["unused import", "shadowed name"]})
    one_shot = omp.scribe.render("Hello {{ name }}", {"name": "Ada"}, name="greeting")
    canonical = omp.scribe.canonicalize("A MUST NOT  \n\n\nB -> C\n<!-- hidden -->\n")
    try:
        omp.scribe.Template("{{ missing | unknown_filter }}", name="bad")
    except omp.scribe.TemplateError as error:
        template_error = str(error)
    else:
        raise AssertionError("unknown filter compiled")
    report = {
        "rendered": rendered,
        "name": template.name,
        "keys": list(template.referenced_keys),
        "one_shot": one_shot,
        "canonical": canonical,
        "template_error": template_error,
    }
    return json.dumps(report)
