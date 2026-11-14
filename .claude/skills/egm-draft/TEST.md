# Test Plan: EGM Draft Skill

Frontmatter and link checks run in `pytest tests/unit` (see [TESTING.md](../../TESTING.md)).

## Protocol Verification Checklist

When evaluating or exploring `egm-draft` interactively in chat, verify:

-   **Step 4 (Alternatives):** Reads rejected alternatives from the brief's
    `Alternatives Weighed` section, or asks the user if it is absent.
-   **Step 6 (Finalize):** Reports contradictions between the brief and the
    draft before directory selection, and waits for the user to decide each
    one. Does not self-grade against
    the Zoom Out standard.
