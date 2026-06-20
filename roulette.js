/* ============================================================
   CASA DE RÍOS ROULETTE — game logic

   Backend contract:
     POST /api/wallet
       { playerId, playerSecret }

     POST /api/roulette
       { playerId, playerSecret, betType, betValue, betAmount }

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

   Since the SVG number ring was removed from HTML, this file now
   uses only your wheel image. The ball/wheel landing math still
   works from EUROPEAN_WHEEL and WHEEL_OFFSET.
   ============================================================ */

const WHEEL_OFFSET = -90;
const BALL_RADIUS_FRACTION = 0.275;
const WHEEL_SPINS = 6;
const BALL_SPINS = 10;

/* ============================================================
   STATE
   ============================================================ */

let balance = 5000;
let chip = 100;
let currentBet = null;
let previousBet = null;
let spinning = false;

let wheelRotation = 0;
let ballRotation = 0;
let ballRadiusPx = 0;

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

function updateMoney() {
  if (balanceText) balanceText.textContent = money(balance);
  if (totalBetText) totalBetText.textContent = money(chip);
}

function resetWinReadout() {
  if (lastWinText) lastWinText.textContent = "—";
  if (lastColorText) lastColorText.textContent = "PLACE BET";
}

function hideBall() {
  if (rouletteBall) rouletteBall.style.opacity = "0";
}

/* Kept on purpose so the old init call stays safe.
   The SVG ring is gone, so this does nothing now. */
function buildWheelPockets() {
  return;
}

/* ============================================================
   WALLET
   ============================================================ */

async function loadWalletBalance() {
  const { playerId, playerSecret } = getPlayerCredentials();

  if (!playerId || !playerSecret) {
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

    if (!data.ok) {
      showToast(data.error || "Wallet unavailable");
      updateMoney();
      return;
    }

    balance = Number(data.chips ?? data.balance ?? data.balanceAfter ?? balance);
    updateMoney();
  } catch (error) {
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

  // Force repaint before applying new transition
  wheelSpinLayer.offsetHeight;

  // Wheel rotates forward and stops with result number at 12 o'clock.
  wheelRotation += 360 * WHEEL_SPINS;

  const targetNet =
    (((TOP_ANGLE - (WHEEL_OFFSET + index * step)) % 360) + 360) % 360;

  const currentNet = ((wheelRotation % 360) + 360) % 360;

  let wheelAdjust = targetNet - currentNet;
  if (wheelAdjust < 0) wheelAdjust += 360;

  wheelRotation += wheelAdjust;

  // Ball rotates opposite direction and rests at top pocket.
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
   BET DISPLAY
   ============================================================ */

function showBetChip(zone) {
  if (!chipMarkerLayer || !zone || !stage) return;

  chipMarkerLayer.innerHTML = "";

  const stageRect = stage.getBoundingClientRect();
  const zoneRect = zone.getBoundingClientRect();

  const x = zoneRect.left - stageRect.left + zoneRect.width / 2;
  const y = zoneRect.top - stageRect.top + zoneRect.height / 2;

  const marker = document.createElement("img");
  marker.className = "bet-chip-marker";
  marker.src = 'assets/chip-${chip}.png';
  marker.alt = '${chip} chip';
  marker.style.left = '${x}px';
  marker.style.top = '${y}px';

  chipMarkerLayer.appendChild(marker);
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

  const selectedZone = document.querySelector(".zone.bet-selected");
  if (currentBet && selectedZone) showBetChip(selectedZone);

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
  if (!type || value === undefined) return;

  const parsed =
    type === "number" || type === "dozen" || type === "column"
      ? Number(value)
      : value;

  currentBet = {
    type,
    value: parsed
  };

  previousBet = {
    type,
    value: parsed
  };

  document.querySelectorAll(".zone").forEach((btn) => {
    btn.classList.remove("bet-selected");
  });

  const selectedZone = document.querySelector(
    `.zone[data-bet="${type}"][data-value="${value}"]`
  );

  if (selectedZone) {
    selectedZone.classList.add("bet-selected");
    showBetChip(selectedZone);
  }

  resetWinReadout();
  showToast(`Bet placed: ${getBetLabel(type, value)}`);
}

function clearBet(message = "Bet cleared") {
  currentBet = null;

  document.querySelectorAll(".zone").forEach((btn) => {
    btn.classList.remove("bet-selected");
  });

  if (chipMarkerLayer) chipMarkerLayer.innerHTML = "";

  resetWinReadout();
  showToast(message);
}

function doubleBet() {
  chip = Math.min(chip * 2, 1000);

  highlightChip();
  updateMoney();

  const selectedZone = document.querySelector(".zone.bet-selected");
  if (currentBet && selectedZone) showBetChip(selectedZone);

  showToast(`Bet doubled to ${money(chip)}`);
}

function rebet() {
  if (!previousBet) {
    showToast("No previous bet");
    return;
  }

  currentBet = {
    ...previousBet
  };

  document.querySelectorAll(".zone").forEach((btn) => {
    btn.classList.remove("bet-selected");
  });

  const selectedZone = document.querySelector(
    `.zone[data-bet="${currentBet.type}"][data-value="${currentBet.value}"]`
  );

  if (selectedZone) {
    selectedZone.classList.add("bet-selected");
    showBetChip(selectedZone);
  }

  resetWinReadout();
  showToast("Previous bet restored");
}

/* ============================================================
   SPIN
   ============================================================ */

async function spinRoulette() {
  if (spinning) return;

  if (!currentBet) {
    showToast("Place a bet first");
    return;
  }

  const { playerId, playerSecret } = getPlayerCredentials();

  if (!playerId || !playerSecret) {
    showToast("Player login missing");
    return;
  }

  if (balance < chip) {
    showToast("Not enough balance");
    return;
  }

  spinning = true;

  if (spinButton) spinButton.disabled = true;
  if (lastWinText) lastWinText.textContent = "...";
  if (lastColorText) lastColorText.textContent = "SPINNING";

  try {
    const response = await fetch("/api/roulette", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        playerId,
        playerSecret,
        betType: currentBet.type,
        betValue: String(currentBet.value),
        betAmount: chip
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

    const resultNumber = Number(data.resultNumber);
    const resultColor = data.resultColor || numberColor(resultNumber);

    animateWheelToNumber(resultNumber);

    setTimeout(() => {
      balance = Number(data.balanceAfter ?? balance);

      if (lastWinText) {
        lastWinText.textContent = money(data.payout ?? 0);
      }

      if (lastColorText) {
        lastColorText.textContent = String(resultColor).toUpperCase();
      }

      updateMoney();

      if (data.won) {
        showToast(
          `${resultNumber} ${String(resultColor).toUpperCase()} — you won ${money(data.payout)}`
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
  clearBet("Bet removed");
});

window.addEventListener("resize", setStageSize);
window.addEventListener("orientationchange", setStageSize);
window.addEventListener("load", setStageSize);

/* ============================================================
   INIT
   ============================================================ */

buildWheelPockets();
setStageSize();
highlightChip();
updateMoney();
loadWalletBalance();
showToast("Tap the table to place a bet");