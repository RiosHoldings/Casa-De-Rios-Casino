function json(data, status = 200) {
  return Response.json(data, { status });
}

function makePlayerId() {
  return "CDR-" + crypto.randomUUID().slice(0, 8).toUpperCase();
}

function makeSecret() {
  return crypto.randomUUID() + "-" + crypto.randomUUID();
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;

    if (!db) {
      return json({ ok: false, error: "D1 database binding DB is missing." }, 500);
    }

    const body = await context.request.json();

    const existingPlayerId = String(body.playerId || "").trim();
    const existingPlayerSecret = String(body.playerSecret || "").trim();

    const playerId = existingPlayerId || makePlayerId();
    const playerSecret = existingPlayerSecret || makeSecret();

    const characterName = String(body.characterName || "").trim();
    const discordName = String(body.discordName || "").trim();
    const amount = Math.floor(Number(body.amount || 0));
    const notes = String(body.notes || "").trim();

    if (!characterName || !discordName) {
      return json({ ok: false, error: "Character name and Discord name are required." }, 400);
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ ok: false, error: "Enter a valid buy-in amount." }, 400);
    }

    const existingPlayer = await db.prepare(`
      SELECT id, player_secret
      FROM players
      WHERE id = ?
    `).bind(playerId).first();

    if (existingPlayer) {
      if (existingPlayer.player_secret !== playerSecret) {
        return json({ ok: false, error: "Player Secret mismatch." }, 401);
      }

      await db.prepare(`
        UPDATE players
        SET character_name = ?,
            discord_name = ?,
            status = 'waiting_buyin',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(characterName, discordName, playerId).run();
    } else {
      await db.prepare(`
        INSERT INTO players (
          id,
          player_secret,
          character_name,
          discord_name,
          status,
          vip_tier,
          lifetime_wagered,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'waiting_buyin', 'patron', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(
        playerId,
        playerSecret,
        characterName,
        discordName
      ).run();
    }

    await db.prepare(`
      INSERT OR IGNORE INTO wallets (
        player_id,
        chips,
        locked,
        updated_at
      )
      VALUES (?, 0, 0, CURRENT_TIMESTAMP)
    `).bind(playerId).run();

    await db.prepare(`
      INSERT INTO buyins (
        player_id,
        character_name,
        discord_name,
        amount,
        notes,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, 'pending', strftime('%s','now'))
    `).bind(
      playerId,
      characterName,
      discordName,
      amount,
      notes
    ).run();

    return json({
      ok: true,
      message: "Buy-in request submitted.",
      playerId,
      playerSecret,
      characterName,
      discordName,
      amount,
      status: "pending"
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Buy-in request failed."
    }, 500);
  }
}