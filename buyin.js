const PLAYER_KEY = "casa_rios_player_id";
const PLAYER_SECRET_KEY = "casa_rios_player_secret";

function setResult(text) {
  const el = document.getElementById("buyinResult");
  if (el) el.textContent = text;
}

function money(n) {
  return Number(n || 0).toLocaleString();
}

async function submitBuyIn() {
  const characterName = document.getElementById("characterName").value.trim();
  const discordName = document.getElementById("discordName").value.trim();
  const amount = Math.floor(Number(document.getElementById("buyinAmount").value || 0));
  const notes = document.getElementById("buyinNote").value.trim();

  let playerId = localStorage.getItem(PLAYER_KEY);
  let playerSecret = localStorage.getItem(PLAYER_SECRET_KEY);

  if (!characterName || !discordName) {
    setResult("Character name and Discord name are required.");
    return;
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    setResult("Enter a valid buy-in amount.");
    return;
  }

  setResult("Submitting buy-in request...");

  try {
    const response = await fetch("/api/buyin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        playerId,
        playerSecret,
        characterName,
        discordName,
        amount,
        notes
      })
    });

    const data = await response.json();

    if (!data.ok) {
      setResult("Failed: " + (data.error || "Buy-in request failed."));
      return;
    }

    localStorage.setItem(PLAYER_KEY, data.playerId);
    localStorage.setItem(PLAYER_SECRET_KEY, data.playerSecret);

    setResult(
      "Buy-in request submitted. " +
      money(data.amount) +
      " chips requested. Player ID: " +
      data.playerId +
      ". Wait for Casa de Ríos staff approval."
    );
  } catch (error) {
    setResult("Buy-in request failed. Check deployment.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("buyinBtn");
  if (btn) btn.addEventListener("click", submitBuyIn);
});