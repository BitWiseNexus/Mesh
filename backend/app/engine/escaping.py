"""Escapers for `NodeContext.render(template, escape)`: adapt each referenced value to where it
lands in the rendered text."""

import json
import re
from urllib.parse import quote


def escape_url(value: str, before: str) -> str:
    """A reference in the middle of a URL is encoded (`?q={{input.query}}` with spaces or `&`);
    one that starts the URL (`{{input.url}}`) is used as it is."""
    return quote(value, safe="") if before else value


#: A quote preceded by an even number of backslashes (so not itself escaped).
_UNESCAPED_QUOTE = re.compile(r'(?<!\\)(?:\\\\)*"')


def escape_json_strings(value: str, before: str) -> str:
    """Inside a JSON string literal (`{"id": "{{input.id}}"}`) a value is JSON-escaped, so quotes
    and newlines in it can't break the JSON."""
    inside_string = len(_UNESCAPED_QUOTE.findall(before)) % 2 == 1
    return json.dumps(value, ensure_ascii=False)[1:-1] if inside_string else value


def looks_like_json(template: str) -> bool:
    return template.strip()[:1] in ("{", "[")
