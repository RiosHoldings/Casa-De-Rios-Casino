function json(data, status = 200) {
  return Response.json(data, { status });
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const expectedKey = context.env.ADMIN_KEY;
    const givenKey = context.request.headers.get("x-admin-key");

    if (!db) {
      return json({ ok: false, error: "D1 database binding DB is missing." }, 500);
    }

    if (!expectedKey) {
      return json({ ok: false, error: "ADMIN_KEY secret is missing." }, 500);
    }

    if (!givenKey || givenKey !== expectedKey) {
      return json({ ok: false, error: "Unauthorized admin request." }, 401);
    }

    const body = await context.request.json();

    const playerId = String(body.playerId || "").trim();
    const amount = Math.floor(Number(body.amount || 0));
    const note = String(body.note || "Admin chip add").trim();

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json({ ok: false, error: "Invalid Player ID." }, 400);
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ ok: false, error: "Amount must be a positive number." }, 400);
    }

    const player = await db.prepare(`
      SELECT id, character_name, discord_name, status
      FROM players
      WHERE id = ?
    `).bind(playerId).first();

    if (!player) {
      return json({ ok: false, error: "Player not found. They must create a Player ID first." }, 404);
    }

    await db.prepare(`
      UPDATE wallets
      SET chips = chips + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE player_id = ?
    `).bind(amount, playerId).run();

    const wallet = await db.prepare(`
      SELECT chips, locked
      FROM wallets
      WHERE player_id = ?
    `).bind(playerId).first();

    await db.prepare(`
      UPDATE players
      SET status = 'active',
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
      VALUES (?, ?, 'admin_add_chips', ?, ?, 'admin', ?, CURRENT_TIMESTAMP)
    `).bind(
      transactionId,
      playerId,
      amount,
      wallet.chips,
      note
    ).run();

    return json({
      ok: true,
      message: "Chips added.",
      playerId,
      amountAdded: amount,
      balanceAfter: wallet.chips,
      transactionId
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Admin add chips failed."
    }, 500);
  }
}
