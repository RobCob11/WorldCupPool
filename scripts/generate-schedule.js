// Reads the cached match list (written by fetch-data.js) and regenerates the
// "schedule" triggers in update-data.yml: a low-frequency baseline, plus one-off
// triggers shortly after each match scheduled to end in the next ~26 hours.
// This needs zero extra API calls - it only reads data already on disk.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const MATCHES_RAW_PATH = path.join(DATA_DIR, "matches-raw.json");
const WORKFLOW_PATH = path.join(__dirname, "..", ".github", "workflows", "update-data.yml");

const BASELINE_CRON = '"0 */3 * * *"'; // every 3 hours, safety-net baseline
const START_MARKER = "    # BEGIN AUTO-GENERATED MATCH TRIGGERS";
const END_MARKER = "    # END AUTO-GENERATED MATCH TRIGGERS";

// How long after a match's scheduled end time to check for the final result.
// Two passes per match: one quick check, one later in case of stoppage/extra time/VAR delays.
const BUFFER_MINUTES = [15, 40];
const LOOKAHEAD_HOURS = 26;
const MAX_TRIGGERS_PER_DAY = 24; // keeps total API usage well under the 100/day cap

function cronFor(date) {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const day = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  return `    - cron: "${minute} ${hour} ${day} ${month} *"`;
}

function main() {
  if (!fs.existsSync(MATCHES_RAW_PATH)) {
    console.log("No matches-raw.json yet - skipping schedule generation.");
    return;
  }
  const matches = JSON.parse(fs.readFileSync(MATCHES_RAW_PATH, "utf8"));
  const now = Date.now();
  const horizon = now + LOOKAHEAD_HOURS * 60 * 60 * 1000;

  const upcoming = matches.filter(
    (m) => m.status !== "result" && m.timestampend * 1000 >= now && m.timestampend * 1000 <= horizon
  );

  const triggerTimes = [];
  for (const m of upcoming) {
    for (const buffer of BUFFER_MINUTES) {
      const t = new Date(m.timestampend * 1000 + buffer * 60 * 1000);
      triggerTimes.push(t);
    }
  }

  triggerTimes.sort((a, b) => a - b);
  const cronStrings = [...new Set(triggerTimes.map(cronFor))];
  const capped = cronStrings.slice(0, MAX_TRIGGERS_PER_DAY);

  const cronLines = capped.join("\n");

  let workflow = fs.readFileSync(WORKFLOW_PATH, "utf8");
  const startIdx = workflow.indexOf(START_MARKER);
  const endIdx = workflow.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error("Could not find auto-generated markers in update-data.yml");
  }
  const before = workflow.slice(0, startIdx + START_MARKER.length);
  const after = workflow.slice(endIdx);
  const newWorkflow = `${before}\n${cronLines}\n${after}`;
  fs.writeFileSync(WORKFLOW_PATH, newWorkflow);

  console.log(
    `Scheduled ${capped.length} match-end refresh triggers for ${upcoming.length} upcoming match(es).`
  );
}

main();
