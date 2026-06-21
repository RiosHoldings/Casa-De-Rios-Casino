/* ============================================================
   CASA DE RÍOS ROULETTE — multi-bet game logic

   Backend body:
     POST /api/roulette
     {
       playerId,
       playerSecret,
       bets: [
         { betType, betValue, betAmount }
       ]
     }

   Required localStorage:
     casa_rios_player_id
     casa_rios_player_secret
   ============================================================ */

const redNumbers = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18,
  19, 21, 23, 25, 27, 30, 32, 34, 36
]);

const EUROPEAN_WHEEL = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34,
  6, 27, 13, 36, 11, 30, 8, 23, 10,
  5, 24, 16, 33, 1, 20, 14, 31, 9,
  22, 18, 29, 7, 28, 12, 35, 3, 26
];

/* ============================================================
   WHEEL TUNING
   ============================================================ */

const WHEEL_OFFSET = -90;
const BALL_RADIUS_FRACTION = 0.275;
const WHEEL_SPINS = 6;
const BALL_SPINS = 10;

/* ============================================================
   STATE
   ============================================================ */

let balance = null;
let chip = 100;

let currentBets = [];
let previousBets = [];

let spinning = false;
let wheelRotation = 0;
let ballRotation = 0;
let ballRadiusPx = 0;
let betIdCounter = 1;

/* ============================================================
   DOM
   ============================================================ */

const stage = document.querySelector(".stage");
const wheelWrap = document.querySelector(".wheel-wrap");

const chipMarkerLayer = document.getElementById("chipMarkerLayer");
const spinButton = document.getElementById("spinButton");
const balanceText = document.getElementById("balanceText");
const totalBetText = document.getElementById("totalBetText");
const lastWinText = document.getElementById("lastWinText");
const lastColorText = document.getElementById("lastColorText");
const toast = document.getElementById("toast");

const wheelSpinLayer = document.getElementById("wheelSpinLayer");
const ballOrbit = document.getElementById("ballOrbit");
const rouletteBall = document.getElementById("rouletteBall");

/* ============================================================
   HELPERS
   ============================================================ */

function money(value) {
  return `$${Math.floor(Number(value || 0)).toLocaleString()}`;
}

function getPlayerCredentials() {
  return {
    playerId: localStorage.getItem("casa_rios_player_id"),
    playerSecret: localStorage.getItem("casa_rios_player_secret")
  };
}

function numberColor(number) {
  const n = Number(number);
  if (n === 0) return "green";
  return redNumbers.has(n) ? "red" : "black";
}

function showToast(message) {
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.remove("show");
  }, 1700);
}

function cloneBets(bets) {
  return bets.map((bet) => ({ ...bet }));
}

function getTotalBetAmount() {
  return currentBets.reduce((sum, bet) => {
    return sum + Number(bet.amount || 0);
  }, 0);
}

function updateMoney() {
  if (balanceText) {
    balanceText.textContent = balance === null ? "..." : money(balance);
  }

  if (totalBetText) {
    totalBetText.textContent = money(getTotalBetAmount());
  }
}

function resetWinReadout() {
  if (lastWinText) lastWinText.textContent = "—";
  if (lastColorText) lastColorText.textContent = "PLACE BET";
}

function hideBall() {
  if (rouletteBall) rouletteBall.style.opacity = "0";
}

function getZoneForBet(bet) {
  return document.querySelector(
    `.zone[data-bet="${bet.type}"][data-value="${String(bet.value)}"]`
  );
}

/* ============================================================
   WALLET
   ============================================================ */

