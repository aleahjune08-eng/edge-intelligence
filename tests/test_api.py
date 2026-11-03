import importlib
import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

KEY = "test-key"
# Set TEST_DATABASE_URL to run the suite against Postgres instead of SQLite.
TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
H = {"X-API-Key": KEY}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NBA_API_KEY", KEY)
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    import db
    use_test_database(monkeypatch, db)
    monkeypatch.setattr(db, "FIRST_BASKETS_CSV", tmp_path / "fb.csv")
    monkeypatch.setattr(db, "STARTERS_CSV", tmp_path / "st.csv")
    import main
    importlib.reload(main)
    with TestClient(main.app) as c:
        yield c


def use_test_database(monkeypatch, db):
    if TEST_DATABASE_URL:
        monkeypatch.setenv("DATABASE_URL", TEST_DATABASE_URL)
        engine = db.make_engine()
        db.metadata.drop_all(engine)
        engine.dispose()
    else:
        monkeypatch.delenv("DATABASE_URL", raising=False)


def starters(team, ids):
    return [{"player_id": i, "player_name": f"Player {i}", "team": team}
            for i in ids]


def save_game(client, game_id, date, scorer, team, home, away,
              home_ids, away_ids):
    r = client.post("/first-basket/records", headers=H, json={
        "game_id": game_id, "game_date": date, "player_id": scorer,
        "player_name": f"Player {scorer}", "team": team,
        "source": "test fixture", "season": "2025-26",
        "home_team": home, "away_team": away,
        "starters": starters(home, home_ids) + starters(away, away_ids),
    })
    assert r.status_code == 200, r.text


BOS = ["B1", "B2", "B3", "B4", "B5"]
NYK = ["N1", "N2", "N3", "N4", "N5"]


def test_public_endpoints(client):
    assert client.get("/").json()["version"]
    health = client.get("/health").json()
    assert health["status"] == "ok"
    assert health["database_backend"] == (
        "postgresql" if TEST_DATABASE_URL else "sqlite")


def test_auth(client):
    assert client.get("/first-basket/records").status_code == 401
    assert client.get("/first-basket/records",
                      headers={"X-API-Key": "nope"}).status_code == 401
    assert client.get("/first-basket/records",
                      headers={b"X-API-Key": b"\xe9"}).status_code == 401
    assert client.get("/predictions/grades").status_code == 401


def test_record_round_trip_and_validation(client):
    save_game(client, "G1", "2025-10-22", "B1", "bos", "BOS", "NYK",
              BOS, NYK)
    body = client.get("/first-basket/records", headers=H).json()
    assert body["count"] == 1
    rec = body["records"][0]
    assert rec["team"] == "BOS" and rec["verified"] is False
    assert rec["data_flags"] == []
    assert client.get("/first-basket/records?team=nyk",
                      headers=H).json()["count"] == 0
    bad = client.post("/first-basket/records", headers=H, json={
        "game_id": "G2", "game_date": "10/22/2025", "player_id": "B1",
        "player_name": "x", "team": "BOS", "source": "test"})
    assert bad.status_code == 422
    assert client.get("/first-basket/records?limit=0",
                      headers=H).status_code == 422
    stats = client.get("/first-basket/stats", headers=H).json()
    assert stats["games"] == 1 and stats["games_with_starters"] == 1


def test_original_probability_endpoint(client):
    r = client.post("/first-basket/probabilities", headers=H, json={
        "candidates": [
            {"player_id": "P1", "player_name": "A",
             "first_basket_count": 12, "eligible_game_count": 60},
            {"player_id": "P2", "player_name": "B",
             "first_basket_count": 8, "eligible_game_count": 40}]})
    assert r.status_code == 200
    shares = [x["normalized_candidate_share"] for x in r.json()["results"]]
    assert abs(sum(shares) - 1) < 1e-5
    bad = client.post("/first-basket/probabilities", headers=H, json={
        "candidates": [{"player_id": "P1", "player_name": "A",
                        "first_basket_count": 70,
                        "eligible_game_count": 60}]})
    assert bad.status_code == 422


