"""Node type catalog. These strings must match the frontend node registry exactly."""

from enum import StrEnum


class NodeCategory(StrEnum):
    TRIGGER = "trigger"
    AGENT = "agent"
    TOOL = "tool"
    KNOWLEDGE = "knowledge"
    LOGIC = "logic"
    ACTION = "action"


class NodeType(StrEnum):
    # Triggers
    TRIGGER_MANUAL = "trigger_manual"
    TRIGGER_WEBHOOK = "trigger_webhook"
    TRIGGER_CRON = "trigger_cron"
    TRIGGER_EMAIL = "trigger_email"
    # Agents
    AGENT_NODE = "agent_node"
    AGENT_SUPERVISOR = "agent_supervisor"
    # Tools
    TOOL_WEB_SEARCH = "tool_web_search"
    TOOL_WEB_SCRAPER = "tool_web_scraper"
    TOOL_PYTHON = "tool_python"
    TOOL_HTTP = "tool_http"
    # Knowledge / RAG
    KB_UPLOAD = "kb_upload"
    KB_RETRIEVER = "kb_retriever"
    KB_NOTION = "kb_notion"
    KB_GDRIVE = "kb_gdrive"
    # Logic / human-in-the-loop
    LOGIC_IF = "logic_if"
    LOGIC_LOOP = "logic_loop"
    HITL_APPROVAL = "hitl_approval"
    # Actions / outputs
    ACTION_EMAIL = "action_email"
    ACTION_SLACK = "action_slack"
    ACTION_TELEGRAM = "action_telegram"
    ACTION_HTTP_RESPONSE = "action_http_response"
    ACTION_DB_WRITE = "action_db_write"
    OUTPUT_DISPLAY = "output_display"


_PREFIX_CATEGORY: dict[str, NodeCategory] = {
    "trigger_": NodeCategory.TRIGGER,
    "agent_": NodeCategory.AGENT,
    "tool_": NodeCategory.TOOL,
    "kb_": NodeCategory.KNOWLEDGE,
    "logic_": NodeCategory.LOGIC,
    "hitl_": NodeCategory.LOGIC,
    "action_": NodeCategory.ACTION,
    "output_": NodeCategory.ACTION,
}


def category_of(node_type: NodeType) -> NodeCategory:
    for prefix, category in _PREFIX_CATEGORY.items():
        if node_type.startswith(prefix):
            return category
    raise ValueError(f"No category for node type {node_type!r}")
