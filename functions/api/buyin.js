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
    const body = await context.request.json();

    const playerId = String(body.playerId || "").trim() || makePlayerId();
    const playerSecret = String(body.playerSecret || "").trim() || makeSecret();
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

    await db.prepare(`
      INSERT INTO players (
        id,
        player_secret,
        character_name,
        discord_name,
        status,
        vip_tier,
        lifetime_wagered,
        updated_at
      )
      VALUES (?, ?, ?, ?, 'waiting_buyin', 'patron', 0, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        character_name = excluded.character_name,
        discord_name = excluded.discord_name,
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      playerId,
      playerSecret,
      characterName,
      discordName
    ).run();

    await db.prepare(`
      INSERT OR IGNORE INTO wallets (
        player_id,
        chips,
        locked,
        updated_at
      )
      VALUES (?, 0, 0, CURRENT_TIMESTAMP)
    `).bind(playerId).run();

    const requestId = crypto.randomUUID();

    await db.prepare(`
      INSERT INTO buyin_requests (
        id,
        player_id,
        character_name,
        discord_name,
        amount,
        notes,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    `).bind(
      requestId,
      playerId,
      characterName,
      discordName,
      amount,
      notes
    ).run();

    return json({
      ok: true,
      message: "Buy-in request submitted.",
      requestId,
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