def test_matchup_uses_history(client):
    save_game(client, "G1", "2025-10-22", "B1", "BOS", "BOS", "NYK",
              BOS, NYK)
    save_game(client, "G2", "2025-10-24", "B1", "BOS", "NYK", "BOS",
              NYK, BOS)
    save_game(client, "G3", "2025-10-26", "N2", "NYK", "BOS", "NYK",
              BOS, NYK)
    r = client.post("/first-basket/matchup", headers=H, json={
        "home_team": "BOS", "away_team": "NYK", "prior_games": 2})
    assert r.status_code == 200, r.text
    body = r.json()
    results = body["results"]
    assert len(results) == 10
    assert results[0]["player_id"] == "B1"
    assert results[0]["first_baskets"] == 2 and results[0]["starts"] == 3
    assert abs(sum(p["probability"] for p in results) - 1) < 1e-5
    assert body["prediction_id"] is None
    assert "home_starters_from_last_stored_game" in body["data_flags"]


def test_matchup_without_history(client):
    r = client.post("/first-basket/matchup", headers=H, json={
        "home_team": "BOS", "away_team": "NYK"})
    assert r.status_code == 404
    r = client.post("/first-basket/matchup", headers=H, json={
        "home_team": "BOS", "away_team": "NYK",
        "home_starters": BOS, "away_starters": NYK})
    assert r.status_code == 200
    probs = {p["probability"] for p in r.json()["results"]}
    assert probs == {0.1}
    assert client.post("/first-basket/matchup", headers=H, json={
        "home_team": "BOS", "away_team": "bos"}).status_code == 422
    assert client.post("/first-basket/matchup", headers=H, json={
        "home_team": "BOS", "away_team": "NYK",
        "save_prediction": True}).status_code == 422


def test_prediction_ledger_and_grades(client):
    tip = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    save_game(client, "G0", "2025-10-20", "B1", "BOS", "BOS", "NYK",
              BOS, NYK)
    r = client.post("/first-basket/matchup", headers=H, json={
        "home_team": "BOS", "away_team": "NYK", "save_prediction": True,
        "game_id": "G9", "game_date": "2025-11-01", "tip_time": tip})
    assert r.status_code == 200
    pid = r.json()["prediction_id"]
    assert pid

    # A manual prediction made after tip-off is excluded from grading.
    late = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    r = client.post("/predictions", headers=H, json={
        "game_id": "G9", "game_date": "2025-11-01", "model": "manual",
        "tip_time": late,
        "candidates": [{"player_id": "N1", "player_name": "x",
                        "team": "NYK", "probability": 0.5}]})
    assert r.status_code == 200

    grades = client.get("/predictions/grades", headers=H).json()
    assert grades["awaiting_result"] == 1
    assert grades["excluded_made_after_tip"] == 1

    save_game(client, "G9", "2025-11-01", "B1", "BOS", "BOS", "NYK",
              BOS, NYK)
    preds = client.get("/predictions", headers=H).json()["predictions"]
    graded = next(p for p in preds if p["prediction_id"] == pid)
    assert graded["made_before_tip"] is True
    assert graded["grade"]["top_pick_hit"] is True
    grades = client.get("/predictions/grades", headers=H).json()
    summary = grades["models"]["starter_history_rate_v1"]
    assert summary["graded_games"] == 1
    assert summary["top_pick_hit_rate"] == 1.0
    assert "manual" not in grades["models"]


def test_prediction_validation(client):
    base = {"game_id": "G1", "game_date": "2025-11-01", "model": "m"}
    over = client.post("/predictions", headers=H, json={**base, "candidates": [
        {"player_id": "A", "player_name": "A", "team": "BOS",
         "probability": 0.7},
        {"player_id": "B", "player_name": "B", "team": "BOS",
         "probability": 0.7}]})
    assert over.status_code == 422
    dup = client.post("/predictions", headers=H, json={**base, "candidates": [
        {"player_id": "A", "player_name": "A", "team": "BOS",
         "probability": 0.2},
        {"player_id": "A", "player_name": "A", "team": "BOS",
         "probability": 0.2}]})
    assert dup.status_code == 422


