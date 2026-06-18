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

/*
  WHEEL TUNING (only knobs you should ever need):
  - WHEEL_OFFSET       : angle of pocket index 0. Nudge if a pocket is one off.
  - WHEEL_NUMBER_RADIUS: how far numbers sit from center. 274 places them
                         INSIDE the pockets (your image measured 274, not 315).
  - WHEEL_CENTER_X/Y   : the wheel art's true center (it's slightly off the
                         image center). Nudge by a few units if the ring still
                         looks off-center.
  - BALL_SPIN_RADIUS   : where the ball rests (pixels). Less negative = closer in.
*/
const WHEEL_OFFSET = -89.5;
const WHEEL_NUMBER_RADIUS = 270;
const WHEEL_CENTER_X = 509;
const WHEEL_CENTER_Y = 511;
const BALL_SPIN_RADIUS = -95;
const WHEEL_SPINS = 6;
const BALL_SPINS = 10;

const WHEEL_NUMBER_FONT_SIZE = 24;
const WHEEL_ZERO_FONT_SIZE = 26;
const WHEEL_NUMBER_STROKE = 3;

let balance = 5000;
let chip = 100;
let currentBet = null;
let previousBet = null;
let spinning = false;

let wheelRotation = 0;
let ballRotation = 0;

const chipMarkerLayer = document.getElementById('chipMarkerLayer');
const spinButton = document.getElementById('spinButton');
const balanceText = document.getElementById('balanceText');
const totalBetText = document.getElementById('totalBetText');
const lastWinText = document.getElementById('lastWinText');
const lastColorText = document.getElementById('lastColorText');
const toast = document.getElementById('toast');

const wheelSpinLayer = document.getElementById('wheelSpinLayer');
const wheelNumberSvg = document.getElementById('wheelNumberSvg');
const ballOrbit = document.getElementById('ballOrbit');
const rouletteBall = document.getElementById('rouletteBall');

