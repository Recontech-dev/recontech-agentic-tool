"""Provider adapters.

Claude goes through the Anthropic SDK. Every other provider exposes an
OpenAI-compatible endpoint, so one adapter covers them all.
"""

import re
from collections.abc import Iterator
from urllib.parse import urlparse

import anthropic
import openai

# Default models are only suggestions shown at /add; free-tier line-ups change often.
PRESETS = {
    "claude": {
        "base_url": None,
        "model": "claude-opus-5-5",
        "needs_key": True,
        "key_url": "https://console.anthropic.com/settings/keys",
    },
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "model": "gemini-2.5-flash",
        "needs_key": True,
        "key_url": "https://aistudio.google.com/apikey",
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "model": "llama-3.3-70b-versatile",
        "needs_key": True,
        "key_url": "https://console.groq.com/keys",
    },
    "cerebras": {
        "base_url": "https://api.cerebras.ai/v1",
        "model": "llama-3.3-70b",
        "needs_key": True,
        "key_url": "https://cloud.cerebras.ai",
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "model": "meta-llama/llama-3.3-70b-instruct:free",
        "needs_key": True,
        "key_url": "https://openrouter.ai/keys",
    },
    "ollama": {
        "base_url": "http://localhost:11434/v1",
        "model": "llama3.2",
        "needs_key": False,
        "key_url": "https://ollama.com/download",
    },
    # Any other OpenAI-compatible endpoint; /add asks for the base URL.
    "custom": {
        "base_url": None,
        "model": "",
        "needs_key": False,
        "key_url": None,
    },
}

RATE_LIMITED = (anthropic.RateLimitError, openai.RateLimitError)
BAD_KEY = (
    anthropic.AuthenticationError,
    anthropic.PermissionDeniedError,
    openai.AuthenticationError,
    openai.PermissionDeniedError,
)
STATUS_ERROR = (anthropic.APIStatusError, openai.APIStatusError)
CONNECTION_ERROR = (anthropic.APIConnectionError, openai.APIConnectionError)

DEFAULT_LIMIT_COOLDOWN = 60
OUT_OF_CREDIT_COOLDOWN = 3600
BAD_KEY_COOLDOWN = 3600
OUTAGE_COOLDOWN = 30

TOO_LONG = re.compile(
    r"too long|too large|context length|context window|maximum context|token limit|reduce the length", re.I
)


class ProviderFailure(Exception):
    """A profile could not answer. `cooldown` is how long to skip it, in seconds."""

    def __init__(self, reason: str, cooldown: float = 0, too_long: bool = False):
        super().__init__(reason)
        self.reason = reason
        self.cooldown = cooldown
        self.too_long = too_long


def is_local(profile: dict) -> bool:
    """True for a model served from this machine or the local network, which works offline."""
    host = urlparse(profile.get("base_url") or "").hostname or ""
    return host in ("localhost", "127.0.0.1", "::1") or host.startswith(("192.168.", "10."))


def needs_key(profile: dict) -> bool:
    return PRESETS.get(profile["provider"], {}).get("needs_key", True)


def _retry_after(error: Exception) -> float:
    headers = getattr(getattr(error, "response", None), "headers", None) or {}
    try:
        return max(float(headers.get("retry-after", "")), 1)
    except ValueError:
        return DEFAULT_LIMIT_COOLDOWN


def _failure(error: Exception) -> ProviderFailure:
    if isinstance(error, RATE_LIMITED):
        # OpenAI-compatible providers also report an exhausted quota as a 429.
        if "quota" in str(error).lower() or "credit" in str(error).lower():
            return ProviderFailure("out of quota", OUT_OF_CREDIT_COOLDOWN)
        wait = _retry_after(error)
        return ProviderFailure(f"rate limited for {wait:.0f}s", wait)
    if isinstance(error, BAD_KEY):
        return ProviderFailure("API key rejected", BAD_KEY_COOLDOWN)
    if isinstance(error, STATUS_ERROR):
        status = error.status_code
        if status == 402 or "credit balance" in str(error).lower():
            return ProviderFailure("out of credit", OUT_OF_CREDIT_COOLDOWN)
        if status >= 500:
            return ProviderFailure(f"provider error {status}", OUTAGE_COOLDOWN)
        if status == 413 or (status == 400 and TOO_LONG.search(str(error))):
            return ProviderFailure("conversation too long for this model", too_long=True)
        # Other 4xx (such as an unknown model) are specific to this request.
        if "anthropic-workspace-id" in str(error):
            return ProviderFailure(
                "this key is not tied to a workspace. Set the workspace with /workspace <profile> <workspace id>, "
                "or create a key inside a workspace in the Anthropic Console",
                BAD_KEY_COOLDOWN,
            )
        return ProviderFailure(f"request rejected ({status}): {getattr(error, 'message', error)}")
    if isinstance(error, CONNECTION_ERROR):
        return ProviderFailure("unreachable", OUTAGE_COOLDOWN)
    raise error


def _stream_claude(profile: dict, key: str, messages: list, system: str) -> Iterator[str]:
    # Organization-wide keys must say which workspace a request belongs to.
    headers = {"anthropic-workspace-id": profile["workspace"]} if profile.get("workspace") else None
    client = anthropic.Anthropic(api_key=key, max_retries=0, default_headers=headers)
    kwargs = {"model": profile["model"], "max_tokens": 64000, "messages": messages}
    if system:
        kwargs["system"] = system
    with client.messages.stream(**kwargs) as stream:
        yield from stream.text_stream
        final = stream.get_final_message()
    if final.stop_reason == "refusal":
        yield "\n[Claude declined this request.]"


def _stream_openai_compatible(profile: dict, key: str | None, messages: list, system: str) -> Iterator[str]:
    client = openai.OpenAI(api_key=key or "none", base_url=profile["base_url"], max_retries=0)
    if system:
        messages = [{"role": "system", "content": system}, *messages]
    stream = client.chat.completions.create(model=profile["model"], messages=messages, stream=True)
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content


def stream_reply(profile: dict, key: str | None, messages: list, system: str = "") -> Iterator[str]:
    """Yield the reply text; raise ProviderFailure when this profile can't answer."""
    adapter = _stream_claude if profile["provider"] == "claude" else _stream_openai_compatible
    try:
        yield from adapter(profile, key, messages, system)
    except (anthropic.APIError, openai.APIError) as error:
        raise _failure(error) from error
