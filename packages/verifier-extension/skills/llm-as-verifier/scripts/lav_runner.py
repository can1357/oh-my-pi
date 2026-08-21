#!/usr/bin/env python3
"""
Generic LLM-as-a-Verifier runner for project-local Pi workflows.

Features:
- compare mode: pairwise multi-criterion repeated verification + tournament ranking
- audit mode: single-candidate repeated multi-criterion scoring
- Gemini logprob extraction when available, text parsing fallback otherwise
- deterministic mock mode for smoke tests

Input JSON shape:
{
  "mode": "compare" | "audit",
  "task": "...",
  "context": "optional shared context",
  "ground_truth_note": "optional verifier instruction",
  "criteria": [{"id":"...","name":"...","description":"..."}],
  "candidates": [{"id":"...","summary":"...","content":"..."}],
  "n_verifications": 3,
  "granularity": 20,
  "model": "9router/gemini-3-5-flash-medium-round-robin",
  "calibration_path": "optional override path to verifier_calibration.json"
}
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys

# Ensure local harness/ package is importable regardless of invocation cwd.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from itertools import combinations
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from harness.fusion.verifier_calibration import calibrate as calibrate_verifier_score, compute_criteria_digest
from harness.fusion.verifier_scoring import confidence_from_margin, weighted_stddev, winner_from_scores


GRANULARITY = 20
LETTERS = [chr(65 + i) for i in range(GRANULARITY)]
VALID_TOKENS = {
    **{chr(65 + i): float(GRANULARITY - i) for i in range(GRANULARITY)},
    **{chr(97 + i): float(GRANULARITY - i) for i in range(GRANULARITY)},
}
SCALE_DESCRIPTION = (
    "Rate the candidate on a 20-point scale using letters A through T:\n"
    "  A = clearly and completely best / strongest\n"
    "  B-D = very strong with only minor concerns\n"
    "  E-G = above average, mostly correct with some issues\n"
    "  H-J = mixed, leans positive\n"
    "  K-M = mixed, leans negative\n"
    "  N-P = below average, significant issues remain\n"
    "  Q-S = weak with only partial value\n"
    "  T = clearly and completely weakest / failed"
)
DEFAULT_GROUND_TRUTH_NOTE = (
    "Prefer concrete evidence, observed outputs, tests, and explicit artifacts over polished narration or self-reported success."
)
SCORER_IMPLEMENTATION_ID = "lav-swap-agg-v1"


def effective_ground_truth_note(value: Any = None) -> str:
    if value is None:
        return DEFAULT_GROUND_TRUTH_NOTE
    text = str(value).strip()
    return text if text else DEFAULT_GROUND_TRUTH_NOTE
EVIDENCE_FIRST_INSTRUCTION = (
    "Before assigning any score, list exactly 3 evidence observations. Each observation must quote or paraphrase a concrete fact from the candidate, evidence, logs, tests, or task requirements. Do not count style, fluency, or confidence as evidence unless the criterion is explicitly about style. After the 3 observations, output the final score tag exactly as requested."
)
COMPARE_ROLE_INSTRUCTION = "You are an expert verifier choosing between two candidate solutions."
COMPARE_EVALUATION_RULE = "Evaluate BOTH candidates only on the named criterion. Ignore unrelated aspects."
COMPARE_TAG_INSTRUCTIONS = [
    "Output evidence in exactly these tags before the scores:",
    "<evidence_A>1. ... 2. ... 3. ...</evidence_A>",
    "<evidence_B>1. ... 2. ... 3. ...</evidence_B>",
    "Then output final scores exactly in this format:",
    "<score_A>LETTER_A_TO_T</score_A>",
    "<score_B>LETTER_A_TO_T</score_B>",
]


def verifier_protocol_digest(
    ground_truth_note: str = DEFAULT_GROUND_TRUTH_NOTE,
    granularity: int = GRANULARITY,
) -> str:
    """Canonical 16-hex hash of the exact score-shaping compare prompt templates,
    scale description, evidence-first instructions, tag format, and ground truth note.
    Any edit to prompt wording, scoring rules, evidence tags, or ground truth note
    directly changes this digest, invalidating stale calibration parameters automatically.
    """
    ground_truth_note = effective_ground_truth_note(ground_truth_note)
    material = json.dumps(
        {
            "role_instruction": COMPARE_ROLE_INSTRUCTION,
            "evaluation_rule": COMPARE_EVALUATION_RULE,
            "evidence_first_instruction": EVIDENCE_FIRST_INSTRUCTION,
            "granularity": granularity,
            "ground_truth_note": ground_truth_note,
            "scale_description": SCALE_DESCRIPTION,
            "tag_instructions": COMPARE_TAG_INSTRUCTIONS,
        },
        sort_keys=True,
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]




def load_dotenv(*roots: Path) -> None:
    for root in roots:
        env_path = root / ".env"
        if not env_path.exists():
            continue
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "criterion"


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def normalized_from_raw(raw_val: float) -> float:
    min_val, max_val = 1.0, float(GRANULARITY)
    return (raw_val - min_val) / (max_val - min_val) if max_val > min_val else 0.5


def raw_from_normalized(score: float) -> float:
    score = clamp(score, 0.0, 1.0)
    return 1.0 + score * float(GRANULARITY - 1)


def letter_from_normalized(score: float) -> str:
    raw = raw_from_normalized(score)
    index = int(round(float(GRANULARITY) - raw))
    index = max(0, min(GRANULARITY - 1, index))
    return LETTERS[index]


def truncate(text: str, max_chars: int = 500) -> str:
    text = text.strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 16] + "\n... (truncated)"


def ensure_candidate(candidate: Dict[str, Any]) -> Dict[str, Any]:
    cand_id = candidate.get("id") or candidate.get("label")
    if not cand_id:
        raise ValueError("Each candidate requires an id")
    content = candidate.get("content", "")
    if not isinstance(content, str) or not content.strip():
        raise ValueError(f"Candidate {cand_id} requires non-empty content")
    summary = candidate.get("summary", "")
    evidence = candidate.get("evidence", [])
    if not isinstance(evidence, list):
        evidence = []
    normalized_evidence = []
    for item in evidence:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "evidence")
        item_content = str(item.get("content") or "").strip()
        if item_content:
            normalized_evidence.append({"label": label, "content": item_content})
    return {
        "id": str(cand_id),
        "summary": str(summary or "").strip(),
        "content": content.strip(),
        "evidence": normalized_evidence,
    }


def normalize_input(payload: Dict[str, Any]) -> Dict[str, Any]:
    mode = str(payload.get("mode") or "compare").strip().lower()
    if mode not in {"compare", "audit"}:
        raise ValueError("mode must be 'compare' or 'audit'")

    task = str(payload.get("task") or "").strip()
    if not task:
        raise ValueError("task is required")

    criteria = payload.get("criteria")
    if not isinstance(criteria, list) or not criteria:
        raise ValueError("criteria must be a non-empty array")

    normalized_criteria = []
    for item in criteria:
        if not isinstance(item, dict):
            raise ValueError("each criterion must be an object")
        name = str(item.get("name") or "").strip()
        description = str(item.get("description") or "").strip()
        if not name or not description:
            raise ValueError("each criterion requires name and description")
        normalized_criteria.append(
            {
                "id": str(item.get("id") or slugify(name)),
                "name": name,
                "description": description,
            }
        )

    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("candidates must be a non-empty array")
    normalized_candidates = [ensure_candidate(c) for c in candidates]

    if mode == "compare" and len(normalized_candidates) < 2:
        raise ValueError("compare mode requires at least two candidates")
    if mode == "audit" and len(normalized_candidates) != 1:
        raise ValueError("audit mode requires exactly one candidate")

    granularity = int(payload.get("granularity") or GRANULARITY)
    if granularity != GRANULARITY:
        raise ValueError("only granularity 20 is currently supported")

    # None-aware read: only a missing value falls back to the default. An explicit
    # 0 (or any out-of-range int) must reach the guard below, not be swallowed by a
    # truthiness short-circuit (`0 or 5` -> 5), so it returns a clean validation error.
    raw_nv = payload.get("n_verifications")
    n_verifications = int(5 if raw_nv is None else raw_nv)
    if n_verifications < 1 or n_verifications > 8:
        raise ValueError("n_verifications must be between 1 and 8")

    cal_path_raw = payload.get("calibration_path")
    cal_path = str(cal_path_raw).strip() if cal_path_raw is not None and str(cal_path_raw).strip() else None

    return {
        "mode": mode,
        "task": task,
        "context": str(payload.get("context") or "").strip(),
        "ground_truth_note": effective_ground_truth_note(payload.get("ground_truth_note")),
        "criteria": normalized_criteria,
        "candidates": normalized_candidates,
        "n_verifications": n_verifications,
        "granularity": granularity,
        "model": str(payload.get("model") or "9router/gemini-3-5-flash-medium-round-robin").strip(),
        "mock": bool(payload.get("mock") or False),
        "calibration_path": cal_path,
    }


def format_evidence_blocks(evidence: List[Dict[str, str]]) -> str:
    if not evidence:
        return ""
    parts = ["Evidence:"]
    for item in evidence:
        parts.append(f"- {item['label']}:\n{item['content']}")
    return "\n".join(parts)


def format_candidate(candidate: Dict[str, Any], label: str) -> str:
    parts = [f"## {label} — {candidate['id']}"]
    if candidate.get("summary"):
        parts.append(f"Summary:\n{candidate['summary']}")
    parts.append(f"Content:\n{candidate['content']}")
    evidence_block = format_evidence_blocks(candidate.get("evidence", []))
    if evidence_block:
        parts.append(evidence_block)
    return "\n\n".join(parts)


def create_compare_prompt(task: str, context: str, candidate_a: Dict[str, Any], candidate_b: Dict[str, Any], criterion: Dict[str, str], ground_truth_note: str) -> str:
    parts = [
        COMPARE_ROLE_INSTRUCTION,
        ground_truth_note,
        f"Task:\n{task}",
    ]
    if context:
        parts.append(f"Shared context:\n{context}")
    parts.extend(
        [
            format_candidate(candidate_a, "Candidate A"),
            format_candidate(candidate_b, "Candidate B"),
            f"Criterion: {criterion['name']}\n{criterion['description']}",
            f"Rating scale:\n{SCALE_DESCRIPTION}",
            COMPARE_EVALUATION_RULE,
            EVIDENCE_FIRST_INSTRUCTION,
            *COMPARE_TAG_INSTRUCTIONS,
        ]
    )
    return "\n\n".join(parts)


def create_audit_prompt(task: str, context: str, candidate: Dict[str, Any], criterion: Dict[str, str], ground_truth_note: str) -> str:
    parts = [
        "You are an expert verifier scoring a single candidate solution.",
        ground_truth_note,
        f"Task:\n{task}",
    ]
    if context:
        parts.append(f"Shared context:\n{context}")
    parts.extend(
        [
            format_candidate(candidate, "Candidate"),
            f"Criterion: {criterion['name']}\n{criterion['description']}",
            f"Rating scale:\n{SCALE_DESCRIPTION}",
            "Evaluate the candidate only on the named criterion.",
            EVIDENCE_FIRST_INSTRUCTION,
            "Output evidence in exactly this tag before the score:",
            "<evidence>1. ... 2. ... 3. ...</evidence>",
            "Then output the final score exactly in this format:",
            "<score>LETTER_A_TO_T</score>",
        ]
    )
    return "\n\n".join(parts)


# Local 9router OpenAI-compatible proxy. The rest of the repo standardizes on the
# 9ROUTER_* env spellings (harness/agents/ninerouter_backend.py); we also accept the
# NINEROUTER_* spelling used by the user's shell profile.
NINEROUTER_DEFAULT_BASE_URL = "http://localhost:20128/v1"

# 9router prefix-routed providers. Bare combo IDs (no slash) that the local router
# serves are listed explicitly so they don't fall through to the Gemini branch.
_NINEROUTER_PREFIXES = (
    "cx/", "ag/", "vx/", "cc/", "kimi/", "minimax/", "qwen-team/", "nvidia/",
    "openrouter/", "groq/", "sf/", "siliconflow/", "colab/", "gc/", "9router/",
    "or/", "opencode-go/",
)
_NINEROUTER_BARE_IDS = {
    "gemini-3-5-flash-medium-round-robin", "gemini-3-5-flash-medium-fallback",
    "deepseek-v4-fallback", "deepseek-v4-flash", "openrouter-free-fallback",
    "nvidia_super", "gpt-oss", "qwen3.5plus", "qwen3.7-plus", "medium",
}


def _ninerouter_key() -> Optional[str]:
    return os.environ.get("9ROUTER_API_KEY") or os.environ.get("NINEROUTER_API_KEY")


def _is_ninerouter_model(model: str) -> bool:
    """True if the model string is served by the local 9router proxy."""
    low = (model or "").lower()
    return (
        any(low.startswith(p) for p in _NINEROUTER_PREFIXES)
        or low.startswith("deepseek")
        or low in _NINEROUTER_BARE_IDS
    )


def create_openai_client(
    base_url: Optional[str] = None, api_key: Optional[str] = None, model: str = ""
) -> Any:
    """Create an OpenAI-compatible client.

    Credential resolution (priority order):
      1. Explicit base_url / api_key arguments
      2. 9ROUTER_BASE_URL / NINEROUTER_BASE_URL + 9ROUTER_API_KEY / NINEROUTER_API_KEY
      3. OPENAI_BASE_URL / OPENAI_API_KEY (OpenAI / Codex direct)

    When no base URL is configured but the key came from a 9router var OR the model
    string is a 9router-routed ID (e.g. kimi/..., minimax/..., cx/gpt-5.5), the base
    URL defaults to the local 9router proxy so the call doesn't silently hit
    api.openai.com and 404.
    """
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError(
            "Missing dependency 'openai'. Install with: pip install openai"
        ) from exc

    nr_key = _ninerouter_key()
    resolved_key = api_key or nr_key or os.environ.get("OPENAI_API_KEY")
    if not resolved_key:
        raise RuntimeError(
            "No API key found. Set 9ROUTER_API_KEY / NINEROUTER_API_KEY (for the local "
            "9router proxy) or OPENAI_API_KEY, or pass api_key explicitly."
        )

    resolved_base = (
        base_url
        or os.environ.get("9ROUTER_BASE_URL")
        or os.environ.get("NINEROUTER_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
    )
    if not resolved_base and ((nr_key and resolved_key == nr_key) or _is_ninerouter_model(model)):
        resolved_base = NINEROUTER_DEFAULT_BASE_URL

    kwargs: Dict[str, Any] = {"api_key": resolved_key}
    if resolved_base:
        kwargs["base_url"] = resolved_base
    return OpenAI(**kwargs)


def call_openai_compatible(client: Any, prompt: str, model: str) -> Tuple[str, None, None]:
    """Call any OpenAI-compatible endpoint (9router, Kimi, MiniMax, Codex, etc.).

    API/transport errors propagate to the caller (the MCP layer / runner main() wrap
    them into structured errors). Guards an empty choices list so a malformed response
    yields empty text rather than an IndexError.
    """
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=1024,
        temperature=0.0,
        stream=False,
    )
    choices = getattr(response, "choices", None) or []
    choice = choices[0] if choices else None
    message = getattr(choice, "message", None) if choice else None
    text = (getattr(message, "content", "") if message else "") or ""
    return text, None, None


def _is_openai_compatible(model: str) -> bool:
    """Return True if the model string should be routed to an OpenAI-compatible endpoint.

    Covers all 9router-routed models (prefix- and bare-ID-routed) plus direct OpenAI
    model names. Bare ``gemini-2.5-*`` IDs are intentionally NOT matched so they still
    route to the native Gemini SDK.
    """
    low = (model or "").lower()
    return (
        _is_ninerouter_model(model)
        or low.startswith("gpt-")
        or low.startswith("o1") or low.startswith("o3") or low.startswith("o4")
        or low in ("openai", "codex")
    )


def create_judge_client(model: str, mock: bool = False) -> Any:
    if mock or model == "mock":
        return None
    if _is_openai_compatible(model):
        return create_openai_client(model=model)
    return create_gemini_client()


def create_gemini_client() -> Any:
    try:
        from google import genai
    except ImportError as exc:
        raise RuntimeError(
            "Missing dependency 'google-genai'. Install with: pip install google-genai"
        ) from exc

    vertex_key = os.environ.get("VERTEX_API_KEY")
    if vertex_key:
        return genai.Client(vertexai=True, api_key=vertex_key)

    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if api_key:
        return genai.Client(api_key=api_key)

    raise RuntimeError(
        "Set VERTEX_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY in the environment or .env"
    )


def call_gemini(client: Any, prompt: str, model: str, top_logprobs: int = 20) -> Tuple[str, Optional[List[str]], Optional[List[List[Tuple[str, float]]]]]:
    from google.genai.types import Content, GenerateContentConfig, Part, ThinkingConfig

    response = client.models.generate_content(
        model=model,
        contents=[Content(role="user", parts=[Part(text=prompt)])],
        config=GenerateContentConfig(
            max_output_tokens=1024,
            temperature=1.0,
            response_logprobs=True,
            logprobs=top_logprobs,
            thinking_config=ThinkingConfig(thinking_budget=0),
        ),
    )

    text = response.text or ""
    tokens = None
    position_logprobs = None
    candidate = response.candidates[0]
    if candidate.logprobs_result and candidate.logprobs_result.top_candidates:
        position_logprobs = []
        for pos in candidate.logprobs_result.top_candidates:
            position_logprobs.append([(lp.token, lp.log_probability) for lp in pos.candidates])
        if candidate.logprobs_result.chosen_candidates:
            tokens = [c.token for c in candidate.logprobs_result.chosen_candidates]
    return text, tokens, position_logprobs


SUCCESS_HINTS = [
    "pass",
    "passed",
    "success",
    "succeeded",
    "fixed",
    "verified",
    "green",
    "expected output",
    "report generated",
]
ERROR_HINTS = [
    "error",
    "failed",
    "failure",
    "traceback",
    "exception",
    "command not found",
    "no such file",
    "segmentation fault",
    "not created",
]
PARTIAL_HINTS = ["partial", "some tests", "not verified", "uncertain", "partial progress"]


def heuristic_score(text: str) -> float:
    lowered = text.lower()
    success = sum(lowered.count(token) for token in SUCCESS_HINTS)
    errors = sum(lowered.count(token) for token in ERROR_HINTS)
    partial = sum(lowered.count(token) for token in PARTIAL_HINTS)
    score = 0.55 + 0.06 * success - 0.08 * errors - 0.03 * partial
    return clamp(score, 0.05, 0.95)


def call_mock_compare(prompt: str, candidate_a: Dict[str, Any], candidate_b: Dict[str, Any]) -> Tuple[str, None, None]:
    score_a = heuristic_score(candidate_a["content"] + "\n" + candidate_a.get("summary", ""))
    score_b = heuristic_score(candidate_b["content"] + "\n" + candidate_b.get("summary", ""))
    letter_a = letter_from_normalized(score_a)
    letter_b = letter_from_normalized(score_b)
    text = (
        "Mock verifier response.\n"
        f"Prompt excerpt: {truncate(prompt, 120)}\n"
        f"<score_A>{letter_a}</score_A>\n"
        f"<score_B>{letter_b}</score_B>"
    )
    return text, None, None


def call_mock_audit(prompt: str, candidate: Dict[str, Any]) -> Tuple[str, None, None]:
    score = heuristic_score(candidate["content"] + "\n" + candidate.get("summary", ""))
    letter = letter_from_normalized(score)
    text = (
        "Mock verifier response.\n"
        f"Prompt excerpt: {truncate(prompt, 120)}\n"
        f"<score>{letter}</score>"
    )
    return text, None, None


def _find_tag_logprobs(tokens: Optional[List[str]], position_logprobs: Optional[List[List[Tuple[str, float]]]], tag: str) -> Optional[List[Tuple[str, float]]]:
    if not tokens or not position_logprobs:
        return None
    text_so_far = ""
    for i, tok in enumerate(tokens):
        text_so_far += tok
        if text_so_far.rstrip().endswith(tag) and i + 1 < len(position_logprobs):
            return position_logprobs[i + 1]
    return None


def extract_score(text: str, tokens: Optional[List[str]], position_logprobs: Optional[List[List[Tuple[str, float]]]], tag: str) -> Tuple[float, str]:
    tag_lp = _find_tag_logprobs(tokens, position_logprobs, tag)
    probs: Dict[float, float] = {}
    if tag_lp:
        for tok_str, logprob in tag_lp:
            tok = tok_str.strip()
            if tok in VALID_TOKENS:
                raw_val = VALID_TOKENS[tok]
                probs[raw_val] = max(probs.get(raw_val, 0.0), math.exp(logprob))
    if probs:
        total = sum(probs.values())
        expected = sum(raw * prob for raw, prob in probs.items()) / total
        return normalized_from_raw(expected), "logprobs"

    tag_name = tag.strip("<>")
    match = re.search(rf"<{re.escape(tag_name)}>\s*([A-Ta-t])\s*</{re.escape(tag_name)}>", text or "")
    if match:
        raw_val = VALID_TOKENS[match.group(1)]
        return normalized_from_raw(raw_val), "text"

    return 0.5, "fallback"


def score_compare_pair(client: Any, config: Dict[str, Any], candidate_a: Dict[str, Any], candidate_b: Dict[str, Any], criterion: Dict[str, str]) -> Dict[str, Any]:
    prompt = create_compare_prompt(
        config["task"],
        config["context"],
        candidate_a,
        candidate_b,
        criterion,
        config["ground_truth_note"],
    )
    if config["mock"]:
        text, tokens, position_logprobs = call_mock_compare(prompt, candidate_a, candidate_b)
    elif _is_openai_compatible(config["model"]):
        text, tokens, position_logprobs = call_openai_compatible(client, prompt, config["model"])
    else:
        text, tokens, position_logprobs = call_gemini(client, prompt, config["model"])
    score_a, source_a = extract_score(text, tokens, position_logprobs, "<score_A>")
    score_b, source_b = extract_score(text, tokens, position_logprobs, "<score_B>")
    return {
        "score_a": score_a,
        "score_b": score_b,
        "source_a": source_a,
        "source_b": source_b,
        "response_excerpt": truncate(text, 500),
    }


def score_audit_candidate(client: Any, config: Dict[str, Any], candidate: Dict[str, Any], criterion: Dict[str, str]) -> Dict[str, Any]:
    prompt = create_audit_prompt(
        config["task"],
        config["context"],
        candidate,
        criterion,
        config["ground_truth_note"],
    )
    if config["mock"]:
        text, tokens, position_logprobs = call_mock_audit(prompt, candidate)
    elif _is_openai_compatible(config["model"]):
        text, tokens, position_logprobs = call_openai_compatible(client, prompt, config["model"])
    else:
        text, tokens, position_logprobs = call_gemini(client, prompt, config["model"])
    score, source = extract_score(text, tokens, position_logprobs, "<score>")
    return {
        "score": score,
        "source": source,
        "response_excerpt": truncate(text, 500),
    }


def select_overall_winner(ranking: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not ranking:
        return None
    if len(ranking) == 1:
        return ranking[0]
    if ranking[0]["wins"] == ranking[1]["wins"] and ranking[0]["mean_pair_score"] == ranking[1]["mean_pair_score"]:
        return None
    return ranking[0]


def run_compare(client: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    ground_truth_note = effective_ground_truth_note(config.get("ground_truth_note"))
    config = {**config, "ground_truth_note": ground_truth_note}
    candidates = config["candidates"]
    criteria = config["criteria"]
    wins = {candidate["id"]: 0.0 for candidate in candidates}
    pair_score_totals = {candidate["id"]: [] for candidate in candidates}
    pairwise_results = []
    call_count = 0

    for i, j in combinations(range(len(candidates)), 2):
        candidate_a = candidates[i]
        candidate_b = candidates[j]
        criterion_results = []
        pair_canonical_a: list[float] = []
        pair_canonical_b: list[float] = []
        pair_votes_a = 0.0
        pair_votes_b = 0.0

        for criterion in criteria:
            repetitions = []
            original_margins: list[float] = []
            swapped_margins: list[float] = []
            for rep in range(config["n_verifications"]):
                call_count += 1
                original = score_compare_pair(client, config, candidate_a, candidate_b, criterion)
                original["rep"] = rep + 1
                original["order"] = "original"
                original["canonical_score_a"] = original["score_a"]
                original["canonical_score_b"] = original["score_b"]
                repetitions.append(original)
                original_margins.append(original["canonical_score_a"] - original["canonical_score_b"])

                call_count += 1
                swapped = score_compare_pair(client, config, candidate_b, candidate_a, criterion)
                swapped["rep"] = rep + 1
                swapped["order"] = "swapped"
                swapped["canonical_score_a"] = swapped["score_b"]
                swapped["canonical_score_b"] = swapped["score_a"]
                repetitions.append(swapped)
                swapped_margins.append(swapped["canonical_score_a"] - swapped["canonical_score_b"])

            canonical_a = [item["canonical_score_a"] for item in repetitions]
            canonical_b = [item["canonical_score_b"] for item in repetitions]
            margins = [a - b for a, b in zip(canonical_a, canonical_b)]
            criterion_mean_a = sum(canonical_a) / len(canonical_a)
            criterion_mean_b = sum(canonical_b) / len(canonical_b)
            mean_margin = criterion_mean_a - criterion_mean_b
            disagreement = min(1.0, weighted_stddev([(margin, 1.0) for margin in margins], mean_margin))
            confidence = confidence_from_margin(mean_margin, disagreement)
            margin_diffs = [abs(original_margin - swapped_margin) for original_margin, swapped_margin in zip(original_margins, swapped_margins)]
            swap_consistency = 1.0 - clamp(sum(margin_diffs) / len(margin_diffs), 0.0, 1.0) if margin_diffs else 0.0
            for score_a, score_b in zip(canonical_a, canonical_b):
                rep_winner = winner_from_scores(score_a, score_b, tie_threshold=0.05)
                if rep_winner == "candidate_a":
                    pair_votes_a += 1.0
                elif rep_winner == "candidate_b":
                    pair_votes_b += 1.0
                else:
                    pair_votes_a += 0.5
                    pair_votes_b += 0.5
            pair_canonical_a.extend(canonical_a)
            pair_canonical_b.extend(canonical_b)
            criterion_results.append(
                {
                    "criterion": criterion,
                    "score_a": criterion_mean_a,
                    "score_b": criterion_mean_b,
                    "disagreement": disagreement,
                    "confidence": confidence,
                    "swap_consistency": swap_consistency,
                    "repetitions": repetitions,
                }
            )

        pair_mean_a = sum(pair_canonical_a) / len(pair_canonical_a) if pair_canonical_a else 0.5
        pair_mean_b = sum(pair_canonical_b) / len(pair_canonical_b) if pair_canonical_b else 0.5
        margin = pair_mean_a - pair_mean_b
        total_votes = pair_votes_a + pair_votes_b
        vote_margin = max(pair_votes_a, pair_votes_b) / total_votes if total_votes else 0.0
        winner_side = winner_from_scores(pair_mean_a, pair_mean_b, tie_threshold=0.05)
        if vote_margin < 0.7:
            winner_side = "tie"
        if winner_side == "candidate_a":
            wins[candidate_a["id"]] += 1.0
            winner = candidate_a["id"]
        elif winner_side == "candidate_b":
            wins[candidate_b["id"]] += 1.0
            winner = candidate_b["id"]
        else:
            wins[candidate_a["id"]] += 0.5
            wins[candidate_b["id"]] += 0.5
            winner = "tie"

        pair_score_totals[candidate_a["id"]].append(pair_mean_a)
        pair_score_totals[candidate_b["id"]].append(pair_mean_b)

        # Best-effort Platt calibration lookup. `calibrate_verifier_score`
        # returns None (never a guessed/uncalibrated stand-in, and never a
        # crash) when no fit exists yet for this exact (model,
        # n_verifications) configuration and prompt digest.
        _calibration_kwargs = {}
        if config.get("calibration_path"):
            _calibration_kwargs["path"] = config["calibration_path"]
        granularity = config.get("granularity", GRANULARITY)
        prompt_digest = verifier_protocol_digest(ground_truth_note=ground_truth_note, granularity=granularity)
        criteria_digest = compute_criteria_digest(criteria)
        try:
            calibrated_score_a = calibrate_verifier_score(
                pair_mean_a,
                config["model"],
                config["n_verifications"],
                granularity=granularity,
                prompt_digest=prompt_digest,
                criteria_digest=criteria_digest,
                scorer_id=SCORER_IMPLEMENTATION_ID,
                **_calibration_kwargs,
            )
            calibrated_score_b = calibrate_verifier_score(
                pair_mean_b,
                config["model"],
                config["n_verifications"],
                granularity=granularity,
                prompt_digest=prompt_digest,
                criteria_digest=criteria_digest,
                scorer_id=SCORER_IMPLEMENTATION_ID,
                **_calibration_kwargs,
            )
            calibrated_margin = (
                calibrated_score_a - calibrated_score_b
                if calibrated_score_a is not None and calibrated_score_b is not None
                else None
            )
        except Exception:
            calibrated_score_a = None
            calibrated_score_b = None
            calibrated_margin = None
        pairwise_results.append(
            {
                "candidate_a": candidate_a["id"],
                "candidate_b": candidate_b["id"],
                "score_a": pair_mean_a,
                "score_b": pair_mean_b,
                "margin": margin,
                "vote_margin": vote_margin,
                "winner": winner,
                "calibrated_score_a": calibrated_score_a,
                "calibrated_score_b": calibrated_score_b,
                "calibrated_margin": calibrated_margin,
                "criteria": criterion_results,
            }
        )

    ranking = []
    for candidate in candidates:
        cand_id = candidate["id"]
        mean_pair_score = sum(pair_score_totals[cand_id]) / len(pair_score_totals[cand_id]) if pair_score_totals[cand_id] else 0.5
        ranking.append(
            {
                "id": cand_id,
                "wins": wins[cand_id],
                "mean_pair_score": mean_pair_score,
                "summary": candidate.get("summary", ""),
            }
        )
    ranking.sort(key=lambda item: (-item["wins"], -item["mean_pair_score"], item["id"]))

    return {
        "mode": "compare",
        "winner": select_overall_winner(ranking),
        "ranking": ranking,
        "pairwise": pairwise_results,
        "estimated_calls": call_count,
    }


def run_audit(client: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    candidate = config["candidates"][0]
    criteria = config["criteria"]
    call_count = 0
    criterion_results = []
    all_repetitions = []

    for criterion in criteria:
        repetitions = []
        for rep in range(config["n_verifications"]):
            call_count += 1
            rep_result = score_audit_candidate(client, config, candidate, criterion)
            rep_result["rep"] = rep + 1
            repetitions.append(rep_result)
            all_repetitions.append(rep_result)
        mean_score = sum(item["score"] for item in repetitions) / len(repetitions)
        criterion_results.append(
            {
                "criterion": criterion,
                "score": mean_score,
                "repetitions": repetitions,
            }
        )

    overall = sum(item["score"] for item in criterion_results) / len(criterion_results)
    positive_votes = sum(1 for item in all_repetitions if item["score"] >= 0.7)
    negative_votes = sum(1 for item in all_repetitions if item["score"] <= 0.3)
    non_abstain = positive_votes + negative_votes
    vote_margin = max(positive_votes, negative_votes) / non_abstain if non_abstain else 0.0
    return {
        "mode": "audit",
        "candidate": {"id": candidate["id"], "summary": candidate.get("summary", "")},
        "overall_score": overall,
        "vote_margin": vote_margin,
        "criteria": criterion_results,
        "estimated_calls": call_count,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Generic LLM-as-a-Verifier runner")
    parser.add_argument("--input", required=True, help="Path to input JSON")
    parser.add_argument("--output", required=True, help="Path to output JSON")
    parser.add_argument("--mock", action="store_true", help="Use deterministic mock scoring for smoke tests")
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    cwd = Path.cwd()
    load_dotenv(cwd, script_dir, script_dir.parent, script_dir.parent.parent, script_dir.parent.parent.parent)

    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    if args.mock:
        payload["mock"] = True
    config = normalize_input(payload)

    result: Dict[str, Any] = {
        "config": {
            "mode": config["mode"],
            "model": config["model"],
            "granularity": config["granularity"],
            "n_verifications": config["n_verifications"],
            "criteria": [{"id": c["id"], "name": c["name"]} for c in config["criteria"]],
            "candidate_ids": [c["id"] for c in config["candidates"]],
            "mock": config["mock"],
        }
    }

    try:
        client = create_judge_client(config["model"], mock=config["mock"])
        if config["mode"] == "compare":
            result["result"] = run_compare(client, config)
        else:
            result["result"] = run_audit(client, config)
        result["ok"] = True
    except Exception as exc:  # pragma: no cover - surfaced to caller
        result["ok"] = False
        result["error"] = str(exc)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    if not result.get("ok"):
        print(result["error"], file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
