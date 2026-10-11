import io

from rich.console import Console

from agentic_lazy_tool.render import ReplyRenderer, split_blocks


def test_blank_line_ends_a_block():
    assert split_blocks("one\n\ntwo") == (["one"], "two")


def test_blank_lines_inside_a_code_fence_do_not_split():
    text = "```py\na = 1\n\nb = 2\n```\nafter"
    assert split_blocks(text) == (["```py\na = 1\n\nb = 2\n```"], "after")


def test_unclosed_fence_stays_pending():
    assert split_blocks("intro\n\n```py\na = 1\n\n") == (["intro"], "```py\na = 1\n\n")


def test_reply_is_rendered_block_by_block_however_it_is_chunked():
    output = io.StringIO()
    renderer = ReplyRenderer(Console(file=output, width=60), markdown=True)
    renderer.start("groq")
    for chunk in ["# Ti", "tle\n\nSome **bold** te", "xt.\n\n```py\nprint(", "1)\n```\n", "\nlast line"]:
        renderer.feed(chunk)
    renderer.close()
    shown = output.getvalue()
    assert "groq>" in shown and "Title" in shown and "bold" in shown and "**" not in shown
    assert "print(1)" in shown and "```" not in shown and "last line" in shown


def test_plain_mode_prints_text_unchanged():
    output = io.StringIO()
    renderer = ReplyRenderer(Console(file=output, width=60), markdown=False)
    renderer.start("groq")
    renderer.feed("**raw** [text]")
    renderer.close()
    assert "**raw** [text]" in output.getvalue()


def test_live_preview_on_a_terminal_leaves_only_the_formatted_reply():
    output = io.StringIO()
    console = Console(file=output, width=60, height=10, force_terminal=True, color_system=None)
    renderer = ReplyRenderer(console, markdown=True)
    renderer.start("groq")
    renderer.feed("intro\n\n```py\n" + "".join(f"line{i}\n" for i in range(40)))
    renderer.feed("```\n")
    renderer.close()
    assert renderer.live is None
    assert "line39" in output.getvalue()
