/* ============================================================
   CASA DE RÍOS ROULETTE — game logic
   Backend contract is UNCHANGED:
     POST /api/wallet    { playerId, playerSecret }
     POST /api/roulette  { playerId, playerSecret, betType, betValue, betAmount }
   The wheel/ball spin math is the proven version (forward turns,
   winning number settles at 12 o'clock, ball rests in its pocket).
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

/* -----------------------------------------------------------
   WHEEL TUNING — matches the wheel art (1036×1036, true centre ~511,510).
   The painted pockets on the art are decorative and do NOT follow the real
   roulette colour order, so the pocket ring is drawn here in SVG with the
   CORRECT colours over the art — every number always sits on its proper
   red / black / green.
   - WHEEL_OFFSET        : angle of pocket "0" (−90 = 12 o'clock).
   - POCKET_INNER/OUTER_R: the ring that covers the painted pocket band.
   - WHEEL_NUMBER_RADIUS : where the number text sits (mid-ring).
   - BALL_RADIUS_FRACTION: ball rest radius as a fraction of wheel width.
----------------------------------------------------------- */
const WHEEL_OFFSET = -90;          // green 0 at 12 o'clock
const WHEEL_CENTER_X = 511;
const WHEEL_CENTER_Y = 510;
const POCKET_INNER_R = 206;
const POCKET_OUTER_R = 293;
const WHEEL_NUMBER_RADIUS = 250;
const BALL_RADIUS_FRACTION = 0.275;
const WHEEL_SPINS = 6;
const BALL_SPINS = 10;

const POCKET_RED = '#c0152a';      // matches the table's red
const POCKET_BLACK = '#161616';
const POCKET_GREEN = '#0c7a34';
const FRET_GOLD = '#d8b25e';
const WHEEL_NUMBER_FONT_SIZE = 34;
const WHEEL_ZERO_FONT_SIZE = 36;
const WHEEL_NUMBER_STROKE = 2.5;

const SVGNS = 'http://www.w3.org/2000/svg';

let balance = 5000;
let chip = 100;
let currentBet = null;
let previousBet = null;
let spinning = false;

let wheelRotation = 0;
let ballRotation = 0;
let ballRadiusPx = 0;

const stage = document.querySelector('.stage');
const wheelWrap = document.querySelector('.wheel-wrap');

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
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 1700);
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
   RESPONSIVE SIZING
   --ss = live stage width (px). Fonts, markers and the ball radius
   are all derived from it, so everything scales with the screen.
----------------------------- */
function setBallRadius() {
  if (!rouletteBall || !wheelWrap) return;
  ballRadiusPx = wheelWrap.clientWidth * BALL_RADIUS_FRACTION;
  rouletteBall.style.transform = `translateY(${-ballRadiusPx}px)`;
}

function setStageSize() {
  if (!stage) return;
  stage.style.setProperty('--ss', `${stage.clientWidth}px`);
  setBallRadius();
}

/* -----------------------------
   WHEEL POCKET RING (painted on the wheel, rotates with it)
   Draws correctly-coloured pockets + gold frets + numbers in SVG,
   covering the decorative painted band so colours are always right.
----------------------------- */
function polar(cx, cy, r, deg) {
  const a = deg * Math.PI / 180;
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}

function annularWedge(cx, cy, rIn, rOut, a0, a1) {
  const [x0o, y0o] = polar(cx, cy, rOut, a0);
  const [x1o, y1o] = polar(cx, cy, rOut, a1);
  const [x1i, y1i] = polar(cx, cy, rIn, a1);
  const [x0i, y0i] = polar(cx, cy, rIn, a0);
  const large = (a1 - a0) > 180 ? 1 : 0;
  return `M ${x0o} ${y0o} A ${rOut} ${rOut} 0 ${large} 1 ${x1o} ${y1o} `
       + `L ${x1i} ${y1i} A ${rIn} ${rIn} 0 ${large} 0 ${x0i} ${y0i} Z`;
}

