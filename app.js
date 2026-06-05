const PLAYER_KEY = "casa_rios_player_id";

function makePlayerId() {
  if (crypto && crypto.randomUUID) {
    return "CDR-" + crypto.randomUUID();
  }

  return "CDR-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function getPlayerId() {
  let id = localStorage.getItem(PLAYER_KEY);

  if (!id) {
    id = makePlayerId();
    localStorage.setItem(PLAYER_KEY, id);
  }

  return id;
}

function renderPlayerId() {
  const box = document.getElementById("playerId");
  if (box) box.textContent = getPlayerId();
}

async function registerPlayer() {
  const playerId = getPlayerId();

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
      "Player created in Cloudflare.\n" +
      "Status: " + data.player.status + "\n" +
      "Chips: " + data.player.chips
    );

    renderPlayerId();
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

  const createBtn = document.getElementById("createPlayerBtn");
  if (createBtn) {
    createBtn.addEventListener("click", registerPlayer);
  }

  const apiBtn = document.getElementById("apiTestBtn");
  if (apiBtn) {
    apiBtn.addEventListener("click", testBackend);
  }
});