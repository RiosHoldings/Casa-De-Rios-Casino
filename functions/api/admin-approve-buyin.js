function json(data, status = 200) {
  return Response.json(data, { status });
}

function checkAdmin(context) {
  const expectedKey = context.env.ADMIN_KEY;
  const givenKey = context.request.headers.get("x-admin-key");

  if (!expectedKey) {
    return { ok: false, response: json({ ok: false, error: "ADMIN_KEY secret is missing." }, 500) };
  }

  if (!givenKey || givenKey !== expectedKey) {
    return { ok: false, response: json({ ok: false, error: "Unauthorized admin request." }, 401) };
  }

  return { ok: true };
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    if (!db) return json({ ok: false, error: "D1 database binding DB is missing." }, 500);

    const admin = checkAdmin(context);
    if (!admin.ok) return admin.response;

    const body = await context.request.json();

    const buyinId = Number(body.buyinId || 0);
    const approvedBy = String(body.approvedBy || "Casa de Ríos Admin").trim();

    if (!buyinId) {
      return json({ ok: false, error: "Missing buy-in request ID." }, 400);
    }

    const buyin = await db.prepare(`
      SELECT id, player_id, amount, status
      FROM buyins
      WHERE id = ?
    `).bind(buyinId).first();

    if (!buyin) {
      return json({ ok: false, error: "Buy-in request not found." }, 404);
    }

    if (buyin.status !== "pending") {
      return json({ ok: false, error: "Buy-in request is not pending." }, 400);
    }

    await db.prepare(`
      UPDATE wallets
      SET chips = chips + ?,
          locked = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE player_id = ?
    `).bind(buyin.amount, buyin.player_id).run();

    const wallet = await db.prepare(`
      SELECT chips
      FROM wallets
      WHERE player_id = ?
    `).bind(buyin.player_id).first();

    await db.prepare(`
      UPDATE players
      SET status = 'active',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(buyin.player_id).run();

    await db.prepare(`
      UPDATE buyins
      SET status = 'approved',
          reviewed_at = CURRENT_TIMESTAMP,
          reviewed_by = ?
      WHERE id = ?
    `).bind(approvedBy, buyinId).run();

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
      VALUES (?, ?, 'buyin_approved', ?, ?, 'buyin', ?, CURRENT_TIMESTAMP)
    `).bind(
      transactionId,
      buyin.player_id,
      buyin.amount,
      wallet ? wallet.chips : buyin.amount,
      `Buy-in approved by ${approvedBy}.`
    ).run();

    return json({
      ok: true,
      message: "Buy-in approved.",
      buyinId,
      playerId: buyin.player_id,
      amountApproved: buyin.amount,
      balanceAfter: wallet ? wallet.chips : buyin.amount
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Approve buy-in failed."
    }, 500);
  }
}