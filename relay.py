"""Relay for a fixed set of public NBA.com JSON feeds.

Some callers (for example the model's cloud runs) cannot reach NBA.com
directly. This fetches only the feeds listed in ALLOWED, caches each
response briefly, and returns the JSON unchanged. Nothing else can be
fetched through it.
"""
import re
import threading
import time

import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) "
                  "Gecko/20100101 Firefox/158.0",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nba.com/",
    "Origin": "https://www.nba.com",
}

# (pattern of the full URL, seconds to cache)
ALLOWED = [
    (r"https://cdn\.nba\.com/static/json/liveData/scoreboard/"
     r"todaysScoreboard_00\.json", 60),
    (r"https://cdn\.nba\.com/static/json/staticData/scheduleLeagueV2\.json",
     1800),
    (r"https://cdn\.nba\.com/static/json/liveData/boxscore/"
     r"boxscore_\d{10}\.json", 60),
    (r"https://cdn\.nba\.com/static/json/liveData/playbyplay/"
     r"playbyplay_\d{10}\.json", 60),
    (r"https://stats\.nba\.com/js/data/leaders/"
     r"00_daily_lineups_\d{8}\.json", 120),
]
MAX_BYTES = 25_000_000
MAX_ENTRIES = 64

_cache = {}
_lock = threading.Lock()


class RelayError(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def ttl_for(url):
    for pattern, ttl in ALLOWED:
        if re.fullmatch(pattern, url):
            return ttl
    return None


def fetch(url, timeout=25, now=time.monotonic, get=requests.get):
    ttl = ttl_for(url)
    if ttl is None:
        raise RelayError(400, "That URL is not one of the relayed NBA feeds.")
    with _lock:
        hit = _cache.get(url)
        if hit and now() - hit[0] < ttl:
            return hit[1], True
    try:
        resp = get(url, headers=HEADERS, timeout=timeout)
    except requests.RequestException as exc:
        raise RelayError(502, f"NBA.com unreachable: {exc.__class__.__name__}")
    if resp.status_code == 404:
        raise RelayError(404, "NBA.com has no such feed (yet).")
    if resp.status_code != 200:
        raise RelayError(502, f"NBA.com answered {resp.status_code}.")
    if len(resp.content) > MAX_BYTES:
        raise RelayError(502, "NBA.com response too large.")
    try:
        data = resp.json()
    except ValueError:
        raise RelayError(502, "NBA.com did not return JSON.")
    with _lock:
        if len(_cache) >= MAX_ENTRIES:
            _cache.pop(min(_cache, key=lambda k: _cache[k][0]))
        _cache[url] = (now(), data)
    return data, False
