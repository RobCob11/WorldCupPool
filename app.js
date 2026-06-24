async function loadJSON(path) {
  const res = await fetch(path + "?t=" + Date.now());
  return res.json();
}

function formatUpdated(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function rankArrow(change) {
  if (!change) return '<span class="rank-arrow flat">&ndash;</span>';
  if (change > 0) return `<span class="rank-arrow up">&uarr;${change}</span>`;
  return `<span class="rank-arrow down">&darr;${Math.abs(change)}</span>`;
}

function renderLeaderboard(data) {
  document.getElementById("stage-label").textContent =
    data.stage === "live" ? "Tournament Live" : data.stage;
  document.getElementById("matches-scored").textContent = data.groupMatchesScored;
  document.getElementById("updated-at").textContent = formatUpdated(data.updatedAt);

  const container = document.getElementById("leaderboard");
  container.innerHTML = "";

  data.pools.forEach((pool) => {
    const card = document.createElement("div");
    card.className = `pool-card rank-${pool.rank}` + (pool.live ? " is-live" : "");

    const teamsHtml = pool.teams
      .map((team) => {
        // team.form is most-recent-first; reverse so oldest reads left, most recent right.
        const formHtml = [...team.form]
          .reverse()
          .map((r) => `<span class="badge ${r}">${r}</span>`)
          .join("");
        return `
          <div class="team-row">
            <div class="team-left">
              ${team.logo ? `<img class="team-flag" src="${team.logo}" alt="" />` : '<span class="team-flag"></span>'}
              <span class="team-name${team.isTopPerformer ? " gold" : ""}">${team.name}</span>
              <span class="team-pr">PR ${team.pr}</span>
              ${team.live ? '<span class="live-pill"><span class="live-dot"></span>LIVE</span>' : ""}
            </div>
            <div class="form-badges">${formHtml}</div>
            <div class="team-points">${team.points.toFixed(1)}</div>
          </div>`;
      })
      .join("");

    card.innerHTML = `
      <div class="pool-head">
        <div class="pool-head-left">
          <span class="pool-rank">${pool.rank}</span>
          <span class="pool-name">${pool.name}</span>
          <span class="pool-meta">${pool.scoringCount} of ${pool.teams.length} countries scoring</span>
        </div>
        <div class="pool-head-right">
          ${pool.live ? '<span class="live-dot"></span>' : ""}
          ${rankArrow(pool.rankChange)}
          <span class="pool-points">${pool.totalPoints.toFixed(1)}<span class="pts-unit">pts</span></span>
          <span class="chevron">&#9660;</span>
        </div>
      </div>
      <div class="pool-teams">${teamsHtml}</div>
    `;

    card.querySelector(".pool-head").addEventListener("click", () => {
      card.classList.toggle("open");
    });

    container.appendChild(card);
  });
}

function renderBracket(data) {
  const container = document.getElementById("bracket");
  const wrap = document.createElement("div");
  wrap.className = "bracket-rounds";

  data.bracket.forEach((round) => {
    const col = document.createElement("div");
    col.className = "bracket-round";
    const title = document.createElement("div");
    title.className = "bracket-round-title";
    title.textContent = round.round;
    col.appendChild(title);

    round.matches.forEach((m) => {
      const bothTbd = m.home.placeholder && m.away.placeholder;
      const matchEl = document.createElement("div");
      matchEl.className = "bracket-match" + (bothTbd ? " is-tbd" : "");
      const homeScore = m.status === "result" || m.status === "live" ? m.result.home : "";
      const awayScore = m.status === "result" || m.status === "live" ? m.result.away : "";
      matchEl.innerHTML = `
        <div class="bracket-team${m.home.placeholder ? " tbd" : ""}">
          <span class="bracket-team-name">
            ${m.home.logo ? `<img class="bracket-flag" src="${m.home.logo}" alt="" />` : ""}
            ${m.home.name}
          </span>
          <span class="bracket-score">${homeScore}</span>
        </div>
        <div class="bracket-team${m.away.placeholder ? " tbd" : ""}">
          <span class="bracket-team-name">
            ${m.away.logo ? `<img class="bracket-flag" src="${m.away.logo}" alt="" />` : ""}
            ${m.away.name}
          </span>
          <span class="bracket-score">${awayScore}</span>
        </div>
        ${m.live ? '<div class="bracket-date"><span class="live-dot"></span> LIVE</div>' : `<div class="bracket-date">${new Date(m.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>`}
      `;
      col.appendChild(matchEl);
    });

    wrap.appendChild(col);
  });

  const finalRound = data.bracket.find((r) => r.round === "Final");
  const finalMatch = finalRound && finalRound.matches[0];
  const championCol = document.createElement("div");
  championCol.className = "bracket-champion";
  if (finalMatch && finalMatch.status === "result") {
    const winnerSide = finalMatch.result.winner === "home" ? finalMatch.home : finalMatch.away;
    championCol.innerHTML = `
      <div class="bracket-champion-title">Champion</div>
      <div class="champion-name">
        ${winnerSide.logo ? `<img src="${winnerSide.logo}" alt="" />` : ""}
        ${winnerSide.name}
      </div>
    `;
  } else {
    championCol.innerHTML = `
      <div class="bracket-champion-title">Champion</div>
      <div class="trophy-icon">&#127942;</div>
    `;
  }
  wrap.appendChild(championCol);

  container.innerHTML = "";
  container.appendChild(wrap);
}

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

async function init() {
  setupTabs();
  try {
    const standings = await loadJSON("data/standings.json");
    renderLeaderboard(standings);
  } catch (e) {
    document.getElementById("leaderboard").innerHTML =
      '<p class="muted">Standings data not available yet &mdash; check back after the first data update runs.</p>';
  }
  try {
    const bracket = await loadJSON("data/bracket.json");
    renderBracket(bracket);
  } catch (e) {
    document.getElementById("bracket").innerHTML =
      '<p class="muted">Bracket data not available yet.</p>';
  }
}

init();
