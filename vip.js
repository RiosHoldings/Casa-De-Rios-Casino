const PLAYER_KEY = "casa_rios_player_id";
const PLAYER_SECRET_KEY = "casa_rios_player_secret";

const VIP_TIERS = [
  { key: "patron", label: "PATRÓN", needed: 0 },
  { key: "caballero", label: "CABALLERO", needed: 100000 },
  { key: "magnate", label: "MAGNATE", needed: 500000 },
  { key: "el_jefe", label: "EL JEFE", needed: 1000000 },
  { key: "la_leyenda", label: "LA LEYENDA", needed: Infinity }
];

function money(n) {
  return Number(n || 0).toLocaleString();
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function normalizeVip(value) {
  const clean = String(value || "patron").toLowerCase().trim();

  if (clean === "none") return "patron";
  if (clean === "el jefe") return "el_jefe";
  if (clean === "la leyenda") return "la_leyenda";

  return clean;
}

function getTierByKey(key) {
  return VIP_TIERS.find(tier => tier.key === normalizeVip(key)) || VIP_TIERS[0];
}

function getAutoTier(lifetimeWagered, currentVipTier) {
  if (normalizeVip(currentVipTier) === "la_leyenda") {
    return getTierByKey("la_leyenda");
  }

  if (lifetimeWagered >= 1000000) return getTierByKey("el_jefe");
  if (lifetimeWagered >= 500000) return getTierByKey("magnate");
  if (lifetimeWagered >= 100000) return getTierByKey("caballero");

  return getTierByKey("patron");
}

function getNextTier(currentTier) {
  if (currentTier.key === "patron") return getTierByKey("caballero");
  if (currentTier.key === "caballero") return getTierByKey("magnate");
  if (currentTier.key === "magnate") return getTierByKey("el_jefe");

  return getTierByKey("la_leyenda");
}

function highlightTier(tierKey) {
  document.querySelectorAll(".vip-tier").forEach(card => {
    card.classList.toggle("active", card.dataset.tier === tierKey);
  });
}

function updateVipDisplay(player) {
  const lifetimeWagered = Number(player.lifetime_wagered || 0);
  const currentTier = getAutoTier(lifetimeWagered, player.vip_tier);
  const nextTier = getNextTier(currentTier);

  setText("currentVipTier", currentTier.label);
  highlightTier(currentTier.key);

  if (currentTier.key === "la_leyenda") {
    setText(
      "vipProgressText",
      `${money(lifetimeWagered)} lifetime wagered. You have reached La Leyenda.`
    );
    return;
  }

  if (nextTier.key === "la_leyenda") {
    setText(
      "vipProgressText",
      `${money(lifetimeWagered)} lifetime wagered. La Leyenda is invitation only.`
    );
    return;
  }

  const remaining = Math.max(0, nextTier.needed - lifetimeWagered);

  setText(
    "vipProgressText",
    `${money(lifetimeWagered)} lifetime wagered. \n${money(remaining)} chips until ${nextTier.label}.`
  );
}

async function loadVipStatus() {
  const playerId = localStorage.getItem(PLAYER_KEY);
  const playerSecret = localStorage.getItem(PLAYER_SECRET_KEY);

  if (!playerId || !playerSecret) {
    setText("currentVipTier", "PATRÓN");
    setText("vipProgressText", "Create your player profile from the lobby first.");
    highlightTier("patron");
    return;
  }

  try {
    const response = await fetch(
      "/api/wallet?playerId=" +
      encodeURIComponent(playerId) +
      "&playerSecret=" +
      encodeURIComponent(playerSecret)
    );

    const data = await response.json();

    if (!data.ok) {
      setText("currentVipTier", "PATRÓN");
      setText("vipProgressText", data.error || "Could not load VIP progress.");
      highlightTier("patron");
      return;
    }

    updateVipDisplay(data.player || {});
  } catch (error) {
    setText("currentVipTier", "PATRÓN");
    setText("vipProgressText", "VIP progress failed to load.");
    highlightTier("patron");
  }
}

document.addEventListener("DOMContentLoaded", loadVipStatus);