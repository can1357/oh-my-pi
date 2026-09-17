#!/usr/bin/env python3
"""
ompk_to_hf.py - Convert ompk session JSONL traces into a Hugging Face Dataset format.

Compatible with:
- Hugging Face datasets (Dataset.from_list, push_to_hub, save_to_disk)
- Standard ChatML / OpenAI-compatible tool call chat templates (Qwen2.5, Llama 3.1, Hermes)
- SFT trainers (Unsloth, TRL SFTTrainer, LLaMA-Factory)
"""

import os
import json
import glob
from pathlib import Path
from typing import List, Dict, Any, Optional

DEFAULT_SESSIONS_DIR = Path(r"C:\Users\prest\.ompk\agent\sessions\--C--dev-desktop-projects-Interconnection-Dash-2026--")

def extract_content_text(content: Any) -> str:
    """Extract plain text from string or block list."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(block.get("text", ""))
                elif "text" in block:
                    parts.append(block.get("text", ""))
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts)
    return str(content or "")

def parse_session_file(file_path: Path) -> List[Dict[str, Any]]:
    """
    Parses a single .jsonl session into standardized OpenAI/HF chat messages:
    Each message has:
      - role: "system" | "user" | "assistant" | "tool"
      - content: str
      - Optional for assistant: reasoning_content (str), tool_calls (list)
      - Optional for tool: tool_call_id (str), name (str)
    """
    messages = []
    
    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except Exception:
                continue

            entry_type = entry.get("type")
            if entry_type != "message":
                continue

            msg = entry.get("message", {})
            role = msg.get("role")

            if role == "user":
                text = extract_content_text(msg.get("content"))
                if text.strip():
                    messages.append({
                        "role": "user",
                        "content": text.strip()
                    })

            elif role == "assistant":
                content_blocks = msg.get("content", [])
                text_parts = []
                thinking_parts = []
                tool_calls = []

                if isinstance(content_blocks, str):
                    text_parts.append(content_blocks)
                elif isinstance(content_blocks, list):
                    for b in content_blocks:
                        if not isinstance(b, dict):
                            continue
                        b_type = b.get("type")
                        if b_type == "text":
                            text_parts.append(b.get("text", ""))
                        elif b_type == "thinking":
                            # Retain plain text reasoning thoughts (useful for DeepSeek-R1 / Qwen QwQ style fine-tuning)
                            th = b.get("thinking", "")
                            if th:
                                thinking_parts.append(th)
                        elif b_type == "toolCall":
                            tool_calls.append({
                                "id": b.get("id", ""),
                                "type": "function",
                                "function": {
                                    "name": b.get("name", ""),
                                    "arguments": json.dumps(b.get("arguments", {}), ensure_ascii=False)
                                }
                            })

                assistant_msg: Dict[str, Any] = {
                    "role": "assistant",
                    "content": "\n".join(text_parts).strip()
                }
                if thinking_parts:
                    assistant_msg["reasoning_content"] = "\n\n".join(thinking_parts).strip()
                if tool_calls:
                    assistant_msg["tool_calls"] = tool_calls

                # Only append if there's actual content, reasoning, or tool calls
                if assistant_msg["content"] or assistant_msg.get("reasoning_content") or assistant_msg.get("tool_calls"):
                    messages.append(assistant_msg)

            elif role == "toolResult":
                tool_call_id = msg.get("toolCallId", "")
                tool_name = msg.get("toolName", "")
                is_error = msg.get("isError", False)
                text = extract_content_text(msg.get("content"))
                
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "name": tool_name,
                    "content": text.strip()
                })

    return messages

def build_dataset(sessions_dir: Path = DEFAULT_SESSIONS_DIR, output_jsonl: Optional[str] = None):
    """
    Aggregates all sessions, cleans up trajectories, and outputs HF dataset records.
    """
    all_sessions = list(sessions_dir.glob("*.jsonl"))
    print(f"Found {len(all_sessions)} session files in {sessions_dir}")

    records = []
    total_messages = 0

    for s_path in all_sessions:
        msgs = parse_session_file(s_path)
        if not msgs:
            continue

        # Basic validity filtering: must contain at least 1 user and 1 assistant turn
        has_user = any(m["role"] == "user" for m in msgs)
        has_assistant = any(m["role"] == "assistant" for m in msgs)
        if not (has_user and has_assistant):
            continue

        records.append({
            "session_id": s_path.stem,
            "messages": msgs
        })
        total_messages += len(msgs)

    print(f"Extracted {len(records)} valid multi-turn sessions ({total_messages} total messages).")

    if output_jsonl:
        out_p = Path(output_jsonl)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        with open(out_p, "w", encoding="utf-8") as f:
            for rec in records:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"Saved dataset to {out_p.resolve()}")

    return records

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Convert ompk sessions to HF chat dataset")
    parser.add_argument("--dir", default=str(DEFAULT_SESSIONS_DIR), help="Path to session directory")
    parser.add_argument("--out", default="interconnection_dash_traces.jsonl", help="Output JSONL path")
    args = parser.parse_args()

    build_dataset(Path(args.dir), args.out)
