const redNumbers = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

let balance = 5000;
let chip = 100;
let currentBet = null;
let previousBet = null;
let spinning = false;
let visualBallRotation = 0;

const chipMarkerLayer = document.getElementById('chipMarkerLayer');
const spinButton = document.getElementById('spinButton');
const balanceText = document.getElementById('balanceText');
const totalBetText = document.getElementById('totalBetText');
const lastWinText = document.getElementById('lastWinText');
const lastColorText = document.getElementById('lastColorText');
const toast = document.getElementById('toast');
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

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 1600);
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
  } catch (error) {
    showToast('Wallet connection error');
    updateMoney();
  }
}

function numberColor(number) {
  if (number === 0) return 'green';
  return redNumbers.has(number) ? 'red' : 'black';
}

function showBetChip(zone) {
  if (!chipMarkerLayer || !zone) return;

  chipMarkerLayer.innerHTML = '';

  const shell = document.querySelector('.game-shell');
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
  chip = amount;

  document.querySelectorAll('.chip-zone').forEach(btn => {
    btn.classList.toggle('selected', Number(btn.dataset.chip) === chip);
  });

  updateMoney();
  showToast(`${money(chip)} chip selected`);
}

function placeBet(type, value) {
  const parsed =
    type === 'number' ||
    type === 'dozen' ||
    type === 'column'
      ? Number(value)
      : value;

  currentBet = { type, value: parsed };
  previousBet = currentBet;

  document.querySelectorAll('.zone').forEach(btn => {
    btn.classList.remove('bet-selected');
  });

  const selectedZone = document.querySelector(
    `.zone[data-bet="${type}"][data-value="${value}"]`
  );

  if (selectedZone) {
    selectedZone.classList.add('bet-selected');
  }

  showBetChip(selectedZone);

  let label = parsed;

  if (type === 'color') label = String(parsed).toUpperCase();
  if (type === 'oddEven') label = String(parsed).toUpperCase();
  if (type === 'range') label = parsed === 'low' ? '1–18' : '19–36';
  if (type === 'dozen') label = parsed === 1 ? '1ST 12' : parsed === 2 ? '2ND 12' : '3RD 12';

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

function animateBall() {
  if (!rouletteBall) return;

  rouletteBall.style.transition = 'none';
  rouletteBall.style.opacity = '1';
  rouletteBall.style.transform = 'rotate(0deg) translateY(-70px)';

  rouletteBall.offsetHeight;

  setTimeout(() => {
    visualBallRotation = 1800 + Math.floor(Math.random() * 360);
    rouletteBall.style.transition =
      'transform 3.8s cubic-bezier(.12,.75,.18,1), opacity .2s ease';
    rouletteBall.style.transform =
      `rotate(${visualBallRotation}deg) translateY(-70px)`;
  }, 30);
}

function hideBall() {
  if (!rouletteBall) return;
  rouletteBall.style.opacity = '0';
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
  spinButton.disabled = true;

  animateBall();

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
      spinButton.disabled = false;
      return;
    }

    setTimeout(() => {
      balance = Number(data.balanceAfter);

      if (lastWinText) lastWinText.textContent = data.resultNumber;
      if (lastColorText) lastColorText.textContent = String(data.resultColor).toUpperCase();

      updateMoney();
      hideBall();

      if (data.won) {
        showToast(`You won ${money(data.payout)}`);
      } else {
        showToast(`Landed on ${data.resultNumber} ${String(data.resultColor).toUpperCase()}`);
      }

      spinning = false;
      spinButton.disabled = false;
    }, 4200);
  } catch (error) {
    showToast('Connection error');
    hideBall();
    spinning = false;
    spinButton.disabled = false;
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
  updateMoney();
  showToast(`Bet doubled to ${money(chip)}`);
}

function rebet() {
  if (!previousBet) return showToast('No previous bet');

  currentBet = previousBet;

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

document.querySelectorAll('.zone').forEach(btn => {
  btn.addEventListener('click', () => {
    placeBet(btn.dataset.bet, btn.dataset.value);
  });
});

document.querySelectorAll('.chip-zone').forEach(btn => {
  btn.addEventListener('click', () => {
    setChip(Number(btn.dataset.chip));
  });
});

if (spinButton) spinButton.addEventListener('click', spinRoulette);
document.getElementById('clearButton')?.addEventListener('click', clearBet);
document.getElementById('doubleButton')?.addEventListener('click', doubleBet);
document.getElementById('rebetButton')?.addEventListener('click', rebet);

updateMoney();
loadWalletBalance();
showToast('Tap the table to place a bet');