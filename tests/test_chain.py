import pytest

from agentic_lazy_tool import config, providers
from agentic_lazy_tool.chain import Chain, NoProviderAvailable


def make_chain(monkeypatch, behaviours):
    """behaviours maps profile name -> reply text, or a ProviderFailure to raise."""
    profiles = [{"name": n, "provider": "groq", "model": "m", "base_url": "x"} for n in behaviours]
    calls = []

    def fake_stream(profile, key, messages, system=""):
        calls.append(profile["name"])
        result = behaviours[profile["name"]]
        if isinstance(result, Exception):
            raise result
        yield result

    monkeypatch.setattr(providers, "stream_reply", fake_stream)
    monkeypatch.setattr(config, "get_key", lambda name: "key")
    return Chain({"profiles": profiles, "system": ""}), calls


def ask(chain, **kwargs):
    return chain.ask([{"role": "user", "content": "hi"}], **kwargs)


def test_first_profile_answers(monkeypatch):
    chain, calls = make_chain(monkeypatch, {"a": "from a", "b": "from b"})
    assert ask(chain) == ("a", "from a")
    assert calls == ["a"]


def test_fails_over_and_skips_cooling_profile(monkeypatch):
    limited = providers.ProviderFailure("rate limited", cooldown=60)
    chain, calls = make_chain(monkeypatch, {"a": limited, "b": "from b"})
    notices = []
    assert ask(chain, notify=notices.append) == ("b", "from b")
    assert "a: rate limited" in notices[0]
    assert ask(chain) == ("b", "from b")
    assert calls == ["a", "b", "b"]


def test_returns_to_first_profile_after_cooldown(monkeypatch):
    chain, calls = make_chain(monkeypatch, {"a": "from a", "b": "from b"})
    chain.cooldowns["a"] = 1  # expired long ago
    assert ask(chain)[0] == "a"


def test_request_error_does_not_cool_down(monkeypatch):
    chain, _ = make_chain(monkeypatch, {"a": providers.ProviderFailure("rejected"), "b": "ok"})
    ask(chain)
    assert chain.cooldown_left("a") == 0


def test_all_unavailable(monkeypatch):
    limited = providers.ProviderFailure("rate limited", cooldown=60)
    chain, _ = make_chain(monkeypatch, {"a": limited, "b": limited})
    with pytest.raises(NoProviderAvailable, match="frees up"):
        ask(chain)


def test_prefer_and_pin_go_first(monkeypatch):
    chain, _ = make_chain(monkeypatch, {"a": "from a", "b": "from b"})
    assert ask(chain, prefer="b")[0] == "b"
    chain.pinned = "b"
    assert ask(chain)[0] == "b"


def test_missing_key_is_skipped(monkeypatch):
    chain, calls = make_chain(monkeypatch, {"a": "from a", "b": "from b"})
    monkeypatch.setattr(config, "get_key", lambda name: None if name == "a" else "key")
    assert ask(chain)[0] == "b"
    assert calls == ["b"]
