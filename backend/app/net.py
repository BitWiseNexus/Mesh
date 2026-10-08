"""Outbound HTTP for tools that fetch URLs chosen by users or models (API Caller, Web Scraper).

Guards against server-side request forgery: only http(s), and — unless private networks are
allowed (development default, see Settings.allow_private_networks) — the host must resolve to
public addresses only, checked again on every redirect. That keeps flows away from this server
(localhost), the internal network and cloud metadata endpoints (169.254.169.254).

Known limit: the address is checked when resolving, not pinned for the connection, so a DNS
record that changes between the check and the connection (DNS rebinding) isn't caught.
"""

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx

from app.core.config import get_settings

MAX_REDIRECTS = 5
#: Bytes of a response body read at most (the rest is dropped and `truncated` is set).
MAX_RESPONSE_BYTES = 2_000_000
USER_AGENT = "Mesh/0.1 (+https://github.com/BitWiseNexus/Mesh)"


class FetchError(Exception):
    """The request was refused or failed; the message is meant for the user."""


@dataclass(frozen=True)
class Fetched:
    status: int
    headers: httpx.Headers
    body: bytes
    #: The final URL (after redirects).
    url: str
    truncated: bool

    @property
    def content_type(self) -> str:
        return self.headers.get("content-type", "").split(";", 1)[0].strip().lower()

    def text(self) -> str:
        return self.body.decode(self._encoding(), errors="replace")

    def _encoding(self) -> str:
        for part in self.headers.get("content-type", "").split(";")[1:]:
            key, _, value = part.strip().partition("=")
            if key.lower() == "charset" and value:
                return value.strip("\"'")
        return "utf-8"


def _is_public(address: str) -> bool:
    ip = ipaddress.ip_address(address.split("%", 1)[0])  # drop an IPv6 zone id
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


async def _resolve(host: str, port: int) -> set[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return {info[4][0] for info in infos}


async def check_url(url: str) -> None:
    """Raises FetchError unless `url` may be fetched."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise FetchError(f"Only http and https URLs can be fetched, not “{url}”")
    if not parts.hostname:
        raise FetchError(f"“{url}” has no host name")
    if get_settings().allow_private_networks:
        return
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        addresses = await _resolve(parts.hostname, port)
    except OSError as exc:
        raise FetchError(f"Couldn't find the host “{parts.hostname}”") from exc
    if not addresses or not all(_is_public(a) for a in addresses):
        raise FetchError(
            f"“{parts.hostname}” is a private or local address, which flows can't reach"
        )


async def fetch(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    content: str | bytes | None = None,
    request_timeout: float = 30,
) -> Fetched:
    """Sends the request, following redirects (each checked), and reads at most
    MAX_RESPONSE_BYTES of the body."""
    request_headers = {"User-Agent": USER_AGENT, **(headers or {})}
    async with httpx.AsyncClient(follow_redirects=False, timeout=request_timeout) as client:
        for _ in range(MAX_REDIRECTS + 1):
            await check_url(url)
            try:
                async with client.stream(
                    method, url, headers=request_headers, content=content
                ) as response:
                    if response.is_redirect and "location" in response.headers:
                        url = urljoin(url, response.headers["location"])
                        if response.status_code == 303 or (
                            response.status_code in (301, 302) and method not in ("GET", "HEAD")
                        ):
                            method, content = "GET", None
                        continue
                    body = bytearray()
                    truncated = False
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_RESPONSE_BYTES:
                            del body[MAX_RESPONSE_BYTES:]
                            truncated = True
                            break
                    return Fetched(
                        response.status_code, response.headers, bytes(body), url, truncated
                    )
            except httpx.TimeoutException as exc:
                raise FetchError(f"{urlsplit(url).hostname} didn't answer in time") from exc
            except httpx.HTTPError as exc:
                raise FetchError(f"Request to {urlsplit(url).hostname} failed: {exc}") from exc
    raise FetchError(f"Too many redirects (more than {MAX_REDIRECTS})")
