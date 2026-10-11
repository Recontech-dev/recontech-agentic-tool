"""The failover chain: try profiles in order, skipping any that are cooling down."""

import time

from agentic_lazy_tool import config, providers


class NoProviderAvailable(Exception):
    pass


def trimmed(messages: list[dict]) -> list[dict] | None:
    """Drop the older half of a conversation, keeping a user message first."""
    start = len(messages) // 2
    while start < len(messages) - 1 and messages[start]["role"] != "user":
        start += 1
    return messages[start:] if start else None


class Chain:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.cooldowns: dict[str, float] = {}
        self.replies: dict[str, int] = {}
        self.offline = False
        self.pinned: str | None = None

    @property
    def profiles(self) -> list[dict]:
        return self.cfg["profiles"]

    def find(self, name: str) -> dict | None:
        return next((p for p in self.profiles if p["name"] == name), None)

    def cooldown_left(self, name: str) -> float:
        return max(self.cooldowns.get(name, 0) - time.time(), 0)

    def has_key(self, profile: dict) -> bool:
        return not providers.needs_key(profile) or bool(config.get_key(profile["name"]))

    def usable(self, profile: dict) -> bool:
        return providers.is_local(profile) or not self.offline

    def ready(self) -> list[dict]:
        return [
            p for p in self.profiles
            if self.usable(p) and self.has_key(p) and not self.cooldown_left(p["name"])
        ]

    def order(self, prefer: str | None = None) -> list[dict]:
        first = prefer or self.pinned
        return sorted(self.profiles, key=lambda p: p["name"] != first)

    def ask(self, messages, system="", prefer=None, on_start=None, on_text=None, notify=None):
        """Return (profile name, reply text) from the first profile that answers."""
        notify = notify or (lambda message: None)
        for profile in self.order(prefer):
            name = profile["name"]
            if self.cooldown_left(name) or not self.usable(profile):
                continue
            key = config.get_key(name)
            if providers.needs_key(profile) and not key:
                notify(f"{name}: no API key saved, skipping")
                continue
            attempt = messages
            while True:
                parts = []
                try:
                    for text in providers.stream_reply(profile, key, attempt, system):
                        if not parts and on_start:
                            on_start(name)
                        parts.append(text)
                        if on_text:
                            on_text(text)
                    self.replies[name] = self.replies.get(name, 0) + 1
                    return name, "".join(parts)
                except providers.ProviderFailure as failure:
                    # Free fallback models often have small context windows, so a long
                    # conversation gets its oldest messages dropped for that model only.
                    shorter = trimmed(attempt) if failure.too_long else None
                    if shorter:
                        attempt = shorter
                        notify(f"{name}: conversation too long, retrying with the last {len(shorter)} messages")
                        continue
                    if failure.cooldown:
                        self.cooldowns[name] = time.time() + failure.cooldown
                    notify(f"{name}: {failure.reason}, switching")
                    break
        raise NoProviderAvailable(self.unavailable_reason())

    def unavailable_reason(self) -> str:
        if not self.profiles:
            return "No profiles yet. Add one with /add."
        if self.offline and not any(providers.is_local(p) for p in self.profiles):
            return "You are offline and no local model is set up, so no AI can answer."
        waits = [self.cooldown_left(p["name"]) for p in self.profiles if self.cooldown_left(p["name"])]
        if waits:
            return f"Every profile is unavailable. The next one frees up in {min(waits):.0f}s."
        return "Every profile failed. Check /profiles."
