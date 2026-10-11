"""Build dist/AgenticLazyTool.exe. Run from the project folder: python packaging/build_exe.py"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

subprocess.run(
    [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--windowed",
        "--name", "AgenticLazyTool",
        "--paths", str(ROOT / "src"),
        "--collect-submodules", "keyring.backends",
        "--collect-data", "rich",
        "--distpath", str(ROOT / "dist"),
        "--workpath", str(ROOT / "build"),
        "--specpath", str(ROOT / "build"),
        str(ROOT / "packaging" / "app.py"),
    ],
    check=True,
)
print(f"Built {ROOT / 'dist' / 'AgenticLazyTool.exe'}")
