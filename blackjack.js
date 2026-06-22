const PLAYER_KEY = "casa_rios_player_id";
const PLAYER_SECRET_KEY = "casa_rios_player_secret";
const RECENT_KEY = "casa_rios_blackjack_recent";

const CHIP_VALUES = [50, 100, 250, 500, 1000];
const MAX_BET = 50000;

let activeHandId = null;
let currentBet = 0;
let previousBet = 0;
let lastBalance = null;
let canAct = false;
let currentPhase = "betting";
let lastPlayerHand = [];

/* ============================================================
   BASIC HELPERS
   ============================================================ */

function makeId() {
  if (crypto.randomUUID) {
    return "CDR-" + crypto.randomUUID().slice(0, 8).toUpperCase();
  }

  return "CDR-" + Date.now().toString(36).toUpperCase();
}

function makeSecret() {
  if (crypto.randomUUID) {
    return crypto.randomUUID() + "-" + crypto.randomUUID();
  }

  return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
}

function getPlayerId() {
  let id = localStorage.getItem(PLAYER_KEY);

  if (!id) {
    id = makeId();
    localStorage.setItem(PLAYER_KEY, id);
  }

  return id;
}

function getPlayerSecret() {
  let secret = localStorage.getItem(PLAYER_SECRET_KEY);

  if (!secret) {
    secret = makeSecret();
    localStorage.setItem(PLAYER_SECRET_KEY, secret);
  }

  return secret;
}

function money(value) {
  return `$${Math.floor(Number(value || 0)).toLocaleString()}`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function shortId(id) {
  if (!id) return "---";
  if (id.length <= 14) return id;
  return id.slice(0, 12) + "...";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseMaybeJson(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.remove("show");
  }, 1700);
}

function setStageSize() {
  const stage = document.querySelector(".bj-stage");
  if (!stage) return;

  stage.style.setProperty("--ss", `${stage.clientWidth}px`);
}

/* ============================================================
   CARD RENDERING
   ============================================================ */

function normalizeCard(card) {
  if (!card) return { hidden: true };

  if (card.hidden || card.rank === "?" || card.suit === "?") {
    return { hidden: true };
  }

  if (typeof card === "string") {
    const suit = card.slice(-1);
    const rank = card.slice(0, -1);
    return { rank, suit, hidden: false };
  }

  return {
    rank: card.rank || card.value || card.name || "?",
    suit: card.suit || "",
    hidden: false
  };
}

function cardHtml(rawCard) {
  const card = normalizeCard(rawCard);

  if (card.hidden) {
    return `
      <div class="bj-card card-back">
        <img src="assets/card-logo-cutout.png" alt="" class="card-back-logo">
      </div>
    `;
  }

  const isRed = card.suit === "♥" || card.suit === "♦";

  return `
    <div class="bj-card card-face ${isRed ? "red" : "black"}">
      <div class="corner top">
        <span class="rank">${escapeHtml(card.rank)}</span>
        <span class="suit">${escapeHtml(card.suit)}</span>
      </div>

      <div class="pip">${escapeHtml(card.suit)}</div>

      <div class="corner bottom">
        <span class="rank">${escapeHtml(card.rank)}</span>
        <span class="suit">${escapeHtml(card.suit)}</span>
      </div>
    </div>
  `;
}

function renderCards(id, cards) {
  const el = document.getElementById(id);
  if (!el) return;

  const cleanCards = parseMaybeJson(cards);

  if (!cleanCards.length) {
    el.innerHTML = "";
    return;
  }

  el.innerHTML = cleanCards.map(cardHtml).join("");
}

/* ============================================================
   UI / STATE
   ============================================================ */

function setMessage(message, tone = "warn") {
  const el = document.getElementById("gameMessage");
  if (!el) return;

  el.textContent = message;
  el.classList.remove("good", "bad", "warn");

  if (tone === "good") el.classList.add("good");
  else if (tone === "bad") el.classList.add("bad");
  else el.classList.add("warn");
}

