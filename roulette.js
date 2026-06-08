const redNumbers = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const wheelOrder = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];

let balance = 5000;
let chip = 100;
let currentBet = null;
let previousBet = null;
let spinning = false;
let visualBallRotation = 0;

const spinButton = document.getElementById('spinButton');
const balanceText = document.getElementById('balanceText');
const totalBetText = document.getElementById('totalBetText');
const lastWinText = document.getElementById('lastWinText');
const lastColorText = document.getElementById('lastColorText');
const toast = document.getElementById('toast');
const rouletteBall = document.getElementById('rouletteBall');

function money(value) {
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
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

  lastWinText.textContent = '—';
  lastColorText.textContent = 'PLACE BET';
}

function didWin(number, color) {
  if (!currentBet) return false;

  const { type, value } = currentBet;

  if (type === 'number') return number === value;
  if (type === 'color') return color === value;

  if (number === 0) return false;

  if (type === 'oddEven') {
    return value === 'odd' ? number % 2 === 1 : number % 2 === 0;
  }

  if (type === 'range') {
    return value === 'low'
      ? number >= 1 && number <= 18
      : number >= 19 && number <= 36;
  }

  if (type === 'dozen') {
    if (value === 1) return number >= 1 && number <= 12;
    if (value