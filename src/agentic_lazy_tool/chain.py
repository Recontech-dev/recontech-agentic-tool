"""The failover chain: try profiles in order, skipping any that are cooling down."""

import time

from agentic_lazy_tool import config, providers


class NoProviderAvailable(Exception):
    pass


class Chain:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.cooldowns: dict[str, float] = {}
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

    def ready(self) -> list[dict]:
        return [p for p in self.profiles if self.has_key(p) and not self.cooldown_left(p["name"])]

    def order(self, prefer: str | None = None) -> list[dict]:
        first = prefer or self.pinned
        return sorted(self.profiles, key=lambda p: p["name"] != first)

    def ask(self, messages, system="", prefer=None, on_start=None, on_text=None, notify=None):
        """Return (profile name, reply text) from the first profile that answers."""
        notify = notify or (lambda message: None)
        for profile in self.order(prefer):
            name = profile["name"]
            if self.cooldown_left(name):
                continue
            key = config.get_key(name)
            if providers.needs_key(profile) and not key:
                notify(f"{name}: no API key saved, skipping")
                continue
            parts = []
            try:
                for text in providers.stream_reply(profile, key, messages, system):
                    if not parts and on_start:
                        on_start(name)
                    parts.append(text)
                    if on_text:
                        on_text(text)
                return name, "".join(parts)
            except providers.ProviderFailure as failure:
                if failure.cooldown:
                    self.cooldowns[name] = time.time() + failure.cooldown
                notify(f"{name}: {failure.reason}, switching")
        raise NoProviderAvailable(self.unavailable_reason())

    def unavailable_reason(self) -> str:
        if not self.profiles:
            return "No profiles yet. Add one with /add."
        waits = [self.cooldown_left(p["name"]) for p in self.profiles if self.cooldown_left(p["name"])]
        if waits:
            return f"Every profile is unavailable. The next one frees up in {min(waits):.0f}s."
        return "Every profile failed. Check /profiles."
