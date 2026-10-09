"""Run context: node outputs and template resolution while a flow runs.

References (grammar: app/engine/references.py) resolve against outputs of nodes that have run:

- `{{input}}` — exactly one delivered input → that sender's output; several → an object keyed by
  each sender's ref (`{{input.agent}}`); none (the trigger) → the run's input. Skipped senders are
  absent (context.md §8k).
- `{{<name>.output.<path>}}` — `<name>` is a ref (or, for older flows, an id).
- `<path>` segments index dicts by key and lists by number. A path into a *string* that holds JSON
  (an agent asked to answer in JSON) is followed into the parsed value.

A reference without a value — its node was skipped or hasn't run, or the path doesn't exist —
renders as empty text and is reported as a warning log on the node, rather than failing it.

Values become text like this: strings as-is, None → "", booleans → true/false, numbers as written,
objects and lists → indented JSON. A field consisting of one reference and nothing else can be
read as the raw value instead (`NodeContext.value`).
"""

import json
from collections.abc import Callable, Sequence
from typing import Any, Protocol

from app.engine import events
from app.engine.compiler import ExecutionPlan, PlanEdge, PlannedNode
from app.engine.events import EventSink, LogLevel
from app.engine.references import InputPart, InvalidPart, RefPart, TextPart, parse_template


class _Missing:
    def __repr__(self) -> str:
        return "MISSING"


MISSING: Any = _Missing()


def lookup(value: Any, path: Sequence[str]) -> Any:
    """`value` at `path`, or MISSING."""
    for segment in path:
        if isinstance(value, str) and value.strip()[:1] in ("{", "["):
            try:
                value = json.loads(value)
            except ValueError:
                return MISSING
        if isinstance(value, dict) and segment in value:
            value = value[segment]
        elif isinstance(value, list) and segment.isdigit() and int(segment) < len(value):
            value = value[int(segment)]
        else:
            return MISSING
    return value


def to_text(value: Any) -> str:
    if value is None or value is MISSING:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return json.dumps(value)
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


class Secrets(Protocol):
    """The run owner's saved API keys (app/services/credentials.py)."""

    async def get(self, provider: str, credential_id: str | None = None) -> str | None:
        """A specific credential (`credential_id`, which must be for `provider`), or else the
        owner's key for `provider`, or None."""
        ...


class NoSecrets:
    async def get(self, provider: str, credential_id: str | None = None) -> str | None:
        return None


class RunContext:
    """Everything a run knows: the plan, the run's input and the outputs produced so far."""

    def __init__(
        self,
        plan: ExecutionPlan,
        *,
        run_id: str,
        input: str | None,
        sink: EventSink,
        secrets: Secrets | None = None,
    ):
        self.plan = plan
        self.run_id = run_id
        #: The text the run was started with (None → the trigger's default input).
        self.input = input
        self.sink = sink
        self.secrets: Secrets = secrets or NoSecrets()
        self.outputs: dict[str, Any] = {}
        #: Loop id → how many times it has started its body (see the runner).
        self.iterations: dict[str, int] = {}
        #: Data edges that delivered into each node.
        self.delivered: dict[str, list[PlanEdge]] = {}

    def input_of(self, node_id: str) -> Any:
        senders = list(dict.fromkeys(e.source for e in self.delivered.get(node_id, [])))
        if not senders:
            return self.input
        if len(senders) == 1:
            return self.outputs.get(senders[0])
        return {self.plan.node(s).ref: self.outputs.get(s) for s in senders}

    def node(self, node_id: str, *, input: Any = MISSING) -> "NodeContext":
        """The context for running `node_id`. `input` overrides what `{{input}}` is (a tool's
        input is the arguments its agent called it with)."""
        return NodeContext(self, self.plan.node(node_id), input=input)


class NodeContext:
    """What an executor sees: its node, resolved input and config, and event helpers."""

    def __init__(self, run: RunContext, node: PlannedNode, *, input: Any = MISSING) -> None:
        self.run = run
        self.node = node
        self._input = input

    @property
    def input(self) -> Any:
        if self._input is not MISSING:
            return self._input
        return self.run.input_of(self.node.id)

    def emit(self, event: dict[str, Any]) -> None:
        self.run.sink(event)

    @property
    def data(self) -> dict[str, Any]:
        return self.node.data

    @property
    def iteration(self) -> int:
        """For a Loop: how many times its body has run so far (0 when it first starts)."""
        return self.run.iterations.get(self.node.id, 0)

    def _resolve(self, part: InputPart | RefPart) -> Any:
        if isinstance(part, InputPart):
            value = lookup(self.input, part.path)
            label = "{{" + ".".join(["input", *part.path]) + "}}"
            if value is MISSING:
                self.log(f"{label} has no value", "warning")
            return value
        label = "{{" + ".".join([part.node, "output", *part.path]) + "}}"
        node_id = self.run.plan.names.get(part.node)
        if node_id is None or node_id not in self.run.outputs:
            # Validation guarantees the node exists and runs earlier — unless it was skipped.
            self.log(f"{label} has no value: that node didn't run", "warning")
            return MISSING
        value = lookup(self.run.outputs[node_id], part.path)
        if value is MISSING:
            self.log(f"{label} has no value", "warning")
        return value

    def render(self, template: str, escape: Callable[[str, str], str] | None = None) -> str:
        """`template` with every reference replaced by its value as text. `escape(value, before)`
        can adapt each value to where it lands (`before`: everything rendered so far)."""
        out: list[str] = []
        for part in parse_template(template):
            if isinstance(part, TextPart):
                out.append(part.value)
            elif isinstance(part, InvalidPart):
                out.append(part.raw)  # validation rejects these; never guess
            else:
                text = to_text(self._resolve(part))
                out.append(escape(text, "".join(out)) if escape else text)
        return "".join(out)

    def value(self, template: str) -> Any:
        """Like `render`, but a template that is exactly one reference (whitespace around it is
        fine) gives the referenced value itself — an object stays an object."""
        parts = [
            p
            for p in parse_template(template)
            if not (isinstance(p, TextPart) and not p.value.strip())
        ]
        if len(parts) == 1 and isinstance(parts[0], InputPart | RefPart):
            value = self._resolve(parts[0])
            return None if value is MISSING else value
        return self.render(template)

    def field(self, key: str) -> str:
        """A templated config field, rendered."""
        raw = self.data.get(key)
        return self.render(raw) if isinstance(raw, str) else to_text(raw)

    def token(self, text: str) -> None:
        if text:
            self.run.sink(events.token(self.node.id, text))

    def log(self, message: str, level: LogLevel = "info") -> None:
        self.run.sink(events.log(message, level, self.node.id))
