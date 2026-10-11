"""Work out what kind of task a message is, so the model gets instructions that fit it.

This is done with keyword rules on the user's own machine: no extra request, no delay.
"""

import re
from typing import NamedTuple


class Task(NamedTuple):
    name: str
    instruction: str


# Checked in order; the first match wins, so the more specific tasks come first.
RULES = [
    (
        "debug",
        r"\b(\w*error|\w*exception|traceback|stack trace|bug|crash\w*|fails?|failing|failed|not working|doesn'?t work|broken|fix)\b",
        "The user is debugging. Name the most likely cause first, show the exact change that fixes it, "
        "and say how to confirm it worked. Ask for the error text or the code only if you cannot tell without it.",
    ),
    (
        "review",
        r"\b(review|feedback|critique|audit|code smells?|what'?s wrong with)\b",
        "The user wants a review. List the problems, most serious first, say where each one is, "
        "and give a concrete fix for each. Do not rewrite code that is fine.",
    ),
    (
        "test",
        r"\b(unit tests?|test cases?|write (a |some |the )?tests?|pytest|unittest|jest)\b",
        "The user wants tests. Cover the normal case, the edge cases and the failure cases, "
        "use the test framework the project already uses, and give complete runnable test code.",
    ),
    (
        "refactor",
        r"\b(refactor\w*|clean ?up|simplify|restructure|reorgani[sz]e|make (this|it) (cleaner|shorter|readable))\b",
        "The user wants a refactor. Keep the behaviour the same, show the full changed code, "
        "and list what changed and why in a few short points.",
    ),
    (
        "explain",
        r"\b(explain|what does|what is|what are|how does|how do|why does|why is|meaning of|difference between|understand)\b",
        "The user wants an explanation. Give the answer in one sentence first, "
        "then explain step by step with a small example.",
    ),
    (
        "plan",
        r"\b(plan|design|architecture|approach|roadmap|should i|which is better|compare|trade-?offs?|best way)\b",
        "The user is deciding how to do something. Recommend one option, give the main reason, "
        "name the trade-off, and list the steps to carry it out.",
    ),
    (
        "write code",
        r"\b(write|create|build|implement|generate|add|make)\b.*\b(function|class|script|code|api|endpoint|component|page|feature|program|app|tool|command|query)\b",
        "The user wants code written. Give complete, runnable code with one block per file, "
        "and say what they need to install or change to use it.",
    ),
]


def detect(text: str) -> Task | None:
    for name, pattern, instruction in RULES:
        if re.search(pattern, text, re.IGNORECASE):
            return Task(name, instruction)
    return None
