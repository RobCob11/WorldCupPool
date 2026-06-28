// Pulls World Cup data from API-Football (api-football186 on RapidAPI),
// computes pool standings using the PR x round-multiplier scoring system,
// and writes the results to data/standings.json, data/bracket.json, and
// appends a daily snapshot to data/history.json for rank-movement arrows.

const fs = require("fs");
const path = require("path");

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = "api-football186.p.rapidapi.com";
const COMPETITION_ID = 1382; // FIFA World Cup 2026

const DATA_DIR = path.join(__dirname, "..", "data");
const POOLS_PATH = path.join(DATA_DIR, "pools.json");
const STANDINGS_PATH = path.join(DATA_DIR, "standings.json");
const BRACKET_PATH = path.join(DATA_DIR, "bracket.json");
const HISTORY_PATH = path.join(DATA_DIR, "history.json");
const MATCHES_RAW_PATH = path.join(DATA_DIR, "matches-raw.json");

// Group-stage win = 1x, group draw = 0.5x. Knockout rounds scale by how far a team goes.
const KNOCKOUT_MULTIPLIERS = {
  "Round of 32": 3,
  "Round of 16": 5,
  "Quarterfinals": 7,
  "Semifinals": 9,
  "Match for 3rd place": 11,
  "Final": 15,
};

