const PLAYER_KEY = "casa_rios_player_id";
const PLAYER_SECRET_KEY = "casa_rios_player_secret";

function setResult(text) {
  document.getElementById("buyinResult").textContent = text;
}

async function submitBuyIn() {
  const characterName = document.getElementById("characterName").value.trim();
  const discordName = document.getElementById("discordName").value.trim();
  const amount = Number(document.getElementById("buyinAmount").value);
  const notes = document.getElementById("buyinNote").value.trim();

  const playerId = localStorage.getItem(PLAYER_KEY);
  const playerSecret = localStorage.getItem(PLAYER_SECRET_KEY);

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
      setResult("Failed: " + data.error);
      return;
    }

    localStorage.setItem(PLAYER_KEY, data.playerId);
    localStorage.setItem(PLAYER_SECRET_KEY, data.playerSecret);

    setResult(
      "Buy-in request submitted. Player ID: " +
      data.playerId +
      ". Wait for Casa de Ríos staff to approve."
    );
  } catch (error) {
    setResult("Buy-in request failed. Check deployment.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("buyinBtn").addEventListener("click", submitBuyIn);
});