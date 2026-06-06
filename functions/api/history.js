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
    const playerSecret = String(url.searchParams.get("playerSecret") || "").trim();

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json({ ok: false, error: "Invalid Player ID." }, 400);
    }

    if (!playerSecret || playerSecret.length < 20) {
      return json({ ok: false, error: "Invalid Player Secret." }, 400);
    }

    const player = await db.prepare(`
      SELECT
        id,
        player_secret,
        character_name,
        discord_name,
        status,
        vip_tier
      FROM players
      WHERE id = ?
    `).bind(playerId).first();

    if (!player) {
      return json({ ok: false, error: "Player not found." }, 404);
    }

    if (player.player_secret !== playerSecret) {
      return json({ ok: false, error: "Player Secret mismatch." }, 401);
    }

    const transactions = await db.prepare(`
      SELECT
        id,
        type,
        amount,
        balance_after,
        game,
        note,
        created_at
      FROM transactions
      WHERE player_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `).bind(playerId).all();

    return json({
      ok: true,
      player: {
        id: player.id,
        character_name: player.character_name,
        discord_name: player.discord_name,
        status: player.status,
        vip_tier: player.vip_tier
      },
      transactions: transactions.results || []
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "History lookup failed."
    }, 500);
  }
}