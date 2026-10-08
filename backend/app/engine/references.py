"""Template references in node config, e.g. "Summarise: {{agent.output.summary}}".

Grammar (must match frontend/src/lib/flow/references.ts; both are tested against
shared/template-cases.json):

    {{input}} | {{input.<path>}}               output of the previous node
    {{<node>.output}} | {{<node>.output.<path>}}
        <node> = a node's ref (e.g. agent_2) or, for older flows, its id (node_8203befa)
        <path> = segments of [A-Za-z0-9_]+ separated by "."; numeric segments index lists

Anything else between {{ and }} is an invalid reference. Whitespace inside the braces is ignored.
Resolving references to values happens in the engine's run context (Phase 3.3).
"""

import re
from dataclasses import dataclass, field
from typing import Literal

TOKEN = re.compile(r"\{\{([^{}]*)\}\}")
NODE = re.compile(r"[a-z][a-z0-9_]*")
SEGMENT = re.compile(r"[A-Za-z0-9_]+")


@dataclass(frozen=True)
class TextPart:
    value: str
    kind: Literal["text"] = "text"


@dataclass(frozen=True)
class RefPart:
    node: str
    path: list[str] = field(default_factory=list)
    kind: Literal["ref"] = "ref"


@dataclass(frozen=True)
class InputPart:
    path: list[str] = field(default_factory=list)
    kind: Literal["input"] = "input"


@dataclass(frozen=True)
class InvalidPart:
    raw: str
    kind: Literal["invalid"] = "invalid"


TemplatePart = TextPart | RefPart | InputPart | InvalidPart


def _parse_token(inner: str) -> RefPart | InputPart | None:
    segments = inner.strip().split(".")
    if any(s == "" for s in segments):
        return None
    if segments[0] == "input":
        path = segments[1:]
        return InputPart(path) if all(SEGMENT.fullmatch(s) for s in path) else None
    if len(segments) < 2:
        return None
    node, keyword, *path = segments
    if not NODE.fullmatch(node) or keyword != "output":
        return None
    if not all(SEGMENT.fullmatch(s) for s in path):
        return None
    return RefPart(node, path)


def parse_template(text: str) -> list[TemplatePart]:
    parts: list[TemplatePart] = []
    last = 0
    for match in TOKEN.finditer(text):
        if match.start() > last:
            parts.append(TextPart(text[last : match.start()]))
        parts.append(_parse_token(match.group(1)) or InvalidPart(match.group(0)))
        last = match.end()
    if last < len(text):
        parts.append(TextPart(text[last:]))
    return parts


def format_reference(node: str, path: list[str] | None = None) -> str:
    return "{{" + ".".join([node, "output", *(path or [])]) + "}}"


def referenced_nodes(text: str) -> list[str]:
    """Node refs/ids referenced by `text` (deduplicated, in order of appearance)."""
    seen: dict[str, None] = {}
    for part in parse_template(text):
        if isinstance(part, RefPart):
            seen.setdefault(part.node)
    return list(seen)


def rename_references(text: str, old: str, new: str) -> str:
    """Rewrites references to node `old` so they point at `new`; everything else is verbatim."""

    def replace(match: re.Match[str]) -> str:
        part = _parse_token(match.group(1))
        if isinstance(part, RefPart) and part.node == old:
            return format_reference(new, part.path)
        return match.group(0)

    return TOKEN.sub(replace, text)
