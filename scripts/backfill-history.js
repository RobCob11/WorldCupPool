// One-time-ish utility: recomputes pool point totals for each day from the
// tournament's opening day up to (but not including) the earliest date already
// present in history.json, using the cached matches-raw.json (which now carries
// team IDs and results). Run manually with `node scripts/backfill-history.js`
// whenever the chart needs more pre-history filled in - it never calls the API.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const POOLS_PATH = path.join(DATA_DIR, "pools.json");
const HISTORY_PATH = path.join(DATA_DIR, "history.json");
const MATCHES_RAW_PATH = path.join(DATA_DIR, "matches-raw.json");

const TOURNAMENT_START = "2026-06-11";

const KNOCKOUT_MULTIPLIERS = {
  "Round of 32": 3,
  "Round of 16": 5,
  "Quarterfinals": 7,
  "Semifinals": 9,
  "Match for 3rd place": 11,
  "Final": 15,
};

function isGroupStageRound(roundField) {
  return /^\d+$/.test(String(roundField).trim());
}

function multiplierFor(roundField) {
  if (isGroupStageRound(roundField)) return 1;
  return KNOCKOUT_MULTIPLIERS[roundField] || 0;
}

function sideForTeam(match, tid) {
  if (match.homeTid === tid) return "home";
  if (match.awayTid === tid) return "away";
  return null;
}

function pointsForMatch(match, tid, pr) {
  const side = sideForTeam(match, tid);
  if (!side || match.status !== "result" || !match.result) return 0;
  const winner = match.result.winner;
  const mult = multiplierFor(match.round);
  const group = isGroupStageRound(match.round);
  if (winner === side) return mult * pr;
  if (winner === "draw" && group) return 0.5 * pr;
  return 0;
}

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

function main() {
  const pools = JSON.parse(fs.readFileSync(POOLS_PATH, "utf8"));
  const matches = JSON.parse(fs.readFileSync(MATCHES_RAW_PATH, "utf8"));
  const existingHistory = fs.existsSync(HISTORY_PATH)
    ? JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"))
    : [];

  const earliestExisting = existingHistory.length
    ? existingHistory.map((h) => h.date).sort()[0]
    : dateStr(new Date());

  const start = new Date(TOURNAMENT_START + "T00:00:00Z");
  const end = new Date(earliestExisting + "T00:00:00Z");

  const backfilled = [];
  for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
    const cutoff = new Date(d);
    cutoff.setUTCDate(cutoff.getUTCDate() + 1); // end of this day, UTC

    const computedPools = pools.map((pool) => {
      const totalPoints = pool.teams.reduce((sum, team) => {
        const teamMatches = matches.filter(
          (m) =>
            sideForTeam(m, team.tid) &&
            m.status === "result" &&
            m.timestampend * 1000 < cutoff.getTime()
        );
        const pts = teamMatches.reduce((s, m) => s + pointsForMatch(m, team.tid, team.pr), 0);
        return sum + pts;
      }, 0);
      return { name: pool.name, totalPoints: Math.round(totalPoints * 100) / 100 };
    });

    computedPools.sort((a, b) => b.totalPoints - a.totalPoints);
    computedPools.forEach((p, i) => (p.rank = i + 1));

    backfilled.push({ date: dateStr(d), pools: computedPools });
  }

  const merged = [...backfilled, ...existingHistory];
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(merged, null, 2));
  console.log(`Backfilled ${backfilled.length} day(s) (${TOURNAMENT_START} through the day before ${earliestExisting}).`);
}

main();