function buildWheelPockets() {
  if (!wheelNumberSvg) return;
  wheelNumberSvg.innerHTML = '';

  const cx = WHEEL_CENTER_X, cy = WHEEL_CENTER_Y;
  const step = 360 / EUROPEAN_WHEEL.length;

  // 1) coloured pocket wedges (correct roulette colours)
  EUROPEAN_WHEEL.forEach((num, i) => {
    const aMid = WHEEL_OFFSET + i * step;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', annularWedge(cx, cy, POCKET_INNER_R, POCKET_OUTER_R, aMid - step / 2, aMid + step / 2));
    path.setAttribute('fill', num === 0 ? POCKET_GREEN : (redNumbers.has(num) ? POCKET_RED : POCKET_BLACK));
    wheelNumberSvg.appendChild(path);
  });

  // 2) gold frets between pockets
  for (let i = 0; i < EUROPEAN_WHEEL.length; i++) {
    const aEdge = WHEEL_OFFSET + (i + 0.5) * step;
    const [xi, yi] = polar(cx, cy, POCKET_INNER_R, aEdge);
    const [xo, yo] = polar(cx, cy, POCKET_OUTER_R, aEdge);
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', xi); line.setAttribute('y1', yi);
    line.setAttribute('x2', xo); line.setAttribute('y2', yo);
    line.setAttribute('stroke', FRET_GOLD);
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('opacity', '0.85');
    wheelNumberSvg.appendChild(line);
  }

  // 3) gold rings at inner & outer edge
  [POCKET_INNER_R, POCKET_OUTER_R].forEach(r => {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', FRET_GOLD);
    c.setAttribute('stroke-width', '2');
    c.setAttribute('opacity', '0.9');
    wheelNumberSvg.appendChild(c);
  });

  // 4) numbers, oriented radially
  EUROPEAN_WHEEL.forEach((num, i) => {
    const aMid = WHEEL_OFFSET + i * step;
    const [x, y] = polar(cx, cy, WHEEL_NUMBER_RADIUS, aMid);
    const text = document.createElementNS(SVGNS, 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', y);
    text.setAttribute('fill', '#ffffff');
    text.setAttribute('font-size', String(num === 0 ? WHEEL_ZERO_FONT_SIZE : WHEEL_NUMBER_FONT_SIZE));
    text.setAttribute('font-weight', '900');
    text.setAttribute('font-family', 'Georgia, "Times New Roman", serif');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('paint-order', 'stroke');
    text.setAttribute('stroke', '#000000');
    text.setAttribute('stroke-width', String(WHEEL_NUMBER_STROKE));
    text.setAttribute('transform', `rotate(${aMid + 90} ${x} ${y})`);
    text.textContent = num;
    wheelNumberSvg.appendChild(text);
  });
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
  const TOP_ANGLE = -90; // 12 o'clock — where the winning number rests

  rouletteBall.style.opacity = '1';

  wheelSpinLayer.style.transition = 'none';
  ballOrbit.style.transition = 'none';
  wheelSpinLayer.offsetHeight; // force repaint before animating

  // WHEEL: several full forward turns, then stop with the winner on top.
  wheelRotation += 360 * WHEEL_SPINS;
  const targetNet = (((TOP_ANGLE - (WHEEL_OFFSET + index * step)) % 360) + 360) % 360;
  const currentNet = ((wheelRotation % 360) + 360) % 360;
  let wheelAdjust = targetNet - currentNet;
  if (wheelAdjust < 0) wheelAdjust += 360;
  wheelRotation += wheelAdjust;

  // BALL: spins the opposite way and settles at the top pocket.
  ballRotation -= 360 * BALL_SPINS;
  const currentBall = ((ballRotation % 360) + 360) % 360;
  let ballAdjust = -currentBall;
  if (ballAdjust > 0) ballAdjust -= 360;
  ballRotation += ballAdjust;

  wheelSpinLayer.style.transition = 'transform 5s cubic-bezier(.12,.72,.14,1)';
  ballOrbit.style.transition = 'transform 5s cubic-bezier(.08,.74,.12,1)';

  wheelSpinLayer.style.transform = `rotate(${wheelRotation}deg)`;
  ballOrbit.style.transform = `rotate(${ballRotation}deg)`;
}

function hideBall() {
  if (rouletteBall) rouletteBall.style.opacity = '0';
}

/* -----------------------------
   BETTING
----------------------------- */
function showBetChip(zone) {
  if (!chipMarkerLayer || !zone || !stage) return;
  chipMarkerLayer.innerHTML = '';

  const stageRect = stage.getBoundingClientRect();
  const zoneRect = zone.getBoundingClientRect();
  const x = zoneRect.left - stageRect.left + zoneRect.width / 2;
  const y = zoneRect.top - stageRect.top + zoneRect.height / 2;

  const marker = document.createElement('div');
  marker.className = 'bet-chip-marker';
  marker.textContent = chip >= 1000 ? '1K' : chip;
  marker.style.left = `${x}px`;
  marker.style.top = `${y}px`;
  chipMarkerLayer.appendChild(marker);
}

function highlightChip() {
  document.querySelectorAll('.chip-zone').forEach(btn => {
    btn.classList.toggle('selected', Number(btn.dataset.chip) === chip);
  });
}

function setChip(amount) {
  chip = Number(amount);
  highlightChip();
  updateMoney();
  if (currentBet) showBetChip(document.querySelector('.zone.bet-selected'));
  showToast(`${money(chip)} chip selected`);
}

function resetWinReadout() {
  if (lastWinText) lastWinText.textContent = '—';
  if (lastColorText) lastColorText.textContent = 'PLACE BET';
}

function placeBet(type, value) {
  if (!type || value === undefined) return;

  const parsed =
    type === 'number' || type === 'dozen' || type === 'column'
      ? Number(value)
      : value;

  currentBet = { type, value: parsed };
  previousBet = { type, value: parsed };

  document.querySelectorAll('.zone').forEach(btn => btn.classList.remove('bet-selected'));

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
  if (type === 'dozen') label = parsed === 1 ? '1ST 12' : parsed === 2 ? '2ND 12' : '3RD 12';
  if (type === 'column') {
    label = parsed === 3 ? 'TOP 2 TO 1' : parsed === 2 ? 'MIDDLE 2 TO 1' : 'BOTTOM 2 TO 1';
  }

  resetWinReadout();
  showToast(`Bet placed: ${String(label).toUpperCase()}`);
}

async function spinRoulette() {
  if (spinning) return;
  if (!currentBet) return showToast('Place a bet first');

  const { playerId, playerSecret } = getPlayerCredentials();
  if (!playerId || !playerSecret) return showToast('Player login missing');
  if (balance < chip) return showToast('Not enough balance');

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
      if (lastWinText) lastWinText.textContent = '—';
      return;
    }

    const resultNumber = Number(data.resultNumber);
    const resultColor = data.resultColor || numberColor(resultNumber);

    animateWheelToNumber(resultNumber);

    setTimeout(() => {
      balance = Number(data.balanceAfter ?? balance);

      if (lastWinText) lastWinText.textContent = money(data.payout ?? 0);
      if (lastColorText) lastColorText.textContent = String(resultColor).toUpperCase();

      updateMoney();

      if (data.won) {
        showToast(`${resultNumber} ${String(resultColor).toUpperCase()} — you won ${money(data.payout)}`);
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
    if (lastWinText) lastWinText.textContent = '—';
  }
}

function clearBet(msg = 'Bet cleared') {
  currentBet = null;
  document.querySelectorAll('.zone').forEach(btn => btn.classList.remove('bet-selected'));
  if (chipMarkerLayer) chipMarkerLayer.innerHTML = '';
  resetWinReadout();
  showToast(msg);
}

function doubleBet() {
  chip = Math.min(chip * 2, 1000);
  highlightChip();
  updateMoney();
  if (currentBet) showBetChip(document.querySelector('.zone.bet-selected'));
  showToast(`Bet doubled to ${money(chip)}`);
}

function rebet() {
  if (!previousBet) return showToast('No previous bet');
  currentBet = { ...previousBet };

  document.querySelectorAll('.zone').forEach(btn => btn.classList.remove('bet-selected'));
  const selectedZone = document.querySelector(
    `.zone[data-bet="${currentBet.type}"][data-value="${currentBet.value}"]`
  );
  if (selectedZone) {
    selectedZone.classList.add('bet-selected');
    showBetChip(selectedZone);
  }
  resetWinReadout();
  showToast('Previous bet restored');
}

/* -----------------------------
   EVENTS / INIT
----------------------------- */
document.querySelectorAll('.zone').forEach(btn => {
  btn.addEventListener('click', () => placeBet(btn.dataset.bet, btn.dataset.value));
});

document.querySelectorAll('.chip-zone').forEach(btn => {
  btn.addEventListener('click', () => setChip(btn.dataset.chip));
});

if (spinButton) spinButton.addEventListener('click', spinRoulette);
document.getElementById('clearButton')?.addEventListener('click', () => clearBet());
document.getElementById('doubleButton')?.addEventListener('click', doubleBet);
document.getElementById('rebetButton')?.addEventListener('click', rebet);
// single-bet model: Undo removes the current bet
document.getElementById('undoButton')?.addEventListener('click', () => clearBet('Bet removed'));

window.addEventListener('resize', setStageSize);
window.addEventListener('orientationchange', setStageSize);
window.addEventListener('load', setStageSize);

buildWheelPockets();
setStageSize();
highlightChip();
updateMoney();
loadWalletBalance();
showToast('Tap the table to place a bet');
