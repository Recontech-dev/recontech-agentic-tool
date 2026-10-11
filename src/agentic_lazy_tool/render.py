"""Show a streamed reply as formatted Markdown, one finished block at a time."""

from rich.live import Live
from rich.markdown import Markdown
from rich.text import Text


def split_blocks(text: str) -> tuple[list[str], str]:
    """Split off the Markdown blocks that are complete; return them and the unfinished rest."""
    lines = text.split("\n")
    unfinished_line = lines.pop()
    blocks, current, in_fence = [], [], False
    for line in lines:
        if line.lstrip().startswith("```"):
            current.append(line)
            if in_fence:
                blocks.append("\n".join(current))
                current = []
            in_fence = not in_fence
        elif not in_fence and not line.strip():
            if current:
                blocks.append("\n".join(current))
                current = []
        else:
            current.append(line)
    return blocks, "\n".join([*current, unfinished_line])


class ReplyRenderer:
    def __init__(self, console, markdown: bool = True, preview=None):
        """`preview`, if given, is called with the unfinished text instead of drawing it live."""
        self.console = console
        self.markdown = markdown
        self.preview = preview
        self.pending = ""
        self.live = None

    def start(self, name: str) -> None:
        self._flush()
        self.console.print(f"[cyan]{name}>[/cyan] ", end="" if not self.markdown else "\n")

    def feed(self, chunk: str) -> None:
        if not self.markdown:
            self.console.print(chunk, end="", markup=False, highlight=False)
            return
        blocks, self.pending = split_blocks(self.pending + chunk)
        for block in blocks:
            self._print_block(block)
        self._show_unfinished()

    def close(self) -> None:
        self._flush()
        if self.preview:
            self.preview("")
        if self.live:
            self.live.stop()
            self.live = None
        if not self.markdown:
            self.console.print()

    def _flush(self) -> None:
        if self.pending.strip():
            self._print_block(self.pending)
        self.pending = ""

    def _print_block(self, block: str) -> None:
        self.console.print(Markdown(block))
        self.console.print()

    def _show_unfinished(self) -> None:
        # The block being written is shown raw and replaced by the formatted version once
        # it is complete. Only its tail is shown, one row per line, so the live area never
        # grows taller than the screen.
        if self.preview:
            return self.preview(self.pending)
        if not self.console.is_terminal:
            return
        if self.live is None:
            self.live = Live(console=self.console, transient=True, refresh_per_second=12)
            self.live.start()
        tail = self.pending.split("\n")[-max(self.console.height - 4, 3):]
        self.live.update(Text("\n".join(tail), style="dim", no_wrap=True, overflow="ellipsis"))
