"""Outbound HTTP guard (app/net.py) and the API Caller tool. No real network: mocked transport
and DNS."""

import asyncio
import json
from typing import Any

import httpx
import pytest

import app.net as net
from app.core.config import Settings
from app.engine.executor import NodeError
from app.net import FetchError, check_url, fetch
from app.nodes.executors.http import escape_json_strings, escape_url
from tests.flows import node
from tests.test_web_tools import mock_http, run_tool

PUBLIC = "93.184.215.14"


@pytest.fixture
def strict(monkeypatch: pytest.MonkeyPatch) -> dict[str, set[str]]:
    """Private networks disallowed (production behaviour); DNS answers from the returned dict."""
    monkeypatch.setattr(
        net, "get_settings", lambda: Settings(outbound_allow_private_networks=False)
    )
    dns: dict[str, set[str]] = {"api.example.com": {PUBLIC}}

    async def resolve(host: str, port: int) -> set[str]:
        if host not in dns:
            raise OSError("not found")
        return dns[host]

    monkeypatch.setattr(net, "_resolve", resolve)
    return dns


def check(url: str) -> None:
    asyncio.run(check_url(url))


class TestCheckUrl:
    @pytest.mark.parametrize(
        ("host", "addresses"),
        [
            ("localhost", {"127.0.0.1"}),
            ("internal", {"10.0.0.5"}),
            ("metadata", {"169.254.169.254"}),
            ("v6local", {"::1"}),
            ("mapped", {"::ffff:192.168.1.1"}),
            ("mixed", {PUBLIC, "192.168.0.10"}),  # every address must be public
        ],
    )
    def test_private_addresses_are_refused(
        self, strict: dict[str, set[str]], host: str, addresses: set[str]
    ) -> None:
        strict[host] = addresses
        with pytest.raises(FetchError, match="private or local address"):
            check(f"http://{host}/x")

    def test_literal_ips_are_checked_too(self, strict: dict[str, set[str]]) -> None:
        strict["127.0.0.1"] = {"127.0.0.1"}
        with pytest.raises(FetchError, match="private or local"):
            check("http://127.0.0.1:8000/health")

    def test_public_hosts_pass(self, strict: dict[str, set[str]]) -> None:
        check("https://api.example.com/items")

    @pytest.mark.parametrize(
        ("url", "message"),
        [
            ("ftp://api.example.com/x", "Only http and https"),
            ("file:///etc/passwd", "Only http and https"),
            ("http:///nohost", "has no host"),
            ("https://unknown.example/x", "Couldn't find the host"),
        ],
    )
    def test_bad_urls(self, strict: dict[str, set[str]], url: str, message: str) -> None:
        with pytest.raises(FetchError, match=message):
            check(url)

    def test_private_networks_can_be_allowed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            net, "get_settings", lambda: Settings(outbound_allow_private_networks=True)
        )
        check("http://127.0.0.1:8000/health")  # no DNS lookup, no error

    def test_private_networks_default_to_off_only_in_production(self) -> None:
        assert Settings().allow_private_networks is True
        prod = Settings(environment="production", use_firebase_emulators=False)
        assert prod.allow_private_networks is False


def get(url: str, **kwargs: Any) -> net.Fetched:
    return asyncio.run(fetch("GET", url, **kwargs))


