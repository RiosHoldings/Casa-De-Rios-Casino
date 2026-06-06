const PLAYER_KEY = "casa_rios_player_id";
const PLAYER_SECRET_KEY = "casa_rios_player_secret";

function makePlayerId() {
  if (crypto && crypto.randomUUID) {
    return "CDR-" + crypto.randomUUID();
  }

  return "CDR-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function makePlayerSecret() {
  if (crypto && crypto.randomUUID) {
    return "SECRET-" + crypto.randomUUID() + "-" + crypto.randomUUID();
  }

  return "SECRET-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function getPlayerId() {
  let id = localStorage.getItem(PLAYER_KEY);

  if (!id) {
    id = makePlayerId();
    localStorage.setItem(PLAYER_KEY, id);
  }

  return id;
}

function getPlayerSecret() {
  let secret = localStorage.getItem(PLAYER_SECRET_KEY);

  if (!secret) {
    secret = makePlayerSecret();
    localStorage.setItem(PLAYER_SECRET_KEY, secret);
  }

  return secret;
}

function renderPlayerId() {
  const box = document.getElementById("playerId");
  if (box) box.textContent = getPlayerId();
}

function setWalletText(text) {
  const box = document.getElementById("walletBalance");
  if (box) box.textContent = text;
}

function setStatusText(text) {
  const box = document.getElementById("playerStatus");
  if (box) box.textContent = text;
}

async function loadWallet() {
  const playerId = getPlayerId();
  const playerSecret = getPlayerSecret();

  setWalletText("Balance: Loading...");
  setStatusText("Status: Loading...");

  try {
    const response = await fetch(
      "/api/wallet?playerId=" +
      encodeURIComponent(playerId) +
      "&playerSecret=" +
      encodeURIComponent(playerSecret)
    );

    const data = await response.json();

    if (!data.ok) {
      setWalletText("Balance: Create / Update Player first");
      setStatusText("Status: " + data.error);
      return;
    }

    const chips = Number(data.player.chips || 0);
    const locked = Number(data.player.locked || 0);
    const status = data.player.status || "unknown";
    const vip = data.player.vip_tier || "none";

    setWalletText("Balance: " + chips.toLocaleString() + " chips");
    setStatusText(
      "Status: " + status +
      " | VIP: " + vip +
      " | Locked: " + locked.toLocaleString()
    );
  } catch (error) {
    setWalletText("Balance: Wallet API failed");
    setStatusText("Status: Check deployment");
  }
}

async function registerPlayer() {
  const playerId = getPlayerId();
  const playerSecret = getPlayerSecret();

  const characterName = prompt("Character name:", "Survivor") || "Survivor";
  const discordName = prompt("Discord name:", "") || "";

  try {
    const response = await fetch("/api/player", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        playerId,
        playerSecret,
        characterName,
        discordName
      })
    });

    const data = await response.json();

    if (!data.ok) {
      alert("Player registration failed: " + data.error);
      return;
    }

    alert(
      "Player saved in Cloudflare.\n" +
      "Status: " + data.player.status + "\n" +
      "Chips: " + data.player.chips
    );

    renderPlayerId();
    loadWallet();
  } catch (error) {
    alert("Player API failed. Check D1 binding and schema.");
  }
}

async function testBackend() {
  const status = document.getElementById("apiStatus");
  if (!status) return;

  status.textContent = "Testing...";

  try {
    const response = await fetch("/api/health");
    const data = await response.json();

    if (data.ok) {
      status.textContent = "Backend online: " + data.service;
    } else {
      status.textContent = "Backend responded, but not OK.";
    }
  } catch (error) {
    status.textContent = "Backend not connected yet.";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  renderPlayerId();
  getPlayerSecret();
  loadWallet();

  const createBtn = document.getElementById("createPlayerBtn");
  if (createBtn) {
    createBtn.addEventListener("click", registerPlayer);
  }

  const refreshBtn = document.getElementById("refreshWalletBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", loadWallet);
  }

  const apiBtn = document.getElementById("apiTestBtn");
  if (apiBtn) {
    apiBtn.addEventListener("click", testBackend);
  }
});