async function apiGet(endpoint, params = {}) {
  const url = new URL(`https://${RAPIDAPI_HOST}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: {
      "x-rapidapi-host": RAPIDAPI_HOST,
      "x-rapidapi-key": RAPIDAPI_KEY,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API request failed: ${endpoint} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`API did not return JSON for ${endpoint}: ${text.slice(0, 500)}`);
  }
}

function dedupeMatches(matches) {
  // The API occasionally lists the same fixture twice under different match IDs
  // (same teams, same kickoff time). Keep the verified/most-complete copy.
  const byFixture = new Map();
  for (const m of matches) {
    const key = `${m.timestampstart}_${Number(m.teams.home.tid)}_${Number(m.teams.away.tid)}`;
    const existing = byFixture.get(key);
    if (!existing) {
      byFixture.set(key, m);
      continue;
    }
    const existingScore = (existing.verified === "true" ? 2 : 0) + (existing.status_str === "result" ? 1 : 0);
    const candidateScore = (m.verified === "true" ? 2 : 0) + (m.status_str === "result" ? 1 : 0);
    if (candidateScore > existingScore) byFixture.set(key, m);
  }
  return Array.from(byFixture.values());
}

function isGroupStageRound(roundField) {
  // Group stage rounds are plain numeric strings like "1", "2", "3".
  return /^\d+$/.test(String(roundField).trim());
}

function multiplierFor(roundField) {
  if (isGroupStageRound(roundField)) return 1;
  return KNOCKOUT_MULTIPLIERS[roundField] || 0;
}

function sideForTeam(match, tid) {
  if (Number(match.teams.home.tid) === Number(tid)) return "home";
  if (Number(match.teams.away.tid) === Number(tid)) return "away";
  return null;
}

function matchResultForTeam(match, tid) {
  const side = sideForTeam(match, tid);
  if (!side) return null;
  if (match.status_str !== "result") return { side, outcome: "pending" };
  const winner = match.result.winner;
  let outcome;
  if (winner === side) outcome = "win";
  else if (winner === "draw") outcome = "draw";
  else outcome = "loss";
  return { side, outcome };
}

function pointsForMatch(match, tid, pr) {
  const result = matchResultForTeam(match, tid);
  if (!result || result.outcome === "pending") return 0;
  const mult = multiplierFor(match.round);
  const group = isGroupStageRound(match.round);
  if (result.outcome === "win") return mult * pr;
  if (result.outcome === "draw" && group) return 0.5 * pr;
  return 0;
}

function formBadgeForTeam(matches, tid) {
  const finished = matches
    .filter((m) => m.status_str === "result" && sideForTeam(m, tid))
    .sort((a, b) => b.timestampstart - a.timestampstart)
    .slice(0, 3);
  return finished.map((m) => {
    const r = matchResultForTeam(m, tid);
    if (r.outcome === "win") return "W";
    if (r.outcome === "draw") return "D";
    return "L";
  });
}

function isTeamLive(matches, tid) {
  return matches.some((m) => sideForTeam(m, tid) && m.status_str === "live");
}

async function main() {
  if (!RAPIDAPI_KEY) {
    throw new Error("RAPIDAPI_KEY environment variable is not set");
  }

  const pools = JSON.parse(fs.readFileSync(POOLS_PATH, "utf8"));

  // Single call: gives team list (with logos/flags), group point tables, and recent results.
  const infoRes = await apiGet(`/competition/${COMPETITION_ID}/info`);
  const compInfo = infoRes.response.items[0];
  const teamDirectory = new Map(compInfo.teams.map((t) => [Number(t.tid), t]));

  // Pull the full match list (paginated) so we have every group-stage and knockout match,
  // including ones not in "recent_matches".
  let rawMatches = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await apiGet(`/competition/${COMPETITION_ID}/matches`, {
      paged: page,
      per_page: 100,
    });
    rawMatches = rawMatches.concat(res.response.items);
    totalPages = res.response.total_pages;
    page++;
  } while (page <= totalPages);
  const allMatches = dedupeMatches(rawMatches);
  console.log(`Fetched ${rawMatches.length} raw matches across pagination (${allMatches.length} after de-duping). Used ${page - 1} request(s) for matches.`);

  const groupAndDrawMatches = allMatches; // contains both group + knockout

  // Cache of match timing/results, used by the scheduler job to set up precise
  // post-match refresh triggers, and by the history backfill script to recompute
  // past pool point totals - both without needing their own API calls.
  const matchesRawOutput = allMatches.map((m) => ({
    mid: m.mid,
    round: m.round,
    status: m.status_str,
    timestampstart: Number(m.timestampstart),
    timestampend: Number(m.timestampend),
    home: m.teams.home.tname,
    away: m.teams.away.tname,
    homeTid: Number(m.teams.home.tid),
    awayTid: Number(m.teams.away.tid),
    result: m.result,
  }));
  fs.writeFileSync(MATCHES_RAW_PATH, JSON.stringify(matchesRawOutput, null, 2));

  // ---- Compute standings ----
  const computedPools = pools.map((pool) => {
    const teams = pool.teams.map((team) => {
      const teamMatches = groupAndDrawMatches.filter((m) => sideForTeam(m, team.tid));
      const points = teamMatches.reduce(
        (sum, m) => sum + pointsForMatch(m, team.tid, team.pr),
        0
      );
      const apiTeam = teamDirectory.get(Number(team.tid));
      return {
        ...team,
        points: Math.round(points * 100) / 100,
        logo: apiTeam ? apiTeam.teamlogo : "",
        form: formBadgeForTeam(groupAndDrawMatches, team.tid),
        live: isTeamLive(groupAndDrawMatches, team.tid),
      };
    });
    const totalPoints = Math.round(
      teams.reduce((sum, t) => sum + t.points, 0) * 100
    ) / 100;
    const scoringCount = teams.filter((t) => t.points > 0).length;
    return {
      name: pool.name,
      totalPoints,
      scoringCount,
      live: teams.some((t) => t.live),
      teams: teams.sort((a, b) => b.points - a.points),
    };
  });

  computedPools.sort((a, b) => b.totalPoints - a.totalPoints);
  computedPools.forEach((p, i) => (p.rank = i + 1));

  // ---- Top performer (single highest-scoring team across the whole tournament) ----
  let topPerformer = null;
  for (const pool of computedPools) {
    for (const team of pool.teams) {
      if (!topPerformer || team.points > topPerformer.points) {
        topPerformer = { tid: team.tid, name: team.name, points: team.points, pool: pool.name };
      }
    }
  }
  if (topPerformer) {
    for (const pool of computedPools) {
      for (const team of pool.teams) {
        team.isTopPerformer = team.tid === topPerformer.tid;
      }
    }
  }

  // ---- Rank movement vs. yesterday's snapshot ----
  let history = [];
  if (fs.existsSync(HISTORY_PATH)) {
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  }
  const today = new Date().toISOString().slice(0, 10);
  const lastSnapshot = history.length ? history[history.length - 1] : null;
  const yesterdayRanks = new Map();
  if (lastSnapshot && lastSnapshot.date !== today) {
    lastSnapshot.pools.forEach((p) => yesterdayRanks.set(p.name, p.rank));
  } else if (history.length > 1) {
    history[history.length - 2].pools.forEach((p) => yesterdayRanks.set(p.name, p.rank));
  }
  computedPools.forEach((p) => {
    const prevRank = yesterdayRanks.get(p.name);
    p.rankChange = prevRank ? prevRank - p.rank : 0;
  });

  if (!lastSnapshot || lastSnapshot.date !== today) {
    history.push({
      date: today,
      pools: computedPools.map((p) => ({ name: p.name, rank: p.rank, totalPoints: p.totalPoints })),
    });
  } else {
    history[history.length - 1] = {
      date: today,
      pools: computedPools.map((p) => ({ name: p.name, rank: p.rank, totalPoints: p.totalPoints })),
    };
  }

  const groupMatchesCount = allMatches.filter(
    (m) => isGroupStageRound(m.round) && m.status_str === "result"
  ).length;
  const anyLive = allMatches.some((m) => m.status_str === "live");

  const standingsOutput = {
    updatedAt: new Date().toISOString(),
    stage: compInfo.status_str,
    groupMatchesScored: groupMatchesCount,
    live: anyLive,
    topPerformer,
    pools: computedPools,
  };

  fs.writeFileSync(STANDINGS_PATH, JSON.stringify(standingsOutput, null, 2));
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));

  // ---- Bracket: build the real tree by parsing the API's own "W<matchNumber>"/"L<matchNumber>"
  // placeholder codes, so connections between rounds are derived from data, not guessed.
  const bracketMatches = allMatches.filter((m) => !isGroupStageRound(m.round));
  // The W<n>/L<n> placeholder codes reference this same API's own match_number
  // field directly (confirmed: Round of 16 matches carry tnames like "w73"/"w75",
  // and those numbers are exactly the match_number values the API assigned to
  // the corresponding Round of 32 fixtures) - no separate numbering scheme needed.
  const matchByNumber = new Map();
  for (const m of bracketMatches) {
    matchByNumber.set(Number(m.match_number), m);
  }

  function resolveTeam(team) {
    const dirEntry = teamDirectory.get(Number(team.tid));
    const isPlaceholder = !dirEntry || dirEntry.iscountry !== "true";
    if (isPlaceholder) {
      return { tid: Number(team.tid), name: "TBD", abbr: "TBD", logo: "", placeholder: true };
    }
    return {
      tid: Number(team.tid),
      name: dirEntry.fullname || dirEntry.tname,
      abbr: team.abbr,
      logo: dirEntry.teamlogo || "",
      placeholder: false,
    };
  }

  function buildMatchObj(m) {
    return {
      mid: m.mid,
      matchNumber: Number(m.match_number),
      round: m.round,
      date: m.datestart,
      status: m.status_str,
      live: m.status_str === "live",
      home: resolveTeam(m.teams.home),
      away: resolveTeam(m.teams.away),
      result: m.result,
    };
  }

  function parseRef(tname) {
    const match = /^([WLwl])(\d+)$/.exec(String(tname).trim());
    if (!match) return null;
    return { type: match[1].toUpperCase(), num: Number(match[2]) };
  }

  function buildNode(matchNumber) {
    const m = matchByNumber.get(matchNumber);
    if (!m) return null;
    const homeRef = parseRef(m.teams.home.tname);
    const awayRef = parseRef(m.teams.away.tname);
    const children = [homeRef ? buildNode(homeRef.num) : null, awayRef ? buildNode(awayRef.num) : null].filter(
      Boolean
    );
    return { match: buildMatchObj(m), children: children.length ? children : undefined };
  }

  const finalMatch = bracketMatches.find((m) => m.round === "Final");
  const bronzeMatch = bracketMatches.find((m) => m.round === "Match for 3rd place");

  let leftNode = null;
  let rightNode = null;
  if (finalMatch) {
    const homeRef = parseRef(finalMatch.teams.home.tname);
    const awayRef = parseRef(finalMatch.teams.away.tname);
    leftNode = homeRef ? buildNode(homeRef.num) : null;
    rightNode = awayRef ? buildNode(awayRef.num) : null;
  }

  const bracketOutput = {
    updatedAt: new Date().toISOString(),
    final: finalMatch ? buildMatchObj(finalMatch) : null,
    bronze: bronzeMatch ? buildMatchObj(bronzeMatch) : null,
    left: leftNode,
    right: rightNode,
  };

  fs.writeFileSync(BRACKET_PATH, JSON.stringify(bracketOutput, null, 2));

  console.log(`Updated standings (${computedPools.length} pools) and bracket (${bracketMatches.length} knockout matches).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
