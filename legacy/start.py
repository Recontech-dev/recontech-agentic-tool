"""Open Agentic Lazy Tool. Double-click this file, or run: python start.py [folder]"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

try:
    from agentic_lazy_tool.cli import main
except ModuleNotFoundError as missing:
    print(f"Missing dependency: {missing.name}")
    print("Install the dependencies once by running this in the project folder:")
    print("    pip install -e .")
    input("Press Enter to close.")
    sys.exit(1)

main()
