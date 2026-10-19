"""What nodes that use an outside service (email, Slack, Telegram) share: finding the key, and
their Test mode switch."""

from pydantic import SecretStr

from app.engine.context import NodeContext


async def account_key(
    ctx: NodeContext, provider: str, server_key: SecretStr | None, field: str = "credential_id"
) -> str | None:
    """The saved key chosen in `field`, else the user's newest saved key for `provider`, else the
    server's (an empty server setting counts as none)."""
    chosen = str(ctx.data.get(field) or "") or None
    key = await ctx.run.secrets.get(provider, chosen)
    return key or (server_key.get_secret_value() if server_key else None) or None


def in_test_mode(ctx: NodeContext) -> bool:
    """Test mode shows what would be sent instead of sending it."""
    return ctx.data.get("test_mode") is True