def test_csv_seed(tmp_path, monkeypatch):
    import db
    fb = tmp_path / "fb.csv"
    st = tmp_path / "st.csv"
    fb.write_text(
        ",".join(db.FIRST_BASKET_FIELDS) + "\n"
        "G1,2025-10-22,B1,Player B1,BOS,csv,0,2025-10-23T00:00:00,"
        "2025-26,BOS,NYK,BOS,\n")
    st.write_text(",".join(db.STARTER_FIELDS) + "\n"
                  "G1,B1,Player B1,BOS,2025-10-22\n")
    monkeypatch.setenv("NBA_API_KEY", KEY)
    monkeypatch.setenv("DB_PATH", str(tmp_path / "seed.db"))
    use_test_database(monkeypatch, db)
    monkeypatch.setattr(db, "FIRST_BASKETS_CSV", fb)
    monkeypatch.setattr(db, "STARTERS_CSV", st)
    import main
    importlib.reload(main)
    with TestClient(main.app) as c:
        recs = c.get("/first-basket/records", headers=H).json()["records"]
        assert [r["game_id"] for r in recs] == ["G1"]
        assert recs[0]["tip_winner_team"] == "BOS"
    # Restarting must not duplicate or overwrite.
    with TestClient(main.app) as c:
        assert c.get("/first-basket/stats", headers=H).json()["games"] == 1


def test_unset_key_returns_503(tmp_path, monkeypatch):
    monkeypatch.setenv("NBA_API_KEY", "")
    monkeypatch.setenv("DB_PATH", str(tmp_path / "x.db"))
    import main
    importlib.reload(main)
    with TestClient(main.app) as c:
        assert c.get("/first-basket/records",
                     headers=H).status_code == 503


def test_grading_by_date_and_teams_without_game_id(client):
    tip = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    r = client.post("/predictions", headers=H, json={
        "game_id": "2025-11-01:NYK@BOS", "game_date": "2025-11-01",
        "model": "champion", "tip_time": tip,
        "home_team": "bos", "away_team": "NYK",
        "candidates": [
            {"player_id": "B1", "player_name": "x", "team": "BOS",
             "probability": 0.6},
            {"player_id": "N1", "player_name": "y", "team": "NYK",
             "probability": 0.4}]})
    assert r.status_code == 200, r.text
    # The importer stores the game under its NBA id, not ours.
    save_game(client, "0022500123", "2025-11-01", "B1", "BOS", "BOS", "NYK",
              BOS, NYK)
    pred = client.get("/predictions", headers=H).json()["predictions"][0]
    assert pred["home_team"] == "BOS" and pred["away_team"] == "NYK"
    assert pred["actual"]["player_id"] == "B1"
    assert pred["grade"]["top_pick_hit"] is True


def test_matchup_ignores_the_game_it_predicts(client):
    save_game(client, "G1", "2025-10-22", "B1", "BOS", "BOS", "NYK",
              BOS, NYK)
    save_game(client, "G2", "2025-10-24", "B2", "BOS", "BOS", "NYK",
              BOS, NYK)
    r = client.post("/first-basket/matchup", headers=H, json={
        "home_team": "BOS", "away_team": "NYK", "prior_games": 2,
        "save_prediction": True, "game_id": "G2",
        "game_date": "2025-10-24"})
    by_id = {p["player_id"]: p for p in r.json()["results"]}
    assert by_id["B1"]["starts"] == 1 and by_id["B1"]["first_baskets"] == 1
    assert by_id["B2"]["first_baskets"] == 0


