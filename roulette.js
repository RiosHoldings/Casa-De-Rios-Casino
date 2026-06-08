const redNumbers = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const wheelOrder = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];

let balance = 5000;
let chip = 100;
let currentBet = null;
let previousBet = null;
let wheelRotation = 0;
let ballRotation = 0;
let spinning = false;

const spinButton = document.getElementById('spinButton');
const balanceText = document.getElementById('balanceText');
const totalBetText = document.getElementById('totalBetText');
const lastWinText = document.getElementById('lastWinText');
const lastColorText = document.getElementById('lastColorText');
const toast = document.getElementById('toast');
const rouletteBall = document.getElementById('rouletteBall');
let visualBallRotation = 0;

function money(value) {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 1600);
}

function updateMoney() {
  balanceText.textContent = money(balance);
  totalBetText.textContent = money(chip);
}

function numberColor(number) {
  if (number === 0) return 'green';
  return redNumbers.has(number) ? 'red' : 'black';
}

function setChip(amount) {
  chip = amount;
  document.querySelectorAll('.chip-zone').forEach(btn => btn.classList.toggle('selected', Number(btn.dataset.chip) === chip));
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

  document.querySelectorAll('.zone').forEach(btn => {
    btn.classList.remove('bet-selected');
  });

  const selectedZone = document.querySelector(
    `.zone[data-bet="${type}"][data-value="${value}"]`
  );

  if (selectedZone) {
    selectedZone.classList.add('bet-selected');
  }

  let label = parsed;

  if (type === 'dozen') {
    label = parsed === 1 ? '1ST 12' : parsed === 2 ? '2ND 12' : '3RD 12';
  }

  if (type === 'column') {
  label =
    parsed === 3 ? 'TOP 2 TO 1' :
    parsed === 2 ? 'MIDDLE 2 TO 1' :
    'BOTTOM 2 TO 1';
}

  showToast(`Bet placed: ${String(label).toUpperCase()}`);

  previousBet = currentBet
  lastWinText.textContent = '-';
  lastColorText.textContent = 'PLACE BET';
}

function didWin(number, color) {
  if (!currentBet) return false;
  const { type, value } = currentBet;
  if (type === 'number') return number === value;
  if (type === 'color') return color === value;
  if (number === 0) return false;
  if (type === 'oddEven') return value === 'odd' ? number % 2 === 1 : number % 2 === 0;
  if (type === 'range') return value === 'low' ? number >= 1 && number <= 18 : number >= 19 && number <= 36;
  if (type === 'dozen') return value === 1 ? number <= 12 : value === 2 ? number >= 13 && number <= 24 : number >= 25;
  if (type === 'column') {
  if (number === 0) return false;
  if (value === 1) return number % 3 === 1;
  if (value === 2) return number % 3 === 2;
  if (value === 3) return number % 3 === 0;
}
  return false;
}

function payoutMultiplier() {
  if (!currentBet) return 0;
  if (currentBet.type === 'number') return 36;
  if (currentBet.type === 'dozen' || currentBet.type === 'column') return 3;
  return 2;
}

function spinRoulette() {
  if (spinning) return;
  if (!currentBet) return showToast('Place a bet first');
  if (balance < chip) return showToast('Not enough balance');
  spinning = true;
  showToast(rouletteBall ? 'Ball found' : 'Ball missing');
  rouletteBall.style.transition = 'none';
rouletteBall.style.opacity = '1';
rouletteBall.style.transform = 'rotate(0deg) translateY(-70px)';

setTimeout(() => {
  visualBallRotation += 1800 + Math.floor(Math.random() * 360);
  rouletteBall.style.transition = 'transform 3.8s cubic-bezier(.12,.75,.18,1), opacity .2s ease';
  rouletteBall.style.transform = `rotate(${visualBallRotation}deg) translateY(-70px)`;
}, 30);
  balance -= chip;
  updateMoney();

  const winning = Math.floor(Math.random() * 37);
  const color = numberColor(winning);
  const pocketIndex = wheelOrder.indexOf(winning);
  const pocketAngle = pocketIndex * (360 / 37);

  lastWinText.textContent = '...';
  lastColorText.textContent = 'SPINNING';
  spinButton.disabled = true;

  setTimeout(() => {
    const won = didWin(winning, color);
    if (won) {
      const amount = chip * payoutMultiplier();
      balance += amount;
      showToast(`You won ${money(amount)}`);
    } else {
      showToast(`Landed on ${winning} ${color.toUpperCase()}`);
    }
    lastWinText.textContent = winning;
    lastColorText.textContent = color.toUpperCase();
    updateMoney();
    rouletteBall.style.opacity = '0';
    spinning = false;
    spinButton.disabled = false;
  }, 4200);
}

function clearBet() {
  currentBet = null;
  lastWinText.textContent = '—';
  lastColorText.textContent = 'PLACE BET';
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
  lastWinText.textContent = 'BET';
  lastColorText.textContent = String(currentBet.value).toUpperCase();
  showToast('Previous bet restored');
}

document.querySelectorAll('.zone').forEach(btn => {
  btn.addEventListener('click', (e) => {
    if (btn.dataset.bet === 'number-grid') {
      const picked = numberFromBoardClick(e);
      placeBet('number', picked);
    } else {
      placeBet(btn.dataset.bet, btn.dataset.value);
    }
  });
});

document.querySelectorAll('.chip-zone').forEach(btn => {
  btn.addEventListener('click', () => setChip(Number(btn.dataset.chip)));
});

spinButton.addEventListener('click', spinRoulette);
document.getElementById('clearButton').addEventListener('click', clearBet);
document.getElementById('doubleButton').addEventListener('click', doubleBet);
document.getElementById('rebetButton').addEventListener('click', rebet);

updateMoney();
showToast('Tap the table to place a bet');