function setControls(phase, options = {}) {
  currentPhase = phase;

  const betting = document.getElementById("bettingControls");
  const playing = document.getElementById("playingControls");
  const result = document.getElementById("resultControls");

  betting?.classList.add("hidden");
  playing?.classList.add("hidden");
  result?.classList.add("hidden");

  if (phase === "betting") {
    betting?.classList.remove("hidden");
  }

  if (phase === "playing") {
    playing?.classList.remove("hidden");
  }

  if (phase === "result") {
    result?.classList.remove("hidden");
  }

  const dealBtn = document.getElementById("dealBtn");
  const clearBtn = document.getElementById("clearBetBtn");
  const hitBtn = document.getElementById("hitBtn");
  const standBtn = document.getElementById("standBtn");
  const doubleBtn = document.getElementById("doubleBtn");
  const splitBtn = document.getElementById("splitBtn");
  const rebetBtn = document.getElementById("rebetBtn");
  const newHandBtn = document.getElementById("newHandBtn");

  if (dealBtn) dealBtn.disabled = phase !== "betting" || currentBet <= 0;
  if (clearBtn) clearBtn.disabled = phase !== "betting" || currentBet <= 0;

  if (hitBtn) hitBtn.disabled = phase !== "playing" || !canAct;
  if (standBtn) standBtn.disabled = phase !== "playing" || !canAct;

  const canDouble =
    phase === "playing" &&
    canAct &&
    Array.isArray(lastPlayerHand) &&
    lastPlayerHand.length === 2 &&
    lastBalance !== null &&
    Number(lastBalance) >= Number(currentBet);

  if (doubleBtn) doubleBtn.disabled = !canDouble;

  /* Backend split is not built yet. Keep disabled for now. */
  if (splitBtn) splitBtn.disabled = true;

  if (rebetBtn) rebetBtn.disabled = previousBet <= 0;
  if (newHandBtn) newHandBtn.disabled = false;
}

function updateChipHighlight(lastChip = null) {
  document.querySelectorAll(".bj-chip-btn").forEach((btn) => {
    const value = Number(btn.dataset.chip);
    btn.classList.toggle("selected", value === lastChip);
    btn.classList.toggle("active", value === lastChip);
  });
}

function updateBetDisplay() {
  const betInput = document.getElementById("betAmount");
  if (betInput) betInput.value = String(currentBet);

  setText("currentBet", money(currentBet));
  renderMainBetChip();
  setControls(currentPhase);
}

function getChipBreakdown(total) {
  const values = [1000, 500, 250, 100, 50];
  const groups = [];
  let remaining = Number(total || 0);

  for (const value of values) {
    const count = Math.floor(remaining / value);
    if (count > 0) {
      groups.push({ value, count });
      remaining -= value * count;
    }
  }

  return groups;
}

function getVisualChipStack(total) {
  const groups = getChipBreakdown(total);
  const visual = [];

  for (const group of groups) {
    if (group.count <= 3) {
      for (let i = 0; i < group.count; i++) {
        visual.push({ value: group.value, count: 1 });
      }
    } else {
      visual.push({ value: group.value, count: group.count });
    }
  }

  return visual.slice(0, 8);
}

function renderMainBetChip() {
  const layer = document.getElementById("mainBetChipLayer");
  if (!layer) return;

  layer.innerHTML = "";

  if (currentBet <= 0) return;

  const stack = getVisualChipStack(currentBet);

  if (!stack.length) return;

  const total = stack.length;
  const spread = Math.min(14, total * 3.5);

  const html = stack.map((chip, index) => {
    const x = (index - (total - 1) / 2) * spread;
    const y = (total - 1 - index) * 3.5;
    const z = index + 1;

    return `
      <div
        class="bet-stack-item"
        style="--x:${x}px; --y:${y}px; --z:${z};"
      >
        <img
          class="bet-stack-img"
          src="assets/chip-${chip.value}.png"
          alt="${chip.value} chip"
        >
        ${chip.count > 1 ? `<span class="bet-stack-count">×${chip.count}</span>` : ""}
      </div>
    `;
  }).join("");

  layer.innerHTML = `<div class="bet-chip-stack">${html}</div>`;
}

/* ============================================================
   API DATA HELPERS
   ============================================================ */

function getPlayerHand(data) {
  return data.playerHand || data.player_hand || data.hand?.playerHand || [];
}

function getDealerHand(data) {
  return data.dealerHandPublic || data.dealerHand || data.dealer_hand_public || data.hand?.dealerHandPublic || [];
}

function getHandId(data) {
  return data.handId || data.hand_id || data.id || data.hand?.id || null;
}

function getBalanceAfter(data) {
  return data.balanceAfter ?? data.balance_after ?? data.chips ?? data.balance ?? data.player?.chips ?? null;
}

function getBetAmount(data) {
  return Number(data.betAmount ?? data.bet_amount ?? data.hand?.bet_amount ?? currentBet);
}

function getPayout(data) {
  return Number(data.payout ?? data.hand?.payout ?? 0);
}

function getStatus(data) {
  return String(data.status || data.hand?.status || "");
}

function getResult(data) {
  return String(data.result || data.hand?.result || "");
}

/* ============================================================
   WALLET
   ============================================================ */