async function loadWalletBalance() {
  const { playerId, playerSecret } = getPlayerCredentials();

  if (!playerId || !playerSecret) {
    balance = 0;
    showToast("Player login missing");
    updateMoney();
    return;
  }

  try {
    const response = await fetch("/api/wallet", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        playerId,
        playerSecret
      })
    });

    const data = await response.json();

    const walletAmount =
      data.chips ??
      data.balance ??
      data.balanceAfter ??
      data.wallet?.chips ??
      data.wallet?.balance ??
      data.player?.chips ??
      data.player?.balance;

    if (walletAmount === undefined || walletAmount === null) {
      balance = 0;
      showToast(data.error || "Wallet balance missing");
      updateMoney();
      return;
    }

    balance = Number(walletAmount);
    updateMoney();
  } catch (error) {
    balance = 0;
    showToast("Wallet connection error");
    updateMoney();
  }
}

/* ============================================================
   RESPONSIVE SIZING
   ============================================================ */

function setBallRadius() {
  if (!rouletteBall || !wheelWrap) return;

  ballRadiusPx = wheelWrap.clientWidth * BALL_RADIUS_FRACTION;
  rouletteBall.style.transform = `translateY(${-ballRadiusPx}px)`;
}

function setStageSize() {
  if (!stage) return;

  stage.style.setProperty("--ss", `${stage.clientWidth}px`);
  setBallRadius();
  renderBetChips();
}

/* ============================================================
   WHEEL / BALL ANIMATION
   ============================================================ */

function animateWheelToNumber(resultNumber) {
  if (!wheelSpinLayer || !ballOrbit || !rouletteBall) return;

  const result = Number(resultNumber);
  const index = EUROPEAN_WHEEL.indexOf(result);

  if (index === -1) return;

  const step = 360 / EUROPEAN_WHEEL.length;
  const TOP_ANGLE = -90;

  rouletteBall.style.opacity = "1";

  wheelSpinLayer.style.transition = "none";
  ballOrbit.style.transition = "none";
  wheelSpinLayer.offsetHeight;

  wheelRotation += 360 * WHEEL_SPINS;

  const targetNet =
    (((TOP_ANGLE - (WHEEL_OFFSET + index * step)) % 360) + 360) % 360;

  const currentNet = ((wheelRotation % 360) + 360) % 360;

  let wheelAdjust = targetNet - currentNet;
  if (wheelAdjust < 0) wheelAdjust += 360;

  wheelRotation += wheelAdjust;

  ballRotation -= 360 * BALL_SPINS;

  const currentBall = ((ballRotation % 360) + 360) % 360;

  let ballAdjust = -currentBall;
  if (ballAdjust > 0) ballAdjust -= 360;

  ballRotation += ballAdjust;

  wheelSpinLayer.style.transition =
    "transform 5s cubic-bezier(.12,.72,.14,1)";
  ballOrbit.style.transition =
    "transform 5s cubic-bezier(.08,.74,.12,1)";

  wheelSpinLayer.style.transform = `rotate(${wheelRotation}deg)`;
  ballOrbit.style.transform = `rotate(${ballRotation}deg)`;
}

/* ============================================================
   BET CHIP RENDERING
   ============================================================ */

function renderBetChips() {
  if (!chipMarkerLayer || !stage) return;

  chipMarkerLayer.innerHTML = "";

  if (!currentBets.length) return;

  const stageRect = stage.getBoundingClientRect();
  const stackedCounts = new Map();

  currentBets.forEach((bet) => {
    const zone = getZoneForBet(bet);
    if (!zone) return;

    const zoneRect = zone.getBoundingClientRect();

    const key = `${bet.type}:${bet.value}`;
    const stackIndex = stackedCounts.get(key) || 0;
    stackedCounts.set(key, stackIndex + 1);

    const offset = stage.clientWidth * 0.007;
    const offsetX = ((stackIndex % 3) - 1) * offset;
    const offsetY = -Math.floor(stackIndex / 3) * offset * 0.75;

    const x = zoneRect.left - stageRect.left + zoneRect.width / 2 + offsetX;
    const y = zoneRect.top - stageRect.top + zoneRect.height / 2 + offsetY;

    const marker = document.createElement("img");
    marker.className = "bet-chip-marker";
    marker.src = `assets/chip-${bet.amount}.png`;
    marker.alt = `${bet.amount} chip`;
    marker.style.left = `${x}px`;
    marker.style.top = `${y}px`;

    marker.onerror = () => {
      marker.remove();

      const fallback = document.createElement("div");
      fallback.className = "bet-chip-marker bet-chip-fallback";
      fallback.textContent = bet.amount >= 1000 ? "1K" : String(bet.amount);
      fallback.style.left = `${x}px`;
      fallback.style.top = `${y}px`;
      chipMarkerLayer.appendChild(fallback);
    };

    chipMarkerLayer.appendChild(marker);
  });
}

