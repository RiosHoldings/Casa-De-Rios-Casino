const symbols = [
  { name: "logo", img: "/images/logo.jpeg", multiplier: 25 },
  { name: "crown", img: "/images/crown.jpeg", multiplier: 50 },
  { name: "seven", img: "/images/seven.png", multiplier: 15 },
  { name: "coin", img: "/images/coin.jpeg", multiplier: 10 },
  { name: "bell", img: "/images/bell.jpeg", multiplier: 8 },
  { name: "whiskey", img: "/images/whiskey.jpeg", multiplier: 5 },
  { name: "bar", img: "/images/bar.jpeg", multiplier: 4 },
  { name: "cherries", img: "/images/cherries.jpeg", multiplier: 3 }
];

const weightedSymbols = [
  "cherries", "cherries", "cherries", "cherries", "cherries", "cherries",
  "bar", "bar", "bar", "bar", "bar",
  "whiskey", "whiskey", "whiskey", "whiskey",
  "bell", "bell", "bell",
  "coin", "coin",
  "seven", "seven",
  "logo",
  "crown"
];

let balance = 2000000;
let bet = 1000;
let lastWin = 0;
let spinning = false;
let spinTimer = null;

const reelEls = [
  document.getElementById("reel1"),
  document.getElementById("reel2"),
  document.getElementById("reel3")
];

const betDisplay = document.getElementById("betDisplay");
const balanceDisplay = document.getElementById("balanceDisplay");
const winDisplay = document.getElementById("winDisplay");
const statusBox = document.getElementById("statusBox");

function money(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function updateDisplay() {
  betDisplay.textContent = money(bet);
  balanceDisplay.textContent = money(balance);
  winDisplay.textContent = money(lastWin);
}

function getSymbol(name) {
  return symbols.find(s => s.name === name) || symbols[0];
}

function randomSymbolName() {
  return weightedSymbols[Math.floor(Math.random() * weightedSymbols.length)];
}

function setReel(index, symbolName) {
  const symbol = getSymbol(symbolName);
  reelEls[index].innerHTML = `<img src="${symbol.img}" alt="${symbol.name}">`;
}

function setReels(names) {
  names.forEach((name, index) => setReel(index, name));
}

function setStatus(text, good = false) {
  statusBox.textContent = text;
  statusBox.className = good ? "status-box good" : "status-box bad";
}

function startSpinAnimation() {
  reelEls.forEach(reel => reel.classList.add("spinning"));

  spinTimer = setInterval(() => {
    setReels([
      randomSymbolName(),
      randomSymbolName(),
      randomSymbolName()
    ]);
  }, 70);
}

function stopSpinAnimation() {
  clearInterval(spinTimer);
  spinTimer = null;
  reelEls.forEach(reel => reel.classList.remove("spinning"));
}

function calculateWin(reels) {
  const [a, b, c] = reels;

  if (a === b && b === c) {
    return bet * getSymbol(a).multiplier;
  }

  if (a === "cherries" && b === "cherries") {
    return bet * 2;
  }

  if (a === "cherries") {
    return bet;
  }

  return 0;
}


async function spin() {
  if (spinning) return;

  if (balance < bet) {
    setStatus("Not enough chips.");
    return;
  }

  spinning = true;
  lastWin = 0;
  updateDisplay();
  setStatus("Spinning...", true);
  startSpinAnimation();

  const startedAt = Date.now();

  try {
    const response = await fetch("/api/slots", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        playerId: localStorage.getItem("casa_rios_player_id"),
        playerSecret: localStorage.getItem("casa_rios_player_secret"),
        betAmount: bet
      })
    });

    const data = await response.json();

    const elapsed = Date.now() - startedAt;
    const waitMore = Math.max(0, 1200 - elapsed);
    await new Promise(resolve => setTimeout(resolve, waitMore));

    stopSpinAnimation();

    if (!data.ok) {
      setStatus(data.error || "Spin denied.");
      spinning = false;
      return;
    }

    setReels(data.reels);

    lastWin = Number(data.payout || 0);
    balance = Number(data.balanceAfter || 0);

    updateDisplay();

    if (lastWin > 0) {
      setStatus(`Winner! You won ${money(lastWin)} chips.`, true);
    } else {
      setStatus("No win. The house keeps this one.");
    }

  } catch (error) {
    stopSpinAnimation();
    setStatus("Slots connection error.");
  }

  spinning = false;
}
document.getElementById("minusBet").addEventListener("click", () => {
  if (spinning) return;
  bet = Math.max(1000, bet - 1000);
  updateDisplay();
});

document.getElementById("plusBet").addEventListener("click", () => {
  if (spinning) return;
  bet = Math.min(10000, bet + 1000);
  updateDisplay();
});

document.getElementById("spinBtn").addEventListener("click", spin);

setReels(["cherries", "seven", "bell"]);
updateDisplay();
setStatus("Ready to spin.", true);