async function loadWallet() {
  const playerId = getPlayerId();
  const playerSecret = getPlayerSecret();

  setText("playerId", shortId(playerId));

  try {
    const response = await fetch(
      "/api/wallet?playerId=" +
        encodeURIComponent(playerId) +
        "&playerSecret=" +
        encodeURIComponent(playerSecret)
    );

    const data = await response.json();

    if (!data.ok) {
      lastBalance = 0;
      setText("walletBalance", "$0");
      setText("playerStatus", "Not Saved");
      setText("vipTier", "None");
      setMessage("Profile needed. Go to the lobby and save your player profile first.", "bad");
      setControls(currentPhase);
      return;
    }

    const p = data.player || {};
    const chips = data.chips ?? data.balance ?? p.chips ?? p.balance ?? 0;

    lastBalance = Number(chips || 0);

    setText("walletBalance", money(lastBalance));
    setText("playerStatus", String(p.status || "active").toUpperCase());
    setText("vipTier", String(p.vip_tier || "none").toUpperCase());

    setControls(currentPhase);
  } catch (error) {
    lastBalance = 0;
    setText("walletBalance", "$0");
    setMessage("Wallet error. Check deployment.", "bad");
    setControls(currentPhase);
  }
}

/* ============================================================
   HAND RENDERING
   ============================================================ */

function renderHand(data) {
  const playerHand = getPlayerHand(data);
  const dealerHand = getDealerHand(data);

  lastPlayerHand = parseMaybeJson(playerHand);

  renderCards("playerCards", playerHand);
  renderCards("dealerCards", dealerHand);

  const playerTotal =
    data.playerTotal ?? data.player_total ?? data.hand?.playerTotal ?? "--";

  const dealerTotal =
    data.dealerTotal ?? data.dealer_total ?? data.hand?.dealerTotal ?? "--";

  const status = getStatus(data);
  const result = getResult(data);
  const betAmount = getBetAmount(data);
  const payout = getPayout(data);
  const balanceAfter = getBalanceAfter(data);

  currentBet = Number(betAmount || currentBet || 0);

  setText("playerTotal", String(playerTotal));
  setText("dealerTotal", status === "settled" ? String(dealerTotal) : "--");
  setText("lastPayout", money(payout));

  const netChange = Number(payout || 0) - Number(betAmount || 0);
  setText("netChange", (netChange >= 0 ? "+" : "") + money(netChange));

  if (balanceAfter !== null && balanceAfter !== undefined) {
    lastBalance = Number(balanceAfter);
    setText("walletBalance", money(lastBalance));
  }

  updateBetDisplay();

  if (status === "settled") {
    activeHandId = null;
    canAct = false;

    const resultText = result || "settled";
    const message = data.message || resultText;

    const won =
      resultText.includes("win") ||
      resultText.includes("blackjack") ||
      payout > betAmount;

    const pushed =
      resultText.includes("push") ||
      payout === betAmount;

    setMessage(
      `${message} — ${money(payout)}`,
      pushed ? "warn" : won ? "good" : "bad"
    );

    saveRecentHand({
      result: resultText,
      betAmount,
      payout,
      netChange,
      playerTotal,
      dealerTotal
    });

    renderRecentHands();
    setControls("result");
    loadWallet();
    return;
  }

  activeHandId = getHandId(data);
  canAct = true;

  setMessage(data.message || "Choose Hit or Stand.", "warn");
  setControls("playing");
}

/* ============================================================
   BETTING
   ============================================================ */

function addChipToBet(amount) {
  if (currentPhase !== "betting") return;

  const addAmount = Number(amount || 0);
  if (!Number.isFinite(addAmount) || addAmount <= 0) return;

  const nextBet = currentBet + addAmount;

  if (nextBet > MAX_BET) {
    currentBet = MAX_BET;
    updateChipHighlight(addAmount);
    updateBetDisplay();
    showToast("Maximum blackjack bet is $50,000");
    return;
  }

  currentBet = nextBet;
  updateChipHighlight(addAmount);
  updateBetDisplay();

  showToast(`${money(addAmount)} added`);
}

function clearBet() {
  if (currentPhase !== "betting") return;

  currentBet = 0;
  updateChipHighlight(null);
  updateBetDisplay();
  setMessage("Place your bet.", "warn");
  showToast("Bet cleared");
}

function newHand() {
  activeHandId = null;
  canAct = false;
  lastPlayerHand = [];

  renderCards("playerCards", []);
  renderCards("dealerCards", []);

  setText("playerTotal", "--");
  setText("dealerTotal", "--");
  setText("lastPayout", "$0");

  currentBet = 0;
  updateChipHighlight(null);
  updateBetDisplay();

  setMessage("Place your bet.", "warn");
  setControls("betting");
}