function highlightChip() {
  document.querySelectorAll(".chip-zone").forEach((btn) => {
    btn.classList.toggle("selected", Number(btn.dataset.chip) === chip);
  });
}

function setChip(amount) {
  chip = Number(amount);

  highlightChip();
  updateMoney();

  showToast(`${money(chip)} chip selected`);
}

function getBetLabel(type, value) {
  const parsed =
    type === "number" || type === "dozen" || type === "column"
      ? Number(value)
      : value;

  if (type === "number") return String(parsed);
  if (type === "color") return String(parsed).toUpperCase();
  if (type === "oddEven") return String(parsed).toUpperCase();
  if (type === "range") return parsed === "low" ? "1–18" : "19–36";

  if (type === "dozen") {
    if (parsed === 1) return "1ST 12";
    if (parsed === 2) return "2ND 12";
    return "3RD 12";
  }

  if (type === "column") {
    if (parsed === 3) return "TOP 2 TO 1";
    if (parsed === 2) return "MIDDLE 2 TO 1";
    return "BOTTOM 2 TO 1";
  }

  return String(parsed).toUpperCase();
}

/* ============================================================
   BETTING
   ============================================================ */

function placeBet(type, value) {
  if (spinning) return;
  if (!type || value === undefined) return;

  const parsed =
    type === "number" || type === "dozen" || type === "column"
      ? Number(value)
      : value;

  currentBets.push({
    id: betIdCounter++,
    type,
    value: parsed,
    amount: chip
  });

  resetWinReadout();
  renderBetChips();
  updateMoney();

  showToast(`${money(chip)} on ${getBetLabel(type, value)}`);
}

function clearBet(message = "Bets cleared") {
  if (spinning) return;

  if (currentBets.length) {
    previousBets = cloneBets(currentBets);
  }

  currentBets = [];

  if (chipMarkerLayer) chipMarkerLayer.innerHTML = "";

  resetWinReadout();
  updateMoney();
  showToast(message);
}

function undoBet() {
  if (spinning) return;

  if (!currentBets.length) {
    showToast("No bet to undo");
    return;
  }

  currentBets.pop();

  renderBetChips();
  updateMoney();
  resetWinReadout();

  showToast("Last bet removed");
}

function doubleBet() {
  if (spinning) return;

  if (!currentBets.length) {
    showToast("Place a bet first");
    return;
  }

  const total = getTotalBetAmount();

  if (balance !== null && total * 2 > balance) {
    showToast("Not enough balance to double");
    return;
  }

  const duplicated = currentBets.map((bet) => ({
    id: betIdCounter++,
    type: bet.type,
    value: bet.value,
    amount: bet.amount
  }));

  currentBets = currentBets.concat(duplicated);

  renderBetChips();
  updateMoney();
  resetWinReadout();

  showToast(`Total bet doubled to ${money(getTotalBetAmount())}`);
}

function rebet() {
  if (spinning) return;

  if (!previousBets.length) {
    showToast("No previous bets");
    return;
  }

  currentBets = cloneBets(previousBets).map((bet) => ({
    ...bet,
    id: betIdCounter++
  }));

  renderBetChips();
  updateMoney();
  resetWinReadout();

  showToast("Previous bets restored");
}