class TestFetch:
    def test_redirects_are_followed_and_checked(
        self, monkeypatch: pytest.MonkeyPatch, strict: dict[str, set[str]]
    ) -> None:
        strict["evil.example"] = {"10.1.2.3"}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/start":
                return httpx.Response(302, headers={"location": "/next"})
            if request.url.path == "/next":
                return httpx.Response(301, headers={"location": "http://evil.example/admin"})
            return httpx.Response(200, text="should not get here")

        seen = mock_http(monkeypatch, "app.net", handler)
        with pytest.raises(FetchError, match="“evil.example” is a private"):
            get("https://api.example.com/start")
        assert [r.url.path for r in seen] == ["/start", "/next"]

    def test_303_switches_to_get(
        self, monkeypatch: pytest.MonkeyPatch, strict: dict[str, set[str]]
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST":
                return httpx.Response(303, headers={"location": "/result"})
            return httpx.Response(200, json={"ok": True})

        seen = mock_http(monkeypatch, "app.net", handler)
        response = asyncio.run(fetch("POST", "https://api.example.com/jobs", content="x"))
        assert response.status == 200 and response.url == "https://api.example.com/result"
        assert [(r.method, r.content) for r in seen] == [("POST", b"x"), ("GET", b"")]

    def test_too_many_redirects(
        self, monkeypatch: pytest.MonkeyPatch, strict: dict[str, set[str]]
    ) -> None:
        mock_http(
            monkeypatch, "app.net", lambda r: httpx.Response(302, headers={"location": "/again"})
        )
        with pytest.raises(FetchError, match="Too many redirects"):
            get("https://api.example.com/loop")

    def test_bodies_are_capped(
        self, monkeypatch: pytest.MonkeyPatch, strict: dict[str, set[str]]
    ) -> None:
        monkeypatch.setattr(net, "MAX_RESPONSE_BYTES", 10)
        mock_http(monkeypatch, "app.net", lambda r: httpx.Response(200, content=b"x" * 50))
        response = get("https://api.example.com/big")
        assert response.body == b"x" * 10 and response.truncated

    def test_text_uses_the_declared_charset(
        self, monkeypatch: pytest.MonkeyPatch, strict: dict[str, set[str]]
    ) -> None:
        mock_http(
            monkeypatch,
            "app.net",
            lambda r: httpx.Response(
                200,
                content="café".encode("latin-1"),
                headers={"content-type": 'text/plain; charset="latin-1"'},
            ),
        )
        response = get("https://api.example.com/t")
        assert response.text() == "café" and response.content_type == "text/plain"

    def test_network_errors(
        self, monkeypatch: pytest.MonkeyPatch, strict: dict[str, set[str]]
    ) -> None:
        def fail(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("slow")

        mock_http(monkeypatch, "app.net", fail)
        with pytest.raises(FetchError, match="didn't answer in time"):
            get("https://api.example.com/slow")


@pytest.mark.parametrize(
    ("value", "before", "expected"),
    [
        ("a b&c", "https://x.io/?q=", "a%20b%26c"),
        ("https://other.io/p?x=1", "", "https://other.io/p?x=1"),  # starts the URL: as is
        ("a/b", "https://x.io/items/", "a%2Fb"),
    ],
)
def test_escape_url(value: str, before: str, expected: str) -> None:
    assert escape_url(value, before) == expected


@pytest.mark.parametrize(
    ("before", "expected"),
    [
        ('{"name": "', 'say \\"hi\\"\\nnow'),  # inside a string literal: escaped
        ('{"name": "a", "count": ', 'say "hi"\nnow'),  # outside one: as is
        ('{"q": "it\\"s ', 'say \\"hi\\"\\nnow'),  # an escaped quote doesn't end the string
    ],
)
def test_escape_json_strings(before: str, expected: str) -> None:
    assert escape_json_strings('say "hi"\nnow', before) == expected


ARTICLE = """<html><head><title>Mesh news</title></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article><h1>Flows now run</h1>
<p>Mesh flows execute on the backend and stream their progress to the editor in real time.</p>
<p>Agents can call tools such as web search, API calls and page scraping while they work.</p>
<p>Every run is recorded, so its outputs can be reviewed after it finishes.</p>
</article><footer>Copyright Mesh</footer></body></html>"""


class TestWebScraper:
    def test_reads_the_main_content_of_a_page(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/old":
                return httpx.Response(301, headers={"location": "/news"})
            return httpx.Response(200, text=ARTICLE, headers={"content-type": "text/html"})

        seen = mock_http(monkeypatch, "app.net", handler)
        result, _ = run_tool(node("s", "tool_web_scraper"), {"url": "https://example.com/old"})
        page = result.output
        assert page["url"] == "https://example.com/news"
        assert page["title"] == "Flows now run"  # the headline wins over <title>
        assert "Flows now run" in page["text"] and "stream their progress" in page["text"]
        assert "Copyright" not in page["text"]
        assert "truncated" not in page
        assert "text/html" in seen[0].headers["Accept"]

    def test_text_and_json_are_returned_as_they_are(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mock_http(
            monkeypatch,
            "app.net",
            lambda r: httpx.Response(
                200, json={"a": 1}, headers={"content-type": "application/json"}
            ),
        )
        result, _ = run_tool(node("s", "tool_web_scraper"), {"url": "https://example.com/x.json"})
        assert result.output == {
            "url": "https://example.com/x.json",
            "title": "",
            "text": '{"a":1}',
        }

    def test_long_pages_are_cut_at_max_chars(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mock_http(monkeypatch, "app.net", lambda r: httpx.Response(200, text="y" * 3000))
        result, _ = run_tool(
            node("s", "tool_web_scraper", max_chars=1000), {"url": "https://example.com/t.txt"}
        )
        assert result.output["text"] == "y" * 1000 and result.output["truncated"] is True

    @pytest.mark.parametrize(
        ("response", "message"),
        [
            (httpx.Response(404, text="gone"), r"error \(404\)"),
            (
                httpx.Response(200, content=b"%PDF", headers={"content-type": "application/pdf"}),
                "Can't read application/pdf",
            ),
        ],
    )
    def test_unreadable_pages(
        self, monkeypatch: pytest.MonkeyPatch, response: httpx.Response, message: str
    ) -> None:
        mock_http(monkeypatch, "app.net", lambda r: response)
        with pytest.raises(NodeError, match=message):
            run_tool(node("s", "tool_web_scraper"), {"url": "https://example.com/doc"})

    def test_private_pages_are_refused(self, strict: dict[str, set[str]]) -> None:
        strict["router.local"] = {"192.168.1.1"}
        with pytest.raises(NodeError, match="private or local"):
            run_tool(node("s", "tool_web_scraper"), {"url": "http://router.local/"})

    def test_a_url_is_required(self) -> None:
        with pytest.raises(NodeError, match="No URL"):
            run_tool(node("s", "tool_web_scraper"), {"url": " "})


class TestApiCaller:
    def test_builds_the_request_from_config_and_arguments(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(201, json={"created": True})

        seen = mock_http(monkeypatch, "app.net", handler)
        result, _ = run_tool(
            node(
                "api",
                "tool_http",
                method="POST",
                url="https://api.example.com/search?q={{input.query}}",
                headers={"X-Team": "core", "X-Retry": 2},
                body='{"note": "{{input.note}}"}',
            ),
            {"query": "a b&c", "note": 'quote " and\nnewline'},
        )
        assert result.output == {"status": 201, "body": {"created": True}}
        [request] = seen
        assert request.method == "POST"
        assert str(request.url) == "https://api.example.com/search?q=a%20b%26c"
        assert request.headers["X-Team"] == "core" and request.headers["X-Retry"] == "2"
        assert request.headers["Content-Type"] == "application/json"
        assert json.loads(request.content) == {"note": 'quote " and\nnewline'}

    def test_error_statuses_are_results_and_text_bodies_stay_text(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        mock_http(monkeypatch, "app.net", lambda r: httpx.Response(404, text="no such order"))
        result, _ = run_tool(
            node("api", "tool_http", url="https://api.example.com/orders/{{input.id}}"),
            {"id": "42"},
        )
        assert result.output == {"status": 404, "body": "no such order"}

    def test_get_requests_send_no_body(self, monkeypatch: pytest.MonkeyPatch) -> None:
        seen = mock_http(monkeypatch, "app.net", lambda r: httpx.Response(200, json=[]))
        run_tool(node("api", "tool_http", url="https://api.example.com/x", body="ignored"), {})
        assert seen[0].content == b"" and "Content-Type" not in seen[0].headers

    def test_refused_urls_fail_the_call(self, strict: dict[str, set[str]]) -> None:
        strict["intranet"] = {"10.0.0.1"}
        with pytest.raises(NodeError, match="private or local address"):
            run_tool(node("api", "tool_http", url="http://intranet/admin"), {})
