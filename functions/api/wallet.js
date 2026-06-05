function json(data, status = 200) {
  return Response.json(data, { status });
}

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

    if (!db) {
      return json({ ok: false, error: "D1 database binding DB is missing." }, 500);
    }

    const url = new URL(context.request.url);
    const playerId = String(url.searchParams.get("playerId") || "").trim();

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json({ ok: false, error: "Invalid Player ID." }, 400);
    }

    const player = await db.prepare(`
      SELECT
        players.id,
        players.character_name,
        players.discord_name,
        players.status,
        players.vip_tier,
        wallets.chips,
        wallets.locked
      FROM players
      LEFT JOIN wallets ON wallets.player_id = players.id
      WHERE players.id = ?
    `).bind(playerId).first();

    if (!player) {
      return json({
        ok: false,
        error: "Player not found. Create Player ID first."
      }, 404);
    }

    return json({
      ok: true,
      player
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Wallet lookup failed."
    }, 500);
  }
}