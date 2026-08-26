import sys
from pathlib import Path

# The server modules import each other by bare name (they run as a package-less
# app under uvicorn), so the server directory goes on the path directly.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