/* ============================================================
   SPIN
   ============================================================ */

async function spinRoulette() {
  if (spinning) return;

  if (!currentBets.length) {
    showToast("Place a bet first");
    return;
  }

  const totalBet = getTotalBetAmount();

  const { playerId, playerSecret } = getPlayerCredentials();

  if (!playerId || !playerSecret) {
    showToast("Player login missing");
    return;
  }

  if (balance === null) {
    await loadWalletBalance();

    if (balance === null) {
      showToast("Wallet unavailable");
      return;
    }
  }

  if (balance < totalBet) {
    showToast("Not enough balance");
    return;
  }

  spinning = true;
  previousBets = cloneBets(currentBets);

  if (spinButton) spinButton.disabled = true;
  if (lastWinText) lastWinText.textContent = "...";
  if (lastColorText) lastColorText.textContent = "SPINNING";

  const payloadBets = currentBets.map((bet) => ({
    betType: bet.type,
    betValue: String(bet.value),
    betAmount: Number(bet.amount)
  }));

  try {
    const response = await fetch("/api/roulette", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        playerId,
        playerSecret,
        bets: payloadBets
      })
    });

    const data = await response.json();

    if (!data.ok) {
      showToast(data.error || "Roulette failed");
      hideBall();

      spinning = false;
      if (spinButton) spinButton.disabled = false;
      if (lastWinText) lastWinText.textContent = "—";
      if (lastColorText) lastColorText.textContent = "PLACE BET";

      return;
    }

    const resultNumber = Number(
      data.resultNumber ?? data.winningNumber ?? data.number
    );

    const resultColor =
      data.resultColor ?? data.winningColor ?? numberColor(resultNumber);

    const payout = Number(data.totalPayout ?? data.payout ?? 0);

    animateWheelToNumber(resultNumber);

    setTimeout(() => {
      balance = Number(data.balanceAfter ?? data.chips ?? data.balance ?? balance);

      if (lastWinText) {
        lastWinText.textContent = money(payout);
      }

      if (lastColorText) {
        lastColorText.textContent = String(resultColor).toUpperCase();
      }

      updateMoney();

      if (payout > 0) {
        showToast(
          `${resultNumber} ${String(resultColor).toUpperCase()} — won ${money(payout)}`
        );
      } else {
        showToast(
          `Landed on ${resultNumber} ${String(resultColor).toUpperCase()}`
        );
      }

      spinning = false;
      if (spinButton) spinButton.disabled = false;
    }, 5100);
  } catch (error) {
    showToast("Connection error");
    hideBall();

    spinning = false;
    if (spinButton) spinButton.disabled = false;
    if (lastWinText) lastWinText.textContent = "—";
    if (lastColorText) lastColorText.textContent = "PLACE BET";
  }
}

/* ============================================================
   EVENTS
   ============================================================ */

document.querySelectorAll(".zone").forEach((btn) => {
  btn.addEventListener("click", () => {
    placeBet(btn.dataset.bet, btn.dataset.value);
  });
});

document.querySelectorAll(".chip-zone").forEach((btn) => {
  btn.addEventListener("click", () => {
    setChip(btn.dataset.chip);
  });
});

if (spinButton) {
  spinButton.addEventListener("click", spinRoulette);
}

document.getElementById("clearButton")?.addEventListener("click", () => {
  clearBet();
});

document.getElementById("doubleButton")?.addEventListener("click", () => {
  doubleBet();
});

document.getElementById("rebetButton")?.addEventListener("click", () => {
  rebet();
});

document.getElementById("undoButton")?.addEventListener("click", () => {
  undoBet();
});

window.addEventListener("resize", setStageSize);
window.addEventListener("orientationchange", setStageSize);
window.addEventListener("load", setStageSize);

/* ============================================================
   INIT
   ============================================================ */

setStageSize();
highlightChip();
updateMoney();
loadWalletBalance();
showToast("Tap the table to place bets");