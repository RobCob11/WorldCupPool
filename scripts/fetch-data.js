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

// Group-stage win = 1x, group draw = 0.5x. Knockout rounds scale by how far a team goes.
const KNOCKOUT_MULTIPLIERS = {
  "Round of 32": 3,
  "Round of 16": 5,
  "Quarterfinals": 7,
  "Semifinals": 9,
  "Match for 3rd place": 11,
  "Final": 15,
};

const KNOCKOUT_ORDER = [
  "Round of 32",
  "Round of 16",
  "Quarterfinals",
  "Semifinals",
  "Match for 3rd place",
  "Final",
];

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

function isGroupStageRound(roundField) {
  // Group stage rounds are plain numeric strings like "1", "2", "3".
  return /^\d+$/.test(String(roundField).trim());
}

function multiplierFor(roundField) {
  if (isGroupStageRound(roundField)) return 1;
  return KNOCKOUT_MULTIPLIERS[roundField] || 0;
}

function isPlaceholderTeam(team) {
  // Unresolved bracket slots come back with no logo and short placeholder codes (e.g. "1A", "W95").
  return !team.logo;
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
  // per_page large enough to grab the whole tournament (105 matches) in a single call,
  // so we stay well within the 100 requests/day free-tier limit.
  const matchesRes = await apiGet(`/competition/${COMPETITION_ID}/matches`, {
    paged: 1,
    per_page: 200,
  });
  const allMatches = matchesRes.response.items;

  const groupAndDrawMatches = allMatches; // contains both group + knockout

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

  // ---- Bracket ----
  const bracketMatches = allMatches.filter((m) => !isGroupStageRound(m.round));
  const bracket = KNOCKOUT_ORDER.map((roundName) => ({
    round: roundName,
    matches: bracketMatches
      .filter((m) => m.round === roundName)
      .sort((a, b) => a.match_number - b.match_number)
      .map((m) => ({
        mid: m.mid,
        matchNumber: m.match_number,
        date: m.datestart,
        status: m.status_str,
        live: m.status_str === "live",
        home: teamOrPlaceholder(m.teams.home),
        away: teamOrPlaceholder(m.teams.away),
        result: m.result,
      })),
  }));

  fs.writeFileSync(BRACKET_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), bracket }, null, 2));

  console.log(`Updated standings (${computedPools.length} pools) and bracket (${bracketMatches.length} knockout matches).`);
}

function teamOrPlaceholder(team) {
  if (isPlaceholderTeam(team)) {
    return { tid: Number(team.tid), name: "TBD", abbr: "TBD", logo: "", placeholder: true };
  }
  return { tid: Number(team.tid), name: team.fullname || team.tname, abbr: team.abbr, logo: team.logo, placeholder: false };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
