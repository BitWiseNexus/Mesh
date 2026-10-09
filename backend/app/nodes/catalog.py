"""The node catalog: the single source of truth for what each node type is.

Labels, descriptions, connection handles, config fields (with defaults, required flags and limits)
and availability live here. The frontend consumes a generated copy
(`frontend/src/lib/nodes/catalog.json`, written by `python -m app.nodes.export_catalog`) and only
adds presentation (icons, card summaries). The execution engine validates flows against it.

Handle conventions (ids are shared with the frontend and the engine):
- `in` / `out`     data flow (target / source)
- `tools`          agent-side source handle for `tool_connection` edges
- `tool`           tool-side target handle for `tool_connection` edges
- branch outputs   `true`/`false` (If), `loop`/`done` (Loop), `approved`/`rejected` (Approval)
"""

from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from app.schemas.flow import RESERVED_REFS
from app.schemas.node_types import NodeCategory, NodeType, category_of


class _Spec(BaseModel):
    # camelCase on the wire to match the frontend's TypeScript types.
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True)


class HandleSpec(_Spec):
    id: str
    kind: Literal["data", "tool"]
    label: str | None = None


class OptionSpec(_Spec):
    value: str
    label: str


#: `knowledge_base` holds the id of one of the user's knowledge bases (picked from a list);
#: `credential` the id of one of their saved API keys (empty = automatic, see `providers`).
FieldKind = Literal[
    "text", "textarea", "code", "number", "select", "switch", "json", "knowledge_base", "credential"
]


class FieldSpec(_Spec):
    """A config field. `key` is the property in `node.data`."""

    key: str
    label: str
    kind: FieldKind
    help: str | None = None
    placeholder: str | None = None
    #: Empty values are reported by flow validation and block running the flow.
    required: bool = False
    #: Accepts {{references}} to other nodes' outputs (see app/engine/references.py). The editor
    #: offers a reference picker and validates references in these fields.
    templated: bool = False
    # kind-specific
    suggestions: list[str] | None = None  # text
    rows: int | None = None  # textarea, code, json
    language: str | None = None  # code
    min: int | float | None = None  # number
    max: int | float | None = None  # number
    step: int | float | None = None  # number
    options: list[OptionSpec] | None = None  # select
    shape: Literal["object", "array"] | None = None  # json
    providers: list[str] | None = None  # credential: which saved keys fit

    @model_validator(mode="after")
    def _kind_specific(self) -> Self:
        if self.kind == "select" and not self.options:
            raise ValueError(f"select field {self.key!r} needs options")
        if self.kind == "code" and not self.language:
            raise ValueError(f"code field {self.key!r} needs a language")
        if self.kind == "credential" and not self.providers:
            raise ValueError(f"credential field {self.key!r} needs providers")
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError(f"field {self.key!r}: min > max")
        if self.templated and self.kind not in ("text", "textarea"):
            raise ValueError(f"field {self.key!r}: only text fields can be templated")
        return self


class NodeSpec(_Spec):
    type: NodeType
    category: NodeCategory
    label: str
    description: str
    #: Base of the readable reference name new nodes get (`agent`, then `agent_2`, …).
    ref_prefix: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    #: What `{{ref.output}}` holds once the node has run — the engine's output contract for this
    #: type, also shown in the editor's reference picker.
    output_hint: str
    #: Target handles (left/top of the node).
    inputs: list[HandleSpec]
    #: Source handles (right/bottom of the node).
    outputs: list[HandleSpec]
    default_data: dict[str, Any] = Field(default_factory=dict)
    fields: list[FieldSpec] = Field(default_factory=list)
    #: Not executable yet (lands after the first runnable release, Phases 3–6): the palette shows
    #: a "Soon" badge and flow validation rejects it. Remove when the node's executor ships.
    coming_soon: bool = False
    #: Retired node type: hidden from the palette, still loads and renders (so saved flows keep
    #: opening), and flow validation reports this message telling the user what replaced it.
    deprecated: str | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.ref_prefix in RESERVED_REFS:
            raise ValueError(f"{self.type}: ref prefix {self.ref_prefix!r} is reserved")
        if category_of(self.type) is not self.category:
            raise ValueError(f"{self.type}: category {self.category} doesn't match its type")
        for side in (self.inputs, self.outputs):
            ids = [h.id for h in side]
            if len(set(ids)) != len(ids):
                raise ValueError(f"{self.type}: duplicate handle ids {ids}")
        missing = [f.key for f in self.fields if f.key not in self.default_data]
        if missing:
            raise ValueError(f"{self.type}: fields without a default value: {missing}")
        if self.category is NodeCategory.TOOL and (
            [h.id for h in self.inputs] != ["tool"] or self.outputs
        ):
            raise ValueError(f"{self.type}: tool nodes only have a 'tool' input handle")
        for f in self.fields:
            default = self.default_data[f.key]
            if f.options and default not in {o.value for o in f.options}:
                raise ValueError(f"{self.type}.{f.key}: default {default!r} isn't an option")
        return self


