"""/debate: several models argue a question, then one judges."""

from concurrent.futures import ThreadPoolExecutor

from rich.markdown import Markdown
from rich.panel import Panel

from agentic_lazy_tool.chain import Chain, NoProviderAvailable

STANCES = [
    ("Advocate", "Propose the approach you think is best and argue for it."),
    ("Skeptic", "Look for the risks, hidden costs and simpler alternatives."),
    ("Pragmatist", "Favour whatever works soonest with the least upkeep."),
]
BRIEF = " Answer in under 250 words."


def run(chain: Chain, question: str, console, notify, renderer) -> str:
    ready = chain.ready()
    if not ready:
        raise NoProviderAvailable(chain.unavailable_reason())
    # Different models disagree more usefully than one model asked twice, so
    # spread the seats across profiles and only reuse one when there are too few.
    seat_count = max(2, min(len(STANCES), len(ready)))
    seats = [(*STANCES[i], ready[i % len(ready)]["name"]) for i in range(seat_count)]

    def answer(seat, prompt):
        role, stance, profile = seat
        return chain.ask([{"role": "user", "content": prompt}], system=stance + BRIEF, prefer=profile, notify=notify)

    def show(round_name, results):
        for (role, _, _), (used, text) in zip(seats, results):
            console.print(Panel(Markdown(text), title=f"{round_name} · {role} · {used}", border_style="dim"))

    with ThreadPoolExecutor(seat_count) as pool:
        opening = list(pool.map(lambda seat: answer(seat, question), seats))
        show("Opening", opening)

        def rebuttal_prompt(index):
            others = "\n\n".join(
                f"{seats[i][0]}:\n{text}" for i, (_, text) in enumerate(opening) if i != index
            )
            return (
                f"Question: {question}\n\nYour answer:\n{opening[index][1]}\n\n"
                f"Other answers:\n{others}\n\n"
                "Say where the others are right or wrong, then give your revised position."
            )

        rebuttals = list(pool.map(lambda i: answer(seats[i], rebuttal_prompt(i)), range(seat_count)))
        show("Rebuttal", rebuttals)

    positions = "\n\n".join(f"{seats[i][0]}:\n{text}" for i, (_, text) in enumerate(rebuttals))
    judge_prompt = (
        f"Question: {question}\n\nFinal positions from a debate:\n{positions}\n\n"
        "Give one recommendation, the main reason for it, and any disagreement the reader should know about."
    )
    console.print("[bold]Verdict[/bold]")
    try:
        _, verdict = chain.ask(
            [{"role": "user", "content": judge_prompt}],
            system="You are the judge of a debate. Be decisive.",
            on_start=renderer.start,
            on_text=renderer.feed,
            notify=notify,
        )
    finally:
        renderer.close()
    return verdict
