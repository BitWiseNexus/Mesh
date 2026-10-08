"""Node executors, one module per node type. Importing this package registers all of them (see
app/engine/executor.py)."""

from app.nodes.executors import agent, output_display, trigger_manual

__all__ = ["agent", "output_display", "trigger_manual"]