# ── Building blocks ───────────────────────────────────────────────────────────

IN = HandleSpec(id="in", kind="data")
OUT = HandleSpec(id="out", kind="data")
TOOLS = HandleSpec(id="tools", kind="tool", label="Tools")
TOOL = HandleSpec(id="tool", kind="tool")

TEMPLATE_HELP = "Use {{input}} for the previous node's output, or insert another node's output."

# Suggestions only — any LiteLLM model string is accepted. Revisit with the LLM layer (3.8).
MODEL_SUGGESTIONS = [
    "gpt-4o",
    "gpt-4o-mini",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-4-5",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
]


def options(*values: str) -> list[OptionSpec]:
    return [OptionSpec(value=v, label=v) for v in values]


def text(key: str, label: str, **kw: Any) -> FieldSpec:
    return FieldSpec(key=key, label=label, kind="text", **kw)


def textarea(key: str, label: str, **kw: Any) -> FieldSpec:
    return FieldSpec(key=key, label=label, kind="textarea", **kw)


def number(key: str, label: str, min: float, max: float, step: float = 1, **kw: Any) -> FieldSpec:
    return FieldSpec(key=key, label=label, kind="number", min=min, max=max, step=step, **kw)


#: Every node that can be attached to an agent's Tools handle has one.
TOOL_DESCRIPTION = textarea(
    "tool_description",
    "Description for the agent",
    rows=2,
    placeholder="When should the agent use this, and what does it return?",
    help="Used when an agent calls this node as a tool. Leave empty for a default description.",
)


def with_tool_description(fields: list[FieldSpec], default_data: dict[str, Any]) -> dict[str, Any]:
    return {
        "fields": [*fields, TOOL_DESCRIPTION],
        "default_data": {**default_data, "tool_description": ""},
    }


def credential(key: str, label: str, providers: list[str], **kw: Any) -> FieldSpec:
    return FieldSpec(key=key, label=label, kind="credential", providers=providers, **kw)


def agent_fields(*extra: FieldSpec) -> list[FieldSpec]:
    return [
        text("model", "Model", suggestions=MODEL_SUGGESTIONS, required=True),
        credential(
            "credential_id",
            "API key",
            ["openai", "anthropic", "gemini"],
            help="Automatic uses your saved key for the model's provider, or the server's.",
        ),
        textarea(
            "system_prompt",
            "System prompt",
            rows=6,
            placeholder="You are a helpful assistant…",
            templated=True,
        ),
        textarea(
            "prompt",
            "Task",
            rows=3,
            templated=True,
            help="The message the agent answers. {{input}} is the previous node's output.",
        ),
        number("temperature", "Temperature", 0, 2, 0.1),
        *extra,
    ]


def trigger(**kw: Any) -> NodeSpec:
    return NodeSpec(category=NodeCategory.TRIGGER, inputs=[], outputs=[OUT], **kw)


def step(category: NodeCategory, **kw: Any) -> NodeSpec:
    return NodeSpec(category=category, inputs=[IN], outputs=[OUT], **kw)