function money(value) {
  return `$${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function getPlayerCredentials() {
  return {
    playerId: localStorage.getItem('casa_rios_player_id'),
    playerSecret: localStorage.getItem('casa_rios_player_secret')
  };
}

function numberColor(number) {
  const n = Number(number);
  if (n === 0) return 'green';
  return redNumbers.has(n) ? 'red' : 'black';
}

function showToast(message) {
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add('show');

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 1700);
}

function updateMoney() {
  if (balanceText) balanceText.textContent = money(balance);
  if (totalBetText) totalBetText.textContent = money(chip);
}

async function loadWalletBalance() {
  const { playerId, playerSecret } = getPlayerCredentials();

  if (!playerId || !playerSecret) {
    showToast('Player login missing');
    updateMoney();
    return;
  }

  try {
    const response = await fetch('/api/wallet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, playerSecret })
    });

    const data = await response.json();

    if (!data.ok) {
      showToast(data.error || 'Wallet unavailable');
      updateMoney();
      return;
    }

    balance = Number(data.chips ?? data.balance ?? data.balanceAfter ?? balance);
    updateMoney();
  } catch {
    showToast('Wallet connection error');
    updateMoney();
  }
}

/* -----------------------------
   WHEEL SVG NUMBERS
----------------------------- */

function buildWheelNumbers() {
  if (!wheelNumberSvg) return;

  wheelNumberSvg.innerHTML = '';

  const cx = WHEEL_CENTER_X;
  const cy = WHEEL_CENTER_Y;
  const step = 360 / EUROPEAN_WHEEL.length;

  EUROPEAN_WHEEL.forEach((num, index) => {
    const angle = WHEEL_OFFSET + index * step;
    const rad = angle * Math.PI / 180;

    const x = cx + Math.cos(rad) * WHEEL_NUMBER_RADIUS;
    const y = cy + Math.sin(rad) * WHEEL_NUMBER_RADIUS;

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');

    text.setAttribute('x', x);
    text.setAttribute('y', y);
    text.setAttribute('fill', '#ffffff');
    text.setAttribute('font-size', String(num === 0 ? WHEEL_ZERO_FONT_SIZE : WHEEL_NUMBER_FONT_SIZE));
    text.setAttribute('font-weight', '900');
    text.setAttribute('font-family', 'Georgia, Times New Roman, serif');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('paint-order', 'stroke');
    text.setAttribute('stroke', '#000000');
    text.setAttribute('stroke-width', String(WHEEL_NUMBER_STROKE));
    text.setAttribute('transform', `rotate(${angle + 90} ${x} ${y})`);

    text.textContent = num;
    wheelNumberSvg.appendChild(text);
  });
}

function setBallRadius() {
  if (!rouletteBall) return;
  rouletteBall.style.transform = `rotate(0deg) translateY(${BALL_SPIN_RADIUS}px)`;
}

/* -----------------------------
   WHEEL / BALL ANIMATION
----------------------------- */

function animateWheelToNumber(resultNumber) {
  if (!wheelSpinLayer || !ballOrbit || !rouletteBall) return;

  const result = Number(resultNumber);
  const index = EUROPEAN_WHEEL.indexOf(result);

  if (index === -1) return;

  const step = 360 / EUROPEAN_WHEEL.length;
  const TOP_ANGLE = -90; // 12 o'clock — where the winning number comes to rest

  rouletteBall.style.opacity = '1';

  wheelSpinLayer.style.transition = 'none';
  ballOrbit.style.transition = 'none';

  // Force repaint before the animation starts
  wheelSpinLayer.offsetHeight;

  /*
    WHEEL: spin forward several full turns, then STOP with the winning
    number at the top. (Previously it did whole turns only, so it always
    snapped back to the start with 0 on top.)
  */
  wheelRotation += 360 * WHEEL_SPINS;
  const targetNet = (((TOP_ANGLE - (WHEEL_OFFSET + index * step)) % 360) + 360) % 360;
  const currentNet = ((wheelRotation % 360) + 360) % 360;
  let wheelAdjust = targetNet - currentNet;
  if (wheelAdjust < 0) wheelAdjust += 360;   // always finish moving forward
  wheelRotation += wheelAdjust;

  /*
    BALL: spin the opposite way and settle at the top, resting in the
    winning pocket.
  */
  ballRotation -= 360 * BALL_SPINS;
  const currentBall = ((ballRotation % 360) + 360) % 360;
  let ballAdjust = -currentBall;             // bring the ball back to the top
  if (ballAdjust > 0) ballAdjust -= 360;     // keep moving the same (backward) way
  ballRotation += ballAdjust;

  wheelSpinLayer.style.transition =
    'transform 5s cubic-bezier(.12,.72,.14,1)';

  ballOrbit.style.transition =
    'transform 5s cubic-bezier(.08,.74,.12,1)';

  wheelSpinLayer.style.transform = `rotate(${wheelRotation}deg)`;
  ballOrbit.style.transform = `rotate(${ballRotation}deg)`;
}

function hideBall() {
  if (!rouletteBall) return;
  rouletteBall.style.opacity = '0';
}

/* -----------------------------
   BETTING
----------------------------- */

function showBetChip(zone) {
  if (!chipMarkerLayer || !zone) return;

  chipMarkerLayer.innerHTML = '';

  const shell = document.querySelector('.game-shell');
  if (!shell) return;

  const shellRect = shell.getBoundingClientRect();
  const zoneRect = zone.getBoundingClientRect();

  const x = zoneRect.left - shellRect.left + zoneRect.width / 2;
  const y = zoneRect.top - shellRect.top + zoneRect.height / 2;

  const marker = document.createElement('div');

  marker.className = 'bet-chip-marker';
  marker.textContent = chip >= 1000 ? '1K' : chip;
  marker.style.left = `${x}px`;
  marker.style.top = `${y}px`;

  chipMarkerLayer.appendChild(marker);
}

function setChip(amount) {
  chip = Number(amount);

  document.querySelectorAll('.chip-zone').forEach(btn => {
    btn.classList.toggle('selected', Number(btn.dataset.chip) === chip);
  });

  updateMoney();
  showToast(`${money(chip)} chip selected`);
}

function placeBet(type, value) {
  if (!type || value === undefined) return;

  const parsed =
    type === 'number' || type === 'dozen' || type === 'column'
      ? Number(value)
      : value;

  currentBet = { type, value: parsed };
  previousBet = { type, value: parsed };

  document.querySelectorAll('.zone').forEach(btn => {
    btn.classList.remove('bet-selected');
  });

  const selectedZone = document.querySelector(
    `.zone[data-bet="${type}"][data-value="${value}"]`
  );

  if (selectedZone) {
    selectedZone.classList.add('bet-selected');
    showBetChip(selectedZone);
  }

  let label = parsed;

  if (type === 'color') label = String(parsed).toUpperCase();
  if (type === 'oddEven') label = String(parsed).toUpperCase();
  if (type === 'range') label = parsed === 'low' ? '1–18' : '19–36';

  if (type === 'dozen') {
    label = parsed === 1 ? '1ST 12' : parsed === 2 ? '2ND 12' : '3RD 12';
  }

  if (type === 'column') {
    label =
      parsed === 3 ? 'TOP 2 TO 1' :
      parsed === 2 ? 'MIDDLE 2 TO 1' :
      'BOTTOM 2 TO 1';
  }

  if (lastWinText) lastWinText.textContent = '—';
  if (lastColorText) lastColorText.textContent = 'PLACE BET';

  showToast(`Bet placed: ${String(label).toUpperCase()}`);
}

async function spinRoulette() {
  if (spinning) return;
  if (!currentBet) return showToast('Place a bet first');

  const { playerId, playerSecret } = getPlayerCredentials();

  if (!playerId || !playerSecret) {
    return showToast('Player login missing');
  }

  if (balance < chip) {
    return showToast('Not enough balance');
  }

  spinning = true;
  if (spinButton) spinButton.disabled = true;

  if (lastWinText) lastWinText.textContent = '...';
  if (lastColorText) lastColorText.textContent = 'SPINNING';

  try {
    const response = await fetch('/api/roulette', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      showToast(data.error || 'Roulette failed');
      hideBall();
      spinning = false;
      if (spinButton) spinButton.disabled = false;
      return;
    }

    const resultNumber = Number(data.resultNumber);
    const resultColor = data.resultColor || numberColor(resultNumber);

    animateWheelToNumber(resultNumber);

    setTimeout(() => {
      balance = Number(data.balanceAfter ?? balance);

      if (lastWinText) lastWinText.textContent = resultNumber;
      if (lastColorText) lastColorText.textContent = String(resultColor).toUpperCase();

      updateMoney();

      if (data.won) {
        showToast(`You won ${money(data.payout)}`);
      } else {
        showToast(`Landed on ${resultNumber} ${String(resultColor).toUpperCase()}`);
      }

      spinning = false;
      if (spinButton) spinButton.disabled = false;
    }, 5100);

  } catch {
    showToast('Connection error');
    hideBall();
    spinning = false;
    if (spinButton) spinButton.disabled = false;
  }
}

function clearBet() {
  currentBet = null;

  document.querySelectorAll('.zone').forEach(btn => {
    btn.classList.remove('bet-selected');
  });

  if (chipMarkerLayer) chipMarkerLayer.innerHTML = '';
  if (lastWinText) lastWinText.textContent = '—';
  if (lastColorText) lastColorText.textContent = 'PLACE BET';

  showToast('Bet cleared');
}

function doubleBet() {
  chip = Math.min(chip * 2, 1000);

  document.querySelectorAll('.chip-zone').forEach(btn => {
    btn.classList.toggle('selected', Number(btn.dataset.chip) === chip);
  });

  updateMoney();
  showToast(`Bet doubled to ${money(chip)}`);
}

function rebet() {
  if (!previousBet) return showToast('No previous bet');

  currentBet = { ...previousBet };

  document.querySelectorAll('.zone').forEach(btn => {
    btn.classList.remove('bet-selected');
  });

  const selectedZone = document.querySelector(
    `.zone[data-bet="${currentBet.type}"][data-value="${currentBet.value}"]`
  );

  if (selectedZone) {
    selectedZone.classList.add('bet-selected');
    showBetChip(selectedZone);
  }

  if (lastWinText) lastWinText.textContent = '—';
  if (lastColorText) lastColorText.textContent = 'PLACE BET';

  showToast('Previous bet restored');
}

/* -----------------------------
   EVENTS / INIT
----------------------------- */

document.querySelectorAll('.zone').forEach(btn => {
  btn.addEventListener('click', () => {
    placeBet(btn.dataset.bet, btn.dataset.value);
  });
});

document.querySelectorAll('.chip-zone').forEach(btn => {
  btn.addEventListener('click', () => {
    setChip(btn.dataset.chip);
  });
});

if (spinButton) spinButton.addEventListener('click', spinRoulette);
document.getElementById('clearButton')?.addEventListener('click', clearBet);
document.getElementById('doubleButton')?.addEventListener('click', doubleBet);
document.getElementById('rebetButton')?.addEventListener('click', rebet);

buildWheelNumbers();
setBallRadius();
updateMoney();
loadWalletBalance();
showToast('Tap the table to place a bet');
