const POOL_COLORS = {
  "Los Angeles": "var(--pool-purple)",
  "San Luis Obispo": "var(--pool-red)",
  "Sea Ranch": "var(--pool-teal)",
  "Pine Street": "var(--pool-lime)",
  "Seminary": "var(--pool-blue)",
  "Kentfield": "var(--pool-orange)",
  "Dublin": "var(--pool-green)",
  "Boise": "var(--pool-pink)",
};

function medalClass(rank) {
  if (rank === 1) return "gold";
  if (rank === 2) return "silver";
  if (rank === 3) return "bronze";
  return null;
}

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
    card.style.borderColor = POOL_COLORS[pool.name] || "var(--border)";

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

    const medal = medalClass(pool.rank);
    const rankHtml = medal
      ? `<span class="medal ${medal}"></span>`
      : `<span class="pool-rank">${pool.rank}</span>`;

    card.innerHTML = `
      <div class="pool-head">
        <div class="pool-head-left">
          ${rankHtml}
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

const SPARKLE_POSITIONS = [
  { top: "8%", left: "20%", delay: "0s" },
  { top: "15%", left: "75%", delay: "0.6s" },
  { top: "45%", left: "10%", delay: "1.2s" },
  { top: "55%", left: "85%", delay: "0.3s" },
  { top: "80%", left: "30%", delay: "0.9s" },
];

const TROPHY_SVG = `
  <div class="trophy-wrap">
    <img class="trophy-icon" src="assets/trophy.png" alt="World Cup trophy" />
    ${SPARKLE_POSITIONS.map(
      (s) => `<span class="sparkle" style="top:${s.top}; left:${s.left}; animation-delay:${s.delay};">&#10022;</span>`
    ).join("")}
  </div>
`;

function formatShortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function matchBoxHtml(match) {
  if (!match) {
    return `<div class="bracket-match is-tbd">
      <div class="bracket-team tbd"><span class="bracket-team-name">TBD</span></div>
      <div class="bracket-team tbd"><span class="bracket-team-name">TBD</span></div>
    </div>`;
  }
  const { home, away } = match;
  const bothTbd = home.placeholder && away.placeholder;
  const showScore = match.status === "result" || match.status === "live";
  const winner = match.result ? match.result.winner : "";
  return `
    <div class="bracket-match${match.live ? " is-live" : ""}${bothTbd ? " is-tbd" : ""}">
      <div class="bracket-team${home.placeholder ? " tbd" : ""}${winner === "home" ? " winner" : ""}" title="${home.name}">
        <span class="bracket-team-name">
          ${home.logo ? `<img class="bracket-flag" src="${home.logo}" alt="" />` : ""}${home.placeholder ? home.name : (home.abbr || home.name)}
        </span>
        <span class="bracket-score">${showScore ? match.result.home : ""}</span>
      </div>
      <div class="bracket-team${away.placeholder ? " tbd" : ""}${winner === "away" ? " winner" : ""}" title="${away.name}">
        <span class="bracket-team-name">
          ${away.logo ? `<img class="bracket-flag" src="${away.logo}" alt="" />` : ""}${away.placeholder ? away.name : (away.abbr || away.name)}
        </span>
        <span class="bracket-score">${showScore ? match.result.away : ""}</span>
      </div>
      ${match.live ? '<div class="bracket-date"><span class="live-dot"></span> LIVE</div>' : `<div class="bracket-date">${formatShortDate(match.date)}</div>`}
    </div>
  `;
}

function renderNode(node, side) {
  if (!node) return matchBoxHtml(null);
  const selfHtml = matchBoxHtml(node.match);
  if (!node.children) return selfHtml; // leaf = Round of 32
  // Each child is wrapped in .bn-leaf so its own wishbone corner can be anchored
  // to its own vertical center, regardless of how tall its subtree is.
  const childrenHtml = node.children
    .map((c) => `<div class="bn-leaf">${renderNode(c, side)}</div>`)
    .join("");
  const childrenCol = `<div class="bn-children side-${side}">${childrenHtml}</div>`;
  const connector = `<div class="bn-connector"></div>`;
  return side === "left"
    ? `<div class="bn">${childrenCol}${connector}${selfHtml}</div>`
    : `<div class="bn">${selfHtml}${connector}${childrenCol}</div>`;
}

function renderBracket(data) {
  const container = document.getElementById("bracket");

  let championHtml = TROPHY_SVG;
  if (data.final && data.final.status === "result") {
    const winnerSide = data.final.result.winner === "home" ? data.final.home : data.final.away;
    championHtml = `<div class="champion-name">${winnerSide.logo ? `<img src="${winnerSide.logo}" alt="" />` : ""}${winnerSide.name}</div>`;
  }

  const centerHtml = `
    <div class="bracket-center">
      ${matchBoxHtml(data.final)}
      <div class="bracket-champion">
        <div class="bracket-champion-title">Champion</div>
        ${championHtml}
      </div>
      ${data.bronze ? `<div><div class="bracket-bronze-label">3rd Place</div>${matchBoxHtml(data.bronze)}</div>` : ""}
    </div>
  `;

  const leftHtml = renderNode(data.left, "left");
  const rightHtml = renderNode(data.right, "right");

  container.innerHTML = `<div class="bracket-tree">${leftHtml}${centerHtml}${rightHtml}</div>`;
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

function spawnBall() {
  const ball = document.createElement("div");
  ball.className = "bounce-ball";
  ball.textContent = "⚽";
  document.body.appendChild(ball);
  setTimeout(() => ball.remove(), 4200);
}

function spawnConfetti() {
  const colors = ["#7b2fff", "#ff3b30", "#00d9c0", "#c6ff3d", "#2d6cff", "#ff6a2b", "#ff2e87"];
  for (let i = 0; i < 18; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDelay = `${Math.random() * 0.4}s`;
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 3200);
  }
}

function startAmbientAnimations() {
  const triggerOneRandomly = () => {
    if (Math.random() < 0.5) spawnBall();
    else spawnConfetti();
  };
  setTimeout(triggerOneRandomly, 6000);
  setInterval(triggerOneRandomly, 45000);
}

async function init() {
  setupTabs();
  startAmbientAnimations();
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