async function rebet() {
  if (previousBet <= 0) {
    showToast("No previous bet");
    return;
  }

  currentBet = previousBet;
  updateBetDisplay();
  setControls("betting");

  await startBlackjack();
}

/* ============================================================
   GAME ACTIONS
   ============================================================ */

async function startBlackjack() {
  if (currentBet <= 0) {
    setMessage("Place a bet first.", "bad");
    showToast("Place a bet first");
    return;
  }

  if (currentBet > MAX_BET) {
    setMessage("Maximum bet is $50,000.", "bad");
    return;
  }

  if (lastBalance === null) {
    await loadWallet();
  }

  if (lastBalance !== null && Number(lastBalance) < Number(currentBet)) {
    setMessage("Not enough chips.", "bad");
    return;
  }

  previousBet = currentBet;

  setMessage("Dealing from the Casa de Ríos shoe...", "warn");
  canAct = false;
  setControls("playing");

  try {
    const response = await fetch("/api/blackjack-start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        playerId: getPlayerId(),
        playerSecret: getPlayerSecret(),
        betAmount: currentBet,
        amount: currentBet
      })
    });

    const data = await response.json();

    if (!data.ok) {
      canAct = false;
      activeHandId = null;
      setMessage(data.error || "Deal denied by the house.", "bad");
      setControls("betting");
      return;
    }

    renderHand(data);
  } catch (error) {
    canAct = false;
    activeHandId = null;
    setMessage("Blackjack deal failed. Check deployment.", "bad");
    setControls("betting");
  }
}

async function blackjackAction(action) {
  if (!activeHandId) {
    setMessage("Deal a hand first.", "bad");
    return;
  }

  if (!["hit", "stand", "double"].includes(action)) {
    setMessage("That action is not available.", "bad");
    return;
  }

  setMessage("Sending action to the house...", "warn");

  canAct = false;
  setControls("playing");

  try {
    const response = await fetch("/api/blackjack-action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        playerId: getPlayerId(),
        playerSecret: getPlayerSecret(),
        handId: activeHandId,
        action
      })
    });

    const data = await response.json();

    if (!data.ok) {
      canAct = true;
      setMessage(data.error || "Action denied by the house.", "bad");
      setControls("playing");
      return;
    }

    renderHand(data);
  } catch (error) {
    canAct = true;
    setMessage("Blackjack action failed. Check deployment.", "bad");
    setControls("playing");
  }
}

/* ============================================================
   RECENT HANDS
   ============================================================ */

function saveRecentHand(data) {
  const current = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");

  current.unshift({
    time: new Date().toLocaleTimeString(),
    ...data
  });

  localStorage.setItem(RECENT_KEY, JSON.stringify(current.slice(0, 8)));
}

function renderRecentHands() {
  const list = document.getElementById("recentList");
  if (!list) return;

  const hands = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");

  if (!hands.length) {
    list.innerHTML = "";
    return;
  }

  list.innerHTML = hands.map((hand) => `
    <div>
      ${escapeHtml(hand.result || "settled")} |
      Bet ${money(hand.betAmount)} |
      Payout ${money(hand.payout)}
    </div>
  `).join("");
}

/* ============================================================
   EVENTS / INIT
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  getPlayerId();
  getPlayerSecret();

  setStageSize();

  setText("playerId", shortId(getPlayerId()));
  setText("walletBalance", "...");
  setText("currentBet", money(currentBet));
  setText("lastPayout", "$0");
  setText("playerTotal", "--");
  setText("dealerTotal", "--");

  renderRecentHands();
  renderMainBetChip();
  loadWallet();

  setMessage("Place your bet.", "warn");
  setControls("betting");

  document.querySelectorAll(".bj-chip-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      addChipToBet(btn.dataset.chip);
    });
  });

  document.getElementById("clearBetBtn")?.addEventListener("click", clearBet);
  document.getElementById("dealBtn")?.addEventListener("click", startBlackjack);
  document.getElementById("hitBtn")?.addEventListener("click", () => blackjackAction("hit"));
  document.getElementById("standBtn")?.addEventListener("click", () => blackjackAction("stand"));
  document.getElementById("doubleBtn")?.addEventListener("click", () => blackjackAction("double"));

  document.getElementById("splitBtn")?.addEventListener("click", () => {
    showToast("Split is not active yet");
  });

  document.getElementById("rebetBtn")?.addEventListener("click", rebet);
  document.getElementById("newHandBtn")?.addEventListener("click", newHand);

  window.addEventListener("resize", setStageSize);
  window.addEventListener("orientationchange", setStageSize);
});