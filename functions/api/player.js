export async function onRequestPost(context) {
  try {
    const db = context.env.DB;

    if (!db) {
      return Response.json(
        { ok: false, error: "D1 database binding DB is missing." },
        { status: 500 }
      );
    }

    const body = await context.request.json();

    const playerId = String(body.playerId || "").trim();
    const characterName = String(body.characterName || "Survivor").trim();
    const discordName = String(body.discordName || "").trim();

    if (!playerId || !playerId.startsWith("CDR-")) {
      return Response.json(
        { ok: false, error: "Invalid Player ID." },
        { status: 400 }
      );
    }

    await db.prepare(`
      INSERT INTO players (
        id,
        character_name,
        discord_name,
        status,
        updated_at
      )
      VALUES (?, ?, ?, 'waiting_buyin', CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        character_name = excluded.character_name,
        discord_name = excluded.discord_name,
        updated_at = CURRENT_TIMESTAMP
    `).bind(playerId, characterName, discordName).run();

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

    return Response.json({
      ok: true,
      player
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error.message || "Player API failed."
      },
      { status: 500 }
    );
  }
}
