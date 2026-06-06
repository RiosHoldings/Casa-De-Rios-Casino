function json(data, status = 200) {
  return Response.json(data, { status });
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;

    if (!db) {
      return json({ ok: false, error: "D1 database binding DB is missing." }, 500);
    }

    const body = await context.request.json();

    const playerId = String(body.playerId || "").trim();
    const playerSecret = String(body.playerSecret || "").trim();
    const characterName = String(body.characterName || "Survivor").trim();
    const discordName = String(body.discordName || "").trim();

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json({ ok: false, error: "Invalid Player ID." }, 400);
    }

    if (!playerSecret || playerSecret.length < 20) {
      return json({ ok: false, error: "Invalid Player Secret." }, 400);
    }

    const existing = await db.prepare(`
      SELECT id, player_secret
      FROM players
      WHERE id = ?
    `).bind(playerId).first();

    if (existing && existing.player_secret && existing.player_secret !== playerSecret) {
      return json({
        ok: false,
        error: "This Player ID belongs to another saved device/session."
      }, 401);
    }

    if (!existing) {
      await db.prepare(`
        INSERT INTO players (
          id,
          player_secret,
          character_name,
          discord_name,
          status,
          vip_tier,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'waiting_buyin', 'none', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(playerId, playerSecret, characterName, discordName).run();
    } else {
      await db.prepare(`
        UPDATE players
        SET player_secret = COALESCE(player_secret, ?),
            character_name = ?,
            discord_name = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(playerSecret, characterName, discordName, playerId).run();
    }

    await db.prepare(`
      INSERT INTO wallets (
        player_id,
        chips,
        locked,
        updated_at
      )
      VALUES (?, 0, 0, CURRENT_TIMESTAMP)
      ON CONFLICT(player_id) DO NOTHING
    `).bind(playerId).run();

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

    return json({
      ok: true,
      player
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Player API failed."
    }, 500);
  }
}