def tool(*, fields: list[FieldSpec], default_data: dict[str, Any], **kw: Any) -> NodeSpec:
    return NodeSpec(
        category=NodeCategory.TOOL,
        inputs=[TOOL],
        outputs=[],
        **with_tool_description(fields, default_data),
        **kw,
    )


def action(**kw: Any) -> NodeSpec:
    """Actions pass their result on (`out`) so they can be chained."""
    return NodeSpec(category=NodeCategory.ACTION, inputs=[IN], outputs=[OUT], **kw)


T = NodeType

# ── The catalog (palette order within each category) ─────────────────────────

_SPECS: list[NodeSpec] = [
    # Triggers
    trigger(
        type=T.TRIGGER_MANUAL,
        ref_prefix="trigger",
        output_hint="The input text you run the flow with",
        label="Manual Trigger",
        description="Start the flow with a button click, optionally with input text.",
        default_data={"input": ""},
        fields=[
            textarea("input", "Default input", help="Text passed into the flow when you press Run.")
        ],
    ),
    trigger(
        type=T.TRIGGER_WEBHOOK,
        ref_prefix="webhook",
        output_hint="The request: {body, query, headers}",
        coming_soon=True,
        label="Webhook",
        description="Start the flow when an HTTP request hits this flow's URL.",
        default_data={"method": "POST", "secret": ""},
        fields=[
            FieldSpec(
                key="method", label="Method", kind="select", options=options("POST", "GET", "PUT")
            ),
            text(
                "secret",
                "Secret",
                help="Optional. Callers must send it in the X-Mesh-Secret header.",
            ),
        ],
    ),
    trigger(
        type=T.TRIGGER_CRON,
        ref_prefix="schedule",
        output_hint="When it fired: {scheduled_at}",
        coming_soon=True,
        label="Schedule",
        description="Run on a cron schedule.",
        default_data={"cron": "0 9 * * *", "timezone": "UTC"},
        fields=[
            text(
                "cron", "Cron expression", required=True, help="e.g. 0 9 * * 1-5 = 9:00 on weekdays"
            ),
            text("timezone", "Timezone", placeholder="UTC"),
        ],
    ),
    trigger(
        type=T.TRIGGER_EMAIL,
        ref_prefix="inbox",
        output_hint="The email: {from, subject, text}",
        coming_soon=True,
        label="Email Listener",
        description="Start the flow when an email arrives.",
        default_data={"filter_from": "", "filter_subject": ""},
        fields=[text("filter_from", "From contains"), text("filter_subject", "Subject contains")],
    ),
    # Agents
    NodeSpec(
        type=T.AGENT_NODE,
        ref_prefix="agent",
        output_hint="The agent's reply (text)",
        category=NodeCategory.AGENT,
        inputs=[IN, TOOL],  # TOOL: attachable to another agent as a tool / worker
        outputs=[OUT, TOOLS],
        label="Agent",
        description="An LLM with a system prompt that can call connected tools.",
        **with_tool_description(
            agent_fields(
                number(
                    "max_tool_steps",
                    "Max tool steps",
                    1,
                    25,
                    help="Rounds of tool calls the agent may make before it has to answer.",
                )
            ),
            {
                "model": "gpt-4o",
                "credential_id": None,
                "system_prompt": "",
                "prompt": "{{input}}",
                "temperature": 0.7,
                "max_tool_steps": 5,
            },
        ),
    ),
    NodeSpec(
        type=T.AGENT_SUPERVISOR,
        ref_prefix="supervisor",
        output_hint="The combined answer (text)",
        coming_soon=True,
        category=NodeCategory.AGENT,
        inputs=[IN, TOOL],  # TOOL: attachable to another agent as a tool / worker
        outputs=[OUT, TOOLS],
        label="Supervisor Agent",
        description="Delegates sub-tasks to connected worker agents and combines their results.",
        **with_tool_description(
            agent_fields(number("max_rounds", "Max delegation rounds", 1, 20)),
            {
                "model": "gpt-4o",
                "credential_id": None,
                "system_prompt": "",
                "prompt": "{{input}}",
                "temperature": 0.3,
                "max_rounds": 5,
            },
        ),
    ),
    # Tools (attached to agents via tool_connection)
    tool(
        type=T.TOOL_WEB_SEARCH,
        ref_prefix="web_search",
        output_hint="Search results: [{title, url, snippet}]",
        label="Web Search",
        description="Search the web (Tavily or DuckDuckGo).",
        default_data={"provider": "tavily", "max_results": 5},
        fields=[
            FieldSpec(
                key="provider",
                label="Provider",
                kind="select",
                options=[
                    OptionSpec(value="tavily", label="Tavily"),
                    OptionSpec(value="duckduckgo", label="DuckDuckGo"),
                ],
            ),
            number("max_results", "Max results", 1, 20),
        ],
    ),
    tool(
        type=T.TOOL_WEB_SCRAPER,
        ref_prefix="scraper",
        output_hint="The page: {url, title, text}",
        label="Web Scraper",
        description="Fetch a URL and extract its readable content.",
        default_data={"max_chars": 20000},
        fields=[number("max_chars", "Max characters", 500, 200000, 500)],
    ),
    tool(
        type=T.TOOL_PYTHON,
        ref_prefix="python",
        output_hint="The value main() returned",
        coming_soon=True,
        label="Python Code",
        description="Run Python code in a sandbox.",
        default_data={"code": "", "timeout_seconds": 30},
        fields=[
            FieldSpec(
                key="code",
                label="Code",
                kind="code",
                required=True,
                language="python",
                rows=10,
                placeholder="def main(input: str) -> str:\n    return input.upper()",
            ),
            number("timeout_seconds", "Timeout (s)", 1, 300),
        ],
    ),
    tool(
        type=T.TOOL_HTTP,
        ref_prefix="api",
        output_hint="The response: {status, body}",
        label="API Caller",
        description="Call a REST API endpoint.",
        default_data={
            "method": "GET",
            "url": "",
            "headers": {},
            "body": "",
            "credential_id": None,
            "credential_header": "Authorization",
        },
        fields=[
            FieldSpec(
                key="method",
                label="Method",
                kind="select",
                options=options("GET", "POST", "PUT", "PATCH", "DELETE"),
            ),
            text(
                "url",
                "URL",
                required=True,
                placeholder="https://api.example.com/items",
                templated=True,
            ),
            FieldSpec(key="headers", label="Headers", kind="json", rows=4, shape="object"),
            textarea("body", "Body", help=TEMPLATE_HELP, templated=True),
            credential(
                "credential_id",
                "API key",
                ["http"],
                help="Optional. Sent with every request, never shown to the agent.",
            ),
            text(
                "credential_header",
                "Send the key in header",
                placeholder="Authorization",
                help="Authorization sends “Bearer <key>”; any other header gets the key as is.",
            ),
        ],
    ),
    # Knowledge / RAG
    # Knowledge bases themselves (documents, sources, chunking, embeddings) are managed on the
    # Knowledge Bases page; flows only read from (Retriever) or add to (kb_upload) one.
    step(
        NodeCategory.KNOWLEDGE,
        type=T.KB_UPLOAD,  # id kept from "Document Upload" so saved flows still load
        ref_prefix="kb_add",
        output_hint="The stored document: {id, chunks}",
        coming_soon=True,
        label="Add to Knowledge Base",
        description="Store text produced in this flow (e.g. a scraped page) in a knowledge base.",
        default_data={"knowledge_base_id": None, "title": "", "content": "{{input}}"},
        fields=[
            FieldSpec(
                key="knowledge_base_id",
                label="Knowledge base",
                kind="knowledge_base",
                required=True,
            ),
            text("title", "Document title", templated=True, placeholder="Defaults to the run time"),
            textarea("content", "Content", rows=4, templated=True, required=True),
        ],
    ),
    NodeSpec(
        type=T.KB_RETRIEVER,
        ref_prefix="retriever",
        output_hint="Matching chunks: [{text, source, score}]",
        coming_soon=True,
        category=NodeCategory.KNOWLEDGE,
        inputs=[IN, TOOL],
        outputs=[OUT],
        label="Retriever",
        description="Find relevant chunks in a knowledge base. Works as a step or an agent tool.",
        default_data={"knowledge_base_id": None, "query": "{{input}}", "top_k": 4},
        fields=[
            FieldSpec(
                key="knowledge_base_id",
                label="Knowledge base",
                kind="knowledge_base",
                required=True,
            ),
            textarea(
                "query",
                "Query",
                rows=2,
                templated=True,
                help="What to search for. When an agent uses this as a tool, it writes the query.",
            ),
            number("top_k", "Results (top k)", 1, 20),
        ],
    ),
    step(
        NodeCategory.KNOWLEDGE,
        type=T.KB_NOTION,
        ref_prefix="notion",
        output_hint="The pages' text",
        coming_soon=True,
        deprecated=(
            "Notion is now a knowledge-base source: add it to a knowledge base and use a "
            "Retriever node instead"
        ),
        label="Notion",
        description="Load pages from Notion.",
        default_data={"page_ids": []},
        fields=[
            FieldSpec(
                key="page_ids",
                label="Page IDs",
                kind="json",
                rows=3,
                shape="array",
                help="JSON array of page IDs.",
            )
        ],
    ),
    step(
        NodeCategory.KNOWLEDGE,
        type=T.KB_GDRIVE,
        ref_prefix="drive",
        output_hint="The files' text",
        coming_soon=True,
        deprecated=(
            "Google Drive is now a knowledge-base source: add it to a knowledge base and use a "
            "Retriever node instead"
        ),
        label="Google Drive",
        description="Load files from Google Drive.",
        default_data={"folder_id": ""},
        fields=[text("folder_id", "Folder ID", required=True)],
    ),
    # Logic / human-in-the-loop
    NodeSpec(
        type=T.LOGIC_IF,
        ref_prefix="if",
        output_hint="Its input, passed through unchanged",
        category=NodeCategory.LOGIC,
        inputs=[IN],
        outputs=[
            HandleSpec(id="true", kind="data", label="True"),
            HandleSpec(id="false", kind="data", label="False"),
        ],
        label="If / Else",
        description="Branch based on a condition.",
        default_data={"field": "{{input}}", "operator": "contains", "value": ""},
        fields=[
            text("field", "Value to check", required=True, help=TEMPLATE_HELP, templated=True),
            FieldSpec(
                key="operator",
                label="Operator",
                kind="select",
                help="Text is compared ignoring upper/lower case and surrounding spaces. "
                "Greater / less than compare numbers.",
                options=[
                    OptionSpec(value="equals", label="equals"),
                    OptionSpec(value="not_equals", label="does not equal"),
                    OptionSpec(value="contains", label="contains"),
                    OptionSpec(value="not_contains", label="does not contain"),
                    OptionSpec(value="greater_than", label="greater than"),
                    OptionSpec(value="less_than", label="less than"),
                    OptionSpec(value="is_empty", label="is empty"),
                    OptionSpec(value="is_not_empty", label="is not empty"),
                ],
            ),
            text("value", "Compare to", templated=True),
        ],
    ),
    NodeSpec(
        type=T.LOGIC_LOOP,
        ref_prefix="loop",
        output_hint="This iteration's input",
        category=NodeCategory.LOGIC,
        inputs=[IN],
        outputs=[
            HandleSpec(id="loop", kind="data", label="Loop"),
            HandleSpec(id="done", kind="data", label="Done"),
        ],
        label="Loop",
        description="Repeat a branch until a condition is met or the iteration limit is hit.",
        default_data={"max_iterations": 5, "until": ""},
        fields=[
            number("max_iterations", "Max iterations", 1, 100),
            text(
                "until",
                "Stop when output contains",
                templated=True,
                help="Checked on what comes back from the loop (ignoring upper/lower case). "
                "Leave empty to always run the maximum number of iterations.",
            ),
        ],
    ),
    NodeSpec(
        type=T.HITL_APPROVAL,
        ref_prefix="approval",
        output_hint="Its input, as approved (and possibly edited) by the reviewer",
        category=NodeCategory.LOGIC,
        inputs=[IN],
        outputs=[
            HandleSpec(id="approved", kind="data", label="Approved"),
            HandleSpec(id="rejected", kind="data", label="Rejected"),
        ],
        label="Approval Gate",
        description="Pause the flow until a person approves or rejects.",
        default_data={"message": "Please review", "allow_edit": True},
        fields=[
            textarea("message", "Message to reviewer", rows=3, templated=True),
            FieldSpec(key="allow_edit", label="Reviewer can edit the content", kind="switch"),
        ],
    ),
    # Actions / outputs
    action(
        type=T.ACTION_EMAIL,
        ref_prefix="email",
        output_hint="The sent message: {id}",
        coming_soon=True,
        label="Send Email",
        description="Send an email (Resend).",
        default_data={"to": "", "subject": "", "body": "{{input}}"},
        fields=[
            text("to", "To", required=True, placeholder="someone@example.com", templated=True),
            text("subject", "Subject", required=True, templated=True),
            textarea("body", "Body", rows=5, help=TEMPLATE_HELP, templated=True),
        ],
    ),
    action(
        type=T.ACTION_SLACK,
        ref_prefix="slack",
        output_hint="The posted message: {ts, channel}",
        coming_soon=True,
        label="Slack Message",
        description="Post a message to a Slack channel.",
        default_data={"channel": "", "text": "{{input}}"},
        fields=[
            text("channel", "Channel", required=True, placeholder="#general", templated=True),
            textarea("text", "Message", rows=4, help=TEMPLATE_HELP, templated=True),
        ],
    ),
    action(
        type=T.ACTION_TELEGRAM,
        ref_prefix="telegram",
        output_hint="The sent message: {message_id}",
        coming_soon=True,
        label="Telegram Message",
        description="Send a Telegram message.",
        default_data={"chat_id": "", "text": "{{input}}"},
        fields=[
            text("chat_id", "Chat ID", required=True),
            textarea("text", "Message", rows=4, help=TEMPLATE_HELP, templated=True),
        ],
    ),
    action(
        type=T.ACTION_HTTP_RESPONSE,
        ref_prefix="response",
        output_hint="The response that was sent",
        coming_soon=True,
        label="HTTP Response",
        description="Reply to the webhook caller.",
        default_data={"status_code": 200, "body": "{{input}}"},
        fields=[
            number("status_code", "Status code", 100, 599),
            textarea("body", "Body", rows=4, help=TEMPLATE_HELP, templated=True),
        ],
    ),
    action(
        type=T.ACTION_DB_WRITE,
        ref_prefix="db_write",
        output_hint="The written document: {id}",
        coming_soon=True,
        label="Database Write",
        description="Write a document to a Firestore collection.",
        default_data={"collection": "", "document": "{{input}}"},
        fields=[
            text("collection", "Collection", required=True, templated=True),
            textarea("document", "Document", rows=4, help=TEMPLATE_HELP, templated=True),
        ],
    ),
    NodeSpec(
        type=T.OUTPUT_DISPLAY,
        ref_prefix="result",
        output_hint="The value it displays (its input)",
        category=NodeCategory.ACTION,
        inputs=[IN],
        outputs=[],
        label="Output",
        description="Show the result in the run panel.",
    ),
]

CATALOG: dict[NodeType, NodeSpec] = {spec.type: spec for spec in _SPECS}

if len(CATALOG) != len(_SPECS) or set(CATALOG) != set(NodeType):
    raise RuntimeError("The node catalog must define every NodeType exactly once")


def get_spec(node_type: NodeType) -> NodeSpec:
    return CATALOG[node_type]
