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
    createBtn.addEventListener("click", () => {
      const id = getPlayerId();
      navigator.clipboard?.writeText(id);
      alert("Player ID ready. It was copied if your browser allowed it.");
      renderPlayerId();
    });
  }

  const apiBtn = document.getElementById("apiTestBtn");
  if (apiBtn) {
    apiBtn.addEventListener("click", testBackend);
  }
});