def test_compare_endpoint(client):
    tip = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    for i, scorer in enumerate(["B1", "B1", "N1"]):
        gid, date = f"C{i}", f"2025-11-0{i + 1}"
        for m, p_b1 in (("champion", 0.5), ("baseline", 0.2)):
            r = client.post("/predictions", headers=H, json={
                "game_id": gid, "game_date": date, "model": m,
                "tip_time": tip, "candidates": [
                    {"player_id": "B1", "player_name": "x", "team": "BOS",
                     "probability": p_b1},
                    {"player_id": "N1", "player_name": "y", "team": "NYK",
                     "probability": 0.2}]})
            assert r.status_code == 200
        save_game(client, gid, date, scorer, "BOS", "BOS", "NYK", BOS, NYK)
    # A game only one model predicted is left out of the head-to-head.
    client.post("/predictions", headers=H, json={
        "game_id": "C9", "game_date": "2025-11-09", "model": "champion",
        "tip_time": tip, "candidates": [
            {"player_id": "B1", "player_name": "x", "team": "BOS",
             "probability": 0.5}]})
    save_game(client, "C9", "2025-11-09", "B1", "BOS", "BOS", "NYK",
              BOS, NYK)
    body = client.get("/predictions/compare?model_a=champion"
                      "&model_b=baseline", headers=H).json()
    assert body["shared_games"] == 3
    assert body["model_a_better_games"] == 2
    assert body["log_loss_diff"] < 0
    assert body["verdict"].startswith("too early")
    empty = client.get("/predictions/compare?model_a=x&model_b=y",
                       headers=H).json()
    assert empty["shared_games"] == 0


def test_old_database_gets_new_columns(tmp_path, monkeypatch):
    import sqlite3
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE prediction_sets (id INTEGER PRIMARY KEY, "
                "game_id VARCHAR(32) NOT NULL, game_date VARCHAR(10) NOT NULL,"
                " model VARCHAR(100) NOT NULL, created_at VARCHAR(40) NOT NULL,"
                " tip_time VARCHAR(40))")
    con.execute("INSERT INTO prediction_sets VALUES "
                "(1, 'G1', '2025-11-01', 'm', '2025-11-01T00:00:00', NULL)")
    con.commit()
    con.close()
    monkeypatch.setenv("NBA_API_KEY", KEY)
    monkeypatch.setenv("DB_PATH", str(path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    import db
    monkeypatch.setattr(db, "FIRST_BASKETS_CSV", tmp_path / "fb.csv")
    monkeypatch.setattr(db, "STARTERS_CSV", tmp_path / "st.csv")
    import main
    importlib.reload(main)
    with TestClient(main.app) as c:
        preds = c.get("/predictions", headers=H).json()["predictions"]
        assert preds[0]["game_id"] == "G1" and preds[0]["home_team"] is None


class FakeResponse:
    def __init__(self, status, payload=None, content=b"{}"):
        self.status_code = status
        self._payload = payload
        self.content = content

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


def test_relay_allows_only_listed_feeds():
    import relay
    calls = []

    def get(url, headers, timeout):
        calls.append(url)
        return FakeResponse(200, {"ok": url})

    relay._cache.clear()
    url = ("https://cdn.nba.com/static/json/liveData/boxscore/"
           "boxscore_0022600171.json")
    clock = [0.0]
    data, cached = relay.fetch(url, now=lambda: clock[0], get=get)
    assert data == {"ok": url} and cached is False
    data, cached = relay.fetch(url, now=lambda: clock[0], get=get)
    assert cached is True and len(calls) == 1
    clock[0] = 61
    relay.fetch(url, now=lambda: clock[0], get=get)
    assert len(calls) == 2
    for bad in ("https://example.com/x.json",
                "https://cdn.nba.com/static/json/liveData/boxscore/"
                "boxscore_0022600171.json?x=1",
                "https://cdn.nba.com.evil.io/static/json/staticData/"
                "scheduleLeagueV2.json",
                "http://cdn.nba.com/static/json/staticData/"
                "scheduleLeagueV2.json"):
        with pytest.raises(relay.RelayError) as err:
            relay.fetch(bad, get=get)
        assert err.value.status == 400
    assert len(calls) == 2


def test_relay_upstream_errors():
    import relay
    relay._cache.clear()
    url = ("https://stats.nba.com/js/data/leaders/"
           "00_daily_lineups_20261104.json")
    for resp, status in ((FakeResponse(403), 502), (FakeResponse(404), 404),
                         (FakeResponse(200, None), 502)):
        with pytest.raises(relay.RelayError) as err:
            relay.fetch(url, get=lambda *a, **k: resp)
        assert err.value.status == status


def test_relay_endpoint(client, monkeypatch):
    import relay
    monkeypatch.setattr(relay, "fetch", lambda url: ({"games": []}, False))
    url = ("https://cdn.nba.com/static/json/staticData/"
           "scheduleLeagueV2.json")
    assert client.get("/nba/feed", params={"url": url}).status_code == 401
    r = client.get("/nba/feed", params={"url": url}, headers=H)
    assert r.status_code == 200 and r.json()["data"] == {"games": []}

    def refuse(url):
        raise relay.RelayError(400, "no")
    monkeypatch.setattr(relay, "fetch", refuse)
    assert client.get("/nba/feed", params={"url": url},
                      headers=H).status_code == 400


def test_board_for_app(client, monkeypatch):
    import main
    monkeypatch.setattr(main, "READ_KEY", "read-only")
    R = {"X-API-Key": "read-only"}
    tip = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    save_game(client, "G0", "2025-10-20", "B1", "BOS", "BOS", "NYK",
              BOS, NYK)
    for p_b1 in (0.3, 0.6):          # the later pre-tip pick wins
        client.post("/predictions", headers=H, json={
            "game_id": "2025-11-01:NYK@BOS", "game_date": "2025-11-01",
            "model": "champion", "tip_time": tip,
            "home_team": "BOS", "away_team": "NYK", "candidates": [
                {"player_id": "N1", "player_name": "y", "team": "NYK",
                 "probability": 0.2},
                {"player_id": "B1", "player_name": "x", "team": "BOS",
                 "probability": p_b1}]})
    client.post("/first-basket/matchup", headers=H, json={
        "home_team": "BOS", "away_team": "NYK", "save_prediction": True,
        "game_id": "2025-11-01:NYK@BOS", "game_date": "2025-11-01",
        "tip_time": tip})
    body = client.get("/board", headers=R).json()
    assert body["date"] == "2025-11-01" and len(body["games"]) == 1
    g = body["games"][0]
    assert g["home_team"] == "BOS"
    top = g["champion"]["picks"][0]
    assert top["player_id"] == "B1" and top["probability"] == 0.6
    assert top["fair_odds"] == -150
    assert g["baseline"]["model"] == "starter_history_rate_v1"
    assert g["actual"] is None
    save_game(client, "0022500123", "2025-11-01", "B1", "BOS", "BOS", "NYK",
              BOS, NYK)
    g = client.get("/board?date=2025-11-01", headers=R).json()["games"][0]
    assert g["actual"]["player_id"] == "B1"
    assert g["champion"]["grade"]["top_pick_hit"] is True
    # The read-only key reads but cannot write.
    assert client.get("/predictions/compare", headers=R).status_code == 200
    assert client.post("/predictions", headers=R, json={
        "game_id": "x", "game_date": "2025-11-02", "model": "m",
        "candidates": [{"player_id": "A", "player_name": "A",
                        "team": "BOS", "probability": 0.1}]}
    ).status_code == 401
    assert client.get("/board", headers={"X-API-Key": "no"}).status_code == 401
    assert client.get("/board?date=11-01-2025", headers=R).status_code == 422
    empty = client.get("/board?date=2025-12-25", headers=R).json()
    assert empty["games"] == []
