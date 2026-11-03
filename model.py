"""First-basket rates from stored history, and grading of predictions."""
import math

STARTER_PRIOR_RATE = 0.1  # one of ten starters, before seeing any games
MIN_PROBABILITY = 1e-6


def smoothed_rate(first_baskets, starts, prior_games):
    """Shrink a player's observed rate toward the 1-in-10 starter prior."""
    return (first_baskets + prior_games * STARTER_PRIOR_RATE) / (
        starts + prior_games
    )


def normalize(players):
    total = sum(p["smoothed_rate"] for p in players)
    for p in players:
        p["probability"] = round(p["smoothed_rate"] / total, 6)
    return players


def grade(candidates, actual_player_id):
    """Score one prediction set against the actual first scorer.

    Probability mass not assigned to any listed player is treated as an
    "anyone else" bucket, so a set that missed the scorer still gets a
    finite (but bad) log loss.
    """
    probs = {c["player_id"]: c["probability"] for c in candidates}
    other = max(0.0, 1.0 - sum(probs.values()))
    hit_listed = actual_player_id in probs
    p_actual = probs[actual_player_id] if hit_listed else other
    log_loss = -math.log(max(p_actual, MIN_PROBABILITY))
    brier = sum(
        (p - (1.0 if pid == actual_player_id else 0.0)) ** 2
        for pid, p in probs.items()
    ) + (other - (0.0 if hit_listed else 1.0)) ** 2
    top = max(candidates, key=lambda c: c["probability"])
    return {
        "top_pick_hit": top["player_id"] == actual_player_id,
        "actual_in_candidates": hit_listed,
        "probability_of_actual": round(p_actual, 6),
        "log_loss": round(log_loss, 6),
        "brier": round(brier, 6),
    }


def summarize(grades):
    n = len(grades)
    if not n:
        return {"graded_games": 0}
    return {
        "graded_games": n,
        "top_pick_hit_rate": round(
            sum(g["top_pick_hit"] for g in grades) / n, 4),
        "mean_log_loss": round(sum(g["log_loss"] for g in grades) / n, 4),
        "mean_brier": round(sum(g["brier"] for g in grades) / n, 4),
    }


def compare(pairs, min_games=30):
    """Paired comparison of two models' grades on the same games.

    log_loss_diff is model A minus model B (negative means A is better);
    z uses the paired standard error. The verdict needs min_games games.
    """
    n = len(pairs)
    out = {"shared_games": n}
    if not n:
        out["verdict"] = "no games graded for both models yet"
        return out
    a = summarize([p[0] for p in pairs])
    b = summarize([p[1] for p in pairs])
    diffs = [p[0]["log_loss"] - p[1]["log_loss"] for p in pairs]
    mean = sum(diffs) / n
    se = None
    if n > 1:
        var = sum((d - mean) ** 2 for d in diffs) / (n - 1)
        se = math.sqrt(var / n)
    z = mean / se if se else None
    out.update({
        "model_a_summary": a,
        "model_b_summary": b,
        "log_loss_diff": round(mean, 4),
        "log_loss_diff_se": round(se, 4) if se is not None else None,
        "z": round(z, 2) if z is not None else None,
        "model_a_better_games": sum(d < 0 for d in diffs),
    })
    if n < min_games:
        out["verdict"] = f"too early: {n} shared games (need {min_games}+)"
    elif z is not None and z < -1.96:
        out["verdict"] = "model_a is better (log loss, 95%)"
    elif z is not None and z > 1.96:
        out["verdict"] = "model_b is better (log loss, 95%)"
    else:
        out["verdict"] = "no clear difference yet"
    return out
