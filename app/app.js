/* Edge Intelligence app (Stage 3 MVP).
 * Reads only the API's read endpoints. Shows nothing it did not receive:
 * a missing value is shown as missing, and a failed request as unavailable. */
(function () {
  "use strict";

  // ---------- settings (per device) ----------
  var CFG_KEY = "edge.cfg.v1";
  function loadCfg() {
    var d = { base: defaultBase(), key: "" };
    try {
      var s = JSON.parse(localStorage.getItem(CFG_KEY) || "{}");
      if (s && typeof s === "object") {
        if (s.base) d.base = s.base;
        if (s.key) d.key = s.key;
      }
    } catch (e) { /* private mode: settings last for this visit only */ }
    return d;
  }
  function saveCfg(c) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) { /* ignore */ }
  }
  function defaultBase() {
    // served by the API at /app: the API is the same origin
    return location.protocol.indexOf("http") === 0 ? location.origin : "";
  }
  var cfg = loadCfg();

  // ---------- helpers ----------
  var $view = document.getElementById("view");
  var $status = document.getElementById("status");
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pct(p, d) { return p == null ? "—" : (p * 100).toFixed(d == null ? 1 : d) + "%"; }
  function odds(o) { return o == null ? "—" : (o > 0 ? "+" : "") + Math.round(o); }
  function signed(v, d, unit) {
    if (v == null) return "—";
    var s = v.toFixed(d == null ? 2 : d);
    return (v > 0 ? "+" : "") + s + (unit || "");
  }
  function cls(v) { return v == null ? "" : v > 0 ? "pos" : v < 0 ? "neg" : ""; }
  function fmtTime(iso) {
    if (!iso) return "time not verified";
    var d = new Date(iso);
    if (isNaN(d)) return "time not verified";
    return d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  }
  function fmtAgo(iso) {
    if (!iso) return "never";
    var m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (isNaN(m)) return "unknown";
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    if (m < 48 * 60) return Math.round(m / 60) + " h ago";
    return Math.round(m / 1440) + " days ago";
  }
  function localDay(offset) {
    var d = new Date(); d.setDate(d.getDate() + (offset || 0));
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function shiftDay(day, n) {
    var p = day.split("-").map(Number), d = new Date(p[0], p[1] - 1, p[2] + n);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function dayLabel(day) {
    var p = day.split("-").map(Number), d = new Date(p[0], p[1] - 1, p[2]);
    var t = localDay(0);
    var name = day === t ? "Today" : day === shiftDay(t, 1) ? "Tomorrow" : day === shiftDay(t, -1) ? "Yesterday" : "";
    var s = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    return name ? name + " · " + s : s;
  }

  var MARKET_LABEL = {
    nba_first_fg: "First field goal", nba_first_point: "First point (FT counts)",
    nba_team_first_score: "Team to score first", nba_tip: "Opening tip",
    nba_player_prop: "Player prop", nba_three_pointers: "Threes made",
    nfl_anytime_td: "Anytime TD", nfl_first_td: "First TD", nfl_2plus_td: "2+ TDs",
    nfl_3plus_td: "3+ TDs", nfl_player_prop: "Player prop", nfl_spread: "Spread",
    nfl_total: "Total", nfl_moneyline: "Moneyline",
    cfb_spread: "Spread", cfb_total: "Total", cfb_moneyline: "Moneyline"
  };
  var SPORT_TABS = {
    nfl: { title: "NFL Intelligence", sub: "Touchdowns, player props and game lines.",
      groups: [["TDs", ["nfl_anytime_td", "nfl_first_td", "nfl_2plus_td", "nfl_3plus_td"]],
               ["Props", ["nfl_player_prop"]], ["Game", ["nfl_spread", "nfl_total", "nfl_moneyline"]]] },
    nba: { title: "NBA Intelligence", sub: "First basket, tip-off and player props.",
      groups: [["First FG", ["nba_first_fg"]], ["First point", ["nba_first_point"]],
               ["Team / tip", ["nba_team_first_score", "nba_tip"]],
               ["Props", ["nba_player_prop", "nba_three_pointers"]]] },
    cfb: { title: "College Football", sub: "Spreads, totals and moneylines against the market.",
      groups: [["Spread", ["cfb_spread"]], ["Total", ["cfb_total"]], ["Moneyline", ["cfb_moneyline"]]] }
  };
  var FLAG_LABEL = {
    settlement_rule_unconfirmed: "book's settlement rule unconfirmed",
    backfilled_after_start: "recorded after the start",
    price_dropped_settlement_mismatch: "price removed: wrong market for that book",
    no_kickoff_time: "kickoff time not verified",
    excluded_by_v7: "excluded by the model's own checks"
  };

  // ---------- API ----------
  function ApiError(kind, msg) { this.kind = kind; this.message = msg; }
  function api(path, params) {
    if (!cfg.base) return Promise.reject(new ApiError("setup", "No API address set."));
    if (!cfg.key) return Promise.reject(new ApiError("setup", "No access key set."));
    var u = new URL(path, cfg.base);
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] != null && params[k] !== "") u.searchParams.set(k, params[k]);
    });
    return fetch(u.toString(), { headers: { "X-API-Key": cfg.key }, cache: "no-store" })
      .catch(function () { throw new ApiError("down", "The data service is unavailable."); })
      .then(function (r) {
        if (r.status === 401) throw new ApiError("key", "The access key was not accepted.");
        if (!r.ok) throw new ApiError("down", "The data service answered " + r.status + ".");
        return r.json();
      });
  }
  function health() {
    $status.className = "status";
    $status.querySelector(".label").textContent = "Checking";
    if (!cfg.base) return setStatus("bad", "Not set up");
    fetch(new URL("/health", cfg.base).toString(), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (h) {
        if (h.status !== "ok") return setStatus("warn", "Degraded");
        setStatus(cfg.key ? "ok" : "warn", cfg.key ? "Live data" : "Needs key");
      })
      .catch(function () { setStatus("bad", "Unavailable"); });
  }
  function setStatus(c, label) {
    $status.className = "status " + c;
    $status.querySelector(".label").textContent = label;
  }
  $status.addEventListener("click", function () { location.hash = "#/membership"; });

  function errorBlock(err) {
    if (err && err.kind === "setup") {
      return '<div class="card empty"><strong>Connect to your data</strong>' + esc(err.message) +
        ' Add the read-only access key under Account.<div style="margin-top:12px"><a class="btn primary" href="#/membership" style="display:inline-block;text-decoration:none">Open Account</a></div></div>';
    }
    if (err && err.kind === "key") {
      return '<div class="card empty"><strong>Access key not accepted</strong>Check the key under Account.</div>';
    }
    return '<div class="card empty"><strong>Unavailable</strong>' + esc(err && err.message || "Could not load data.") +
      ' Nothing is shown rather than old or guessed numbers.</div>';
  }

  // ---------- pick card ----------
  function pickCard(i, showMarket) {
    var live = i.status === "live";
    var decision = live ? '<span class="pill ' + (i.decision === "BET" ? "bet" : "pass") + '">' + esc(i.decision) + "</span>"
      : '<span class="pill stale" title="Not a current prediction">' + esc(i.status === "started" ? "STARTED" : "NOT CURRENT") + "</span>";
    var mkt = i.market_prob != null ? i.market_prob : i.price_implied_prob;
    var mktLabel = i.market_prob != null ? "Market (no vig)" : "Price implies";
    var line = i.line != null ? " " + (i.market.indexOf("spread") > -1 && i.line > 0 ? "+" : "") + i.line : "";
    var side = i.side && i.side !== i.selection && i.side !== "Yes" ? " · " + i.side + line : (line ? " ·" + line : "");
    var bar = i.model_prob != null ? '<div class="probbar" aria-hidden="true"><i style="width:' + Math.min(100, i.model_prob * 100).toFixed(1) + '%"></i>' +
      (mkt != null ? '<b style="left:calc(' + Math.min(100, mkt * 100).toFixed(1) + '% - 1px)"></b>' : "") + "</div>" : "";
    var flags = (i.data_flags || []).filter(function (f) { return FLAG_LABEL[f] || f.indexOf("lineup_") === 0; })
      .map(function (f) { return '<span class="flag' + (f === "lineup_confirmed" ? " ok" : "") + '">' + esc(FLAG_LABEL[f] || f.replace("lineup_", "lineup: ").replace(/_/g, " ")) + "</span>"; }).join("");
    if (!live) flags = '<span class="flag">' + esc(i.status) + "</span>" + flags;
    var price = i.odds_american != null
      ? "Price " + esc(odds(i.odds_american)) + (i.book ? " at " + esc(i.book) : "") + (i.price_at ? " · " + esc(fmtAgo(i.price_at)) : "")
      : "No verified price";
    return '<article class="card">' +
      '<div class="pick-head"><div><div class="pick-name">' + esc(i.selection) + esc(side) + '</div>' +
      '<div class="pick-sub">' + (showMarket ? esc(MARKET_LABEL[i.market] || i.market) + " · " : "") + esc(i.event_label) + " · " + esc(fmtTime(i.event_start_utc)) + "</div></div>" + decision + "</div>" +
      '<dl class="nums">' +
      "<div><dt>Model</dt><dd>" + pct(i.model_prob) + "</dd></div>" +
      "<div><dt>" + mktLabel + "</dt><dd>" + pct(mkt) + "</dd></div>" +
      "<div><dt>Fair odds</dt><dd>" + odds(i.fair_odds) + "</dd></div>" +
      '<div><dt>EV / unit</dt><dd class="' + cls(i.expected_value) + '">' + (i.expected_value == null ? "—" : signed(i.expected_value * 100, 1, "%")) + "</dd></div>" +
      "</dl>" + bar +
      '<div class="row spread meta" style="margin-top:8px"><span>' + price + "</span><span>" + esc(i.model_version) + " · " + esc(fmtAgo(i.predicted_at)) + "</span></div>" +
      (flags ? '<div class="flags">' + flags + "</div>" : "") +
      "</article>";
  }

  function dateBar(day) {
    return '<div class="datebar"><button type="button" data-day="' + shiftDay(day, -1) + '" aria-label="Previous day">‹</button>' +
      '<div class="day">' + esc(dayLabel(day)) + '</div><button type="button" data-day="' + shiftDay(day, 1) + '" aria-label="Next day">›</button></div>';
  }
  function seg(name, options, current) {
    return '<div class="seg" role="group" data-seg="' + name + '">' + options.map(function (o) {
      return '<button type="button" data-val="' + esc(o[0]) + '" aria-pressed="' + (String(o[0]) === String(current)) + '">' + esc(o[1]) + "</button>";
    }).join("") + "</div>";
  }

  // ---------- state ----------
  var state = { day: localDay(0), homeSport: "", group: { nfl: 0, nba: 0, cfb: 0 },
    perfKind: "prediction", perfSport: "", perfGroup: "market" };

  // ---------- views ----------
  function viewHome() {
    var head = "<h1>Today's Edge Board</h1><p class=\"sub\">Model probability against the market, across every sport. Only predictions made before the start are shown as current.</p>" +
      dateBar(state.day) + seg("homeSport", [["", "All"], ["nfl", "NFL"], ["nba", "NBA"], ["cfb", "CFB"]], state.homeSport) + '<div style="height:12px"></div>';
    render(head + '<div id="body"><div class="card empty">Loading…</div></div>');
    api("/ledger/board", { date: state.day, sport: state.homeSport }).then(function (b) {
      var items = b.items, live = items.filter(function (i) { return i.status === "live"; });
      var bets = live.filter(function (i) { return i.decision === "BET"; });
      var versions = {}; items.forEach(function (i) { versions[i.sport + " " + i.model_version] = 1; });
      var h = '<div class="tiles" style="margin-top:12px">' +
        tile("Current", String(b.counts.live), "made pregame, not started") +
        tile("Rated BET", String(bets.length), "of the current rows") +
        tile("Started", String(b.counts.started), "no longer current") +
        tile("Not verified", String(b.counts["start time not verified"] + b.counts["made after the start"]), "start or timing unverified") + "</div>";
      if (!items.length) {
        h += '<div class="card empty" style="margin-top:12px"><strong>No predictions for this day</strong>Nothing has been recorded for ' + esc(dayLabel(state.day)) + ". No picks are made up to fill the board.</div>";
      } else {
        h += "<h2>Best model-rated opportunities</h2>";
        h += bets.length ? bets.slice(0, 10).map(function (i) { return pickCard(i, true); }).join("")
          : '<div class="card empty"><strong>No BET today</strong>The models rate every current row PASS. Not every day has an edge, and none is forced.</div>';
        var rest = live.filter(function (i) { return i.decision !== "BET"; }).slice(0, 10);
        if (rest.length) h += "<h2>Highest-value PASS rows</h2>" + rest.map(function (i) { return pickCard(i, true); }).join("");
        var other = items.filter(function (i) { return i.status !== "live"; });
        if (other.length) h += '<h2>Not current</h2><p class="sub">' + other.length + " rows started, or their timing could not be verified. Open a sport tab to see them.</p>";
      }
      h += '<p class="meta">Last prediction ' + esc(fmtAgo(b.last_prediction_at)) + " · board built " + esc(fmtTime(b.generated_at)) +
        (Object.keys(versions).length ? " · models: " + esc(Object.keys(versions).join(", ")) : "") + "</p>";
      setBody(h);
    }).catch(function (e) { setBody(errorBlock(e)); });
  }

  function viewSport(sport) {
    var t = SPORT_TABS[sport], g = state.group[sport];
    var note = sport === "nba" ? '<div class="notice">First field goal and first point are separate markets because books settle them differently. FanDuel prices count only for first point; DraftKings and BetMGM only for first field goal.</div>' : "";
    var head = "<h1>" + esc(t.title) + '</h1><p class="sub">' + esc(t.sub) + "</p>" + dateBar(state.day) +
      seg("group-" + sport, t.groups.map(function (x, n) { return [n, x[0]]; }), g) + '<div style="height:12px"></div>' + note;
    render(head + '<div id="body"><div class="card empty">Loading…</div></div>');
    api("/ledger/board", { date: state.day, sport: sport }).then(function (b) {
      var markets = t.groups[g][1];
      var items = b.items.filter(function (i) { return markets.indexOf(i.market) > -1; });
      if (!items.length) return setBody('<div class="card empty"><strong>Nothing recorded</strong>No ' + esc(t.groups[g][0]) + " predictions for " + esc(dayLabel(state.day)) + ".</div>");
      var games = {};
      items.forEach(function (i) { (games[i.event_label] = games[i.event_label] || []).push(i); });
      var startOf = function (k) { return games[k].reduce(function (m, i) { return i.event_start_utc && (!m || i.event_start_utc < m) ? i.event_start_utc : m; }, null) || "9999"; };
      var order = Object.keys(games).sort(function (a, c) { var x = startOf(a), y = startOf(c); return x < y ? -1 : x > y ? 1 : a < c ? -1 : 1; });
      setBody(order.map(function (k) {
        var rows = games[k].sort(function (a, c) { return (c.model_prob || 0) - (a.model_prob || 0); });
        var shown = rows.slice(0, 12);
        return '<div class="game-head"><strong>' + esc(k) + "</strong><span>" + esc(fmtTime(rows[0].event_start_utc)) + "</span></div>" +
          shown.map(function (i) { return pickCard(i, markets.length > 1); }).join("") +
          (rows.length > shown.length ? '<p class="meta">' + (rows.length - shown.length) + " lower-probability rows not shown.</p>" : "");
      }).join("") + '<p class="meta">Last prediction ' + esc(fmtAgo(b.last_prediction_at)) + "</p>");
    }).catch(function (e) { setBody(errorBlock(e)); });
  }

  function tile(k, v, n, c) {
    return '<div class="tile"><div class="k">' + esc(k) + '</div><div class="v ' + (c || "") + '">' + v + '</div><div class="n">' + esc(n || "") + "</div></div>";
  }

  function viewPerformance() {
    var kinds = [["prediction", "Predictions"], ["paper_bet", "Paper bets"], ["real_bet", "Real bets"]];
    var head = "<h1>Performance Center</h1><p class=\"sub\">Every prediction is recorded before the game and never edited or deleted. Losses stay on the record.</p>" +
      seg("perfKind", kinds, state.perfKind) +
      '<div class="row" style="margin:10px 0 4px"><div style="flex:1;min-width:130px"><select id="perfSport" aria-label="Sport">' +
      [["", "All sports"], ["nfl", "NFL"], ["nba", "NBA"], ["cfb", "College football"]].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === state.perfSport ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") +
      '</select></div><div style="flex:1;min-width:130px"><select id="perfGroup" aria-label="Break down by">' +
      [["market", "By market"], ["sport", "By sport"], ["model_version", "By model version"], ["odds_band", "By odds range"]].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === state.perfGroup ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") +
      "</select></div></div>";
    render(head + '<div id="body"><div class="card empty">Loading…</div></div>');
    document.getElementById("perfSport").onchange = function (e) { state.perfSport = e.target.value; viewPerformance(); };
    document.getElementById("perfGroup").onchange = function (e) { state.perfGroup = e.target.value; viewPerformance(); };
    api("/ledger/performance", { kind: state.perfKind, sport: state.perfSport, group_by: state.perfGroup }).then(function (r) {
      var block = r.performance[state.perfKind];
      if (!block) return setBody('<div class="card empty"><strong>No records yet</strong>Nothing of this kind has been recorded' + (state.perfSport ? " for this sport" : "") + ". Results appear here as games are graded.</div>");
      var a = block.all, h = "";
      if (state.perfKind === "paper_bet") h += '<div class="notice">Paper results: no money was wagered. They are tracked to test the models, and are not a record of real profit.</div>';
      if (state.perfKind === "real_bet") h += '<div class="notice">Your own logged wagers, kept apart from model and paper results.</div>';
      var ex = Object.keys(a.excluded || {}).map(function (k) { return a.excluded[k] + " " + k; });
      h += '<div class="tiles">' +
        tile("Recorded", String(a.entries), a.awaiting_result + " awaiting result") +
        tile("Settled", String(a.settled), a.pushes_or_voids + " push or void");
      if (a.probability) {
        var p = a.probability;
        h += tile("Hit rate", pct(p.hit_rate), "model expected " + pct(p.mean_model_prob)) +
          tile("Brier score", p.brier.toFixed(4), "lower is better; n=" + p.n) +
          tile("Log loss", p.log_loss.toFixed(4), "lower is better");
      }
      if (a.betting) {
        var bt = a.betting;
        h += tile("Record", bt.wins + "-" + bt.losses + (bt.pushes_or_voids ? "-" + bt.pushes_or_voids : ""), bt.win_pct == null ? "" : pct(bt.win_pct) + " wins") +
          tile("Units", signed(bt.units, 2), bt.units_risked.toFixed(2) + " risked", cls(bt.units)) +
          tile("ROI", bt.roi == null ? "—" : signed(bt.roi * 100, 1, "%"), "per unit risked", cls(bt.roi));
      }
      var c = a.clv;
      h += tile("Price CLV", c.mean_price_clv == null ? "—" : signed(c.mean_price_clv * 100, 2, " pts"), c.with_close + " with a closing price", cls(c.mean_price_clv)) +
        tile("Beat the close", pct(c.beat_close_rate), c.missing_close + " missing a close") +
        (c.with_line_close ? tile("Line CLV", signed(c.mean_line_clv_pts, 2, " pts"), c.with_line_close + " with a closing line", cls(c.mean_line_clv_pts)) : "") +
        "</div>";
      if (ex.length) h += '<p class="meta" style="margin-top:10px">Not counted: ' + esc(ex.join(", ")) + ". Only predictions made before the start count; the rows stay on the record.</p>";
      if (a.probability && a.probability.calibration.length) h += "<h2>Calibration</h2>" + calibrationChart(a.probability.calibration);
      var by = block["by_" + state.perfGroup];
      if (by) h += "<h2>Breakdown</h2>" + breakdownTable(by, state.perfGroup);
      h += '<p class="meta" style="margin-top:12px">' + r.rules.map(esc).join(" ") + "</p>";
      setBody(h);
      wireChart();
    }).catch(function (e) { setBody(errorBlock(e)); });
  }

  function breakdownTable(by, group) {
    var keys = Object.keys(by);
    var rows = keys.map(function (k) {
      var s = by[k], p = s.probability || {}, b = s.betting || {};
      var label = group === "market" ? (MARKET_LABEL[k] || k) : group === "sport" ? k.toUpperCase() : k;
      return "<tr><td>" + esc(label) + "</td><td>" + s.settled + "</td><td>" + pct(p.hit_rate) + "</td><td>" + (p.brier == null ? "—" : p.brier.toFixed(4)) +
        "</td><td>" + (b.units == null ? "—" : '<span class="' + cls(b.units) + '">' + signed(b.units, 2) + "</span>") +
        "</td><td>" + (b.roi == null ? "—" : signed(b.roi * 100, 1, "%")) + "</td><td>" + (s.clv.mean_price_clv == null ? "—" : signed(s.clv.mean_price_clv * 100, 2)) + "</td></tr>";
    }).join("");
    return '<div class="tablewrap"><table><thead><tr><th>' + esc({ market: "Market", sport: "Sport", model_version: "Model", odds_band: "Odds" }[group]) +
      "</th><th>Settled</th><th>Hit</th><th>Brier</th><th>Units</th><th>ROI</th><th>CLV pts</th></tr></thead><tbody>" + rows + "</tbody></table></div>";
  }

  // Reliability diagram: one series (observed rate per probability bin)
  // against the dashed line of perfect calibration. Hover or tap a dot.
  function calibrationChart(bins) {
    var W = 320, H = 220, L = 40, R = 12, T = 12, B = 34;
    var maxP = Math.max(0.1, Math.min(1, Math.ceil(Math.max.apply(null, bins.map(function (b) { return Math.max(b.mean_model_prob, b.observed_rate); })) * 10) / 10));
    function x(v) { return L + (v / maxP) * (W - L - R); }
    function y(v) { return H - B - (v / maxP) * (H - T - B); }
    var ticks = [0, maxP / 2, maxP];
    var g = ticks.map(function (t) {
      return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t) + '" y2="' + y(t) + '" stroke="var(--line)" stroke-width="1"/>' +
        '<text x="' + (L - 6) + '" y="' + (y(t) + 4) + '" fill="var(--muted)" font-size="10" text-anchor="end">' + Math.round(t * 100) + "%</text>" +
        '<text x="' + x(t) + '" y="' + (H - B + 14) + '" fill="var(--muted)" font-size="10" text-anchor="middle">' + Math.round(t * 100) + "%</text>";
    }).join("");
    var maxN = Math.max.apply(null, bins.map(function (b) { return b.n; }));
    var dots = bins.map(function (b) {
      var r = 4 + 4 * Math.sqrt(b.n / maxN);
      return '<g class="pt" data-tip="' + esc("Model " + pct(b.mean_model_prob) + " · happened " + pct(b.observed_rate) + " · " + b.n + " settled") + '">' +
        '<circle cx="' + x(b.mean_model_prob) + '" cy="' + y(b.observed_rate) + '" r="14" fill="transparent"/>' +
        '<circle cx="' + x(b.mean_model_prob) + '" cy="' + y(b.observed_rate) + '" r="' + r.toFixed(1) + '" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/></g>';
    }).join("");
    var table = '<details style="margin-top:8px"><summary class="meta">Show as table</summary><div class="tablewrap" style="margin-top:6px"><table><thead><tr><th>Bin</th><th>Settled</th><th>Model</th><th>Happened</th></tr></thead><tbody>' +
      bins.map(function (b) { return "<tr><td>" + esc(b.bin) + "</td><td>" + b.n + "</td><td>" + pct(b.mean_model_prob) + "</td><td>" + pct(b.observed_rate) + "</td></tr>"; }).join("") +
      "</tbody></table></div></details>";
    return '<div class="chart" id="calib"><svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Calibration: model probability against how often it happened">' + g +
      '<line x1="' + x(0) + '" y1="' + y(0) + '" x2="' + x(maxP) + '" y2="' + y(maxP) + '" stroke="var(--muted)" stroke-width="2" stroke-dasharray="4 4"/>' + dots +
      '<text x="' + ((L + W - R) / 2) + '" y="' + (H - 4) + '" fill="var(--text-2)" font-size="11" text-anchor="middle">Model probability</text>' +
      '<text transform="translate(11 ' + ((T + H - B) / 2) + ') rotate(-90)" fill="var(--text-2)" font-size="11" text-anchor="middle">How often it happened</text>' +
      '</svg><div class="tip" role="status"></div><div class="legend"><span><i></i>Settled predictions (size = count)</span><span><i class="line"></i>Perfect calibration</span></div>' + table + "</div>";
  }
  function wireChart() {
    var box = document.getElementById("calib"); if (!box) return;
    var tip = box.querySelector(".tip");
    function show(e) {
      var g = e.target.closest(".pt"); if (!g) { tip.style.display = "none"; return; }
      var c = g.querySelector("circle"), rb = box.getBoundingClientRect(), cb = c.getBoundingClientRect();
      tip.textContent = g.getAttribute("data-tip"); tip.style.display = "block";
      var left = cb.left - rb.left + cb.width / 2 - tip.offsetWidth / 2;
      tip.style.left = Math.max(4, Math.min(rb.width - tip.offsetWidth - 4, left)) + "px";
      tip.style.top = Math.max(4, cb.top - rb.top - tip.offsetHeight - 6) + "px";
    }
    box.addEventListener("pointermove", show);
    box.addEventListener("click", show);
    box.addEventListener("pointerleave", function () { tip.style.display = "none"; });
  }

  function viewMembership() {
    var tiers = [
      ["Free", "$0", ["Selected games each day", "The full Performance Center", "Basic history"]],
      ["Pro", "$14.99/mo", ["All three sports", "Full probabilities, fair odds and value", "Performance history by market"]],
      ["Elite", "$29.99/mo", ["Everything in Pro", "Advanced breakdowns and filters", "CLV tracking and detailed reports"]]
    ];
    var h = "<h1>Membership</h1><p class=\"sub\">Proposed tiers. Sign-up and payments open after the private beta; nothing is charged today.</p>" +
      tiers.map(function (t) {
        return '<div class="card tier"><div class="row spread"><strong style="font-size:17px">' + esc(t[0]) + '</strong><span class="price num">' + esc(t[1]) + "</span></div><ul>" +
          t[2].map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul></div>";
      }).join("") +
      "<h2>Data connection</h2><p class=\"sub\">Private beta: enter the read-only access key you were given. It is kept on this device only, and can read the board and record but cannot change anything.</p>" +
      '<form id="cfg" class="card" autocomplete="off">' +
      '<label class="field"><span>API address</span><input type="url" id="cfgBase" inputmode="url" value="' + esc(cfg.base) + '" placeholder="https://your-api.onrender.com"></label>' +
      '<label class="field"><span>Read-only access key</span><input type="password" id="cfgKey" value="' + esc(cfg.key) + '" placeholder="Paste key"></label>' +
      '<div class="row"><button class="btn primary" type="submit">Save and test</button><button class="btn" type="button" id="cfgClear">Forget key</button></div>' +
      '<p class="meta" id="cfgMsg" role="status" style="margin:10px 0 0"></p></form>' +
      "<h2>Play responsibly</h2><div class=\"card\"><p style=\"margin:0 0 8px\">Edge Intelligence publishes model probabilities and a full record. It does not promise wins, and past results don't predict future ones.</p>" +
      '<p class="meta" style="margin:0">21+ only, where sports betting is legal. Help is free and confidential: call or text 1-800-GAMBLER, or visit ncpgambling.org.</p></div>' +
      '<p class="meta">App version 0.3.0 (Stage 3 MVP)</p>';
    render(h);
    var msg = document.getElementById("cfgMsg");
    document.getElementById("cfg").onsubmit = function (e) {
      e.preventDefault();
      var base = document.getElementById("cfgBase").value.trim().replace(/\/+$/, "");
      if (base && !/^https?:\/\//.test(base)) { msg.textContent = "The address must start with https://"; return; }
      cfg = { base: base, key: document.getElementById("cfgKey").value.trim() };
      saveCfg(cfg); msg.textContent = "Testing…";
      api("/ledger/markets").then(function () { msg.textContent = "Connected. Live data is on."; health(); })
        .catch(function (err) { msg.textContent = err.message; health(); });
    };
    document.getElementById("cfgClear").onclick = function () {
      cfg.key = ""; saveCfg(cfg); document.getElementById("cfgKey").value = ""; msg.textContent = "Key removed from this device."; health();
    };
  }

  // ---------- router ----------
  function render(html) { $view.innerHTML = html; wire(); }
  function setBody(html) { var b = document.getElementById("body"); if (b) { b.innerHTML = html; wire(); } }
  function wire() {
    $view.querySelectorAll("[data-day]").forEach(function (b) {
      b.onclick = function () { state.day = b.getAttribute("data-day"); route(); };
    });
    $view.querySelectorAll("[data-seg]").forEach(function (s) {
      s.querySelectorAll("button").forEach(function (b) {
        b.onclick = function () {
          var name = s.getAttribute("data-seg"), v = b.getAttribute("data-val");
          if (name.indexOf("group-") === 0) state.group[name.slice(6)] = Number(v);
          else state[name] = v;
          route();
        };
      });
    });
  }
  function route() {
    var tab = (location.hash.replace(/^#\/?/, "") || "home").split("?")[0];
    if (["home", "nfl", "nba", "cfb", "performance", "membership"].indexOf(tab) < 0) tab = "home";
    document.querySelectorAll(".tabs a").forEach(function (a) {
      if (a.getAttribute("data-tab") === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (tab === "home") viewHome();
    else if (tab === "performance") viewPerformance();
    else if (tab === "membership") viewMembership();
    else viewSport(tab);
  }
  window.addEventListener("hashchange", function () { route(); window.scrollTo(0, 0); });
  health();
  route();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(function () { /* app still works online */ });
  }
})();
