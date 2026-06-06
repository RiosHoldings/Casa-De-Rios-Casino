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
    const note = String(body.note || "Player requested cash-out").trim();

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json({ ok: false, error: "Invalid Player ID." }, 400);
    }

    if (!playerSecret || playerSecret.length < 20) {
      return json({ ok: false, error: "Invalid Player Secret." }, 400);
    }

    const player = await db.prepare(`
      SELECT id, player_secret, character_name, discord_name, status
      FROM players
      WHERE id = ?
    `).bind(playerId).first();

    if (!player) {
      return json({ ok: false, error: "Player not found." }, 404);
    }

    if (player.player_secret !== playerSecret) {
      return json({ ok: false, error: "Player Secret mismatch." }, 401);
    }

    const wallet = await db.prepare(`
      SELECT chips, locked
      FROM wallets
      WHERE player_id = ?
    `).bind(playerId).first();

    if (!wallet) {
      return json({ ok: false, error: "Wallet not found." }, 404);
    }

    if (wallet.locked) {
      return json({ ok: false, error: "Wallet is already locked for payout review." }, 400);
    }

    const chips = Number(wallet.chips || 0);

    if (chips <= 0) {
      return json({ ok: false, error: "No chips available to cash out." }, 400);
    }

    const existingTicket = await db.prepare(`
      SELECT id, amount, status
      FROM payout_tickets
      WHERE player_id = ?
        AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(playerId).first();

    if (existingTicket) {
      return json({
        ok: false,
        error: "You already have a pending payout ticket.",
        ticket: existingTicket
      }, 400);
    }

    const ticketId = crypto.randomUUID();

    await db.prepare(`
      INSERT INTO payout_tickets (
        id,
        player_id,
        amount,
        status,
        note,
        created_at
      )
      VALUES (?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP)
    `).bind(ticketId, playerId, chips, note).run();

    await db.prepare(`
      UPDATE wallets
      SET locked = 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE player_id = ?
    `).bind(playerId).run();

    await db.prepare(`
      UPDATE players
      SET status = 'cashout_pending',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(playerId).run();

    const transactionId = crypto.randomUUID();

    await db.prepare(`
      INSERT INTO transactions (
        id,
        player_id,
        type,
        amount,
        balance_after,
        game,
        note,
        created_at
      )
      VALUES (?, ?, 'cashout_request', ?, ?, 'cashout', ?, CURRENT_TIMESTAMP)
    `).bind(
      transactionId,
      playerId,
      chips,
      chips,
      "Payout ticket created and wallet locked."
    ).run();

    return json({
      ok: true,
      message: "Cash-out ticket created.",
      ticketId,
      playerId,
      characterName: player.character_name,
      discordName: player.discord_name,
      amount: chips,
      status: "pending",
      walletLocked: true
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Cash-out failed."
    }, 500);
  }
}