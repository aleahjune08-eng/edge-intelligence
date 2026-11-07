"""The phone app is served at /app and carries no secret."""
from pathlib import Path

from test_ledger import client  # noqa: F401

APP = Path(__file__).resolve().parents[1] / "app"


def test_app_served(client):  # noqa: F811
    r = client.get("/app/")
    assert r.status_code == 200 and "EDGE INTELLIGENCE" in r.text
    for f in ("app.js", "app.css", "manifest.webmanifest", "sw.js",
              "icon.svg", "icon-180.png"):
        assert client.get("/app/" + f).status_code == 200, f
    # the API itself still answers at its own paths
    assert client.get("/health").json()["status"] == "ok"


def test_no_keys_or_made_up_numbers_in_app():
    text = "".join(p.read_text() for p in APP.glob("*")
                   if p.suffix in (".js", ".html", ".css", ".webmanifest"))
    for bad in ("test-key", "read-key", "NBA_API_KEY", "sk_live", "pk_live"):
        assert bad not in text
    # the app only calls read endpoints
    assert "POST" not in text
