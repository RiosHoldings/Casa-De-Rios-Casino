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

    if (!db) {
      return json({ ok: false, error: "D1 database binding DB is missing." }, 500);
    }

    const admin = checkAdmin(context);
    if (!admin.ok) return admin.response;

    const body = await context.request.json();

    const ticketId = String(body.ticketId || "").trim();
    const deniedBy = String(body.deniedBy || "Casa de Ríos Admin").trim();

    if (!ticketId) {
      return json({ ok: false, error: "Missing ticket ID." }, 400);
    }

    const ticket = await db.prepare(`
      SELECT id, player_id, amount, status
      FROM payout_tickets
      WHERE id = ?
    `).bind(ticketId).first();

    if (!ticket) {
      return json({ ok: false, error: "Ticket not found." }, 404);
    }

    if (ticket.status !== "pending") {
      return json({ ok: false, error: "Ticket is not pending." }, 400);
    }

    await db.prepare(`
      UPDATE payout_tickets
      SET status = 'denied',
          fulfilled_at = CURRENT_TIMESTAMP,
          fulfilled_by = ?
      WHERE id = ?
    `).bind(deniedBy, ticketId).run();

    await db.prepare(`
      UPDATE wallets
      SET locked = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE player_id = ?
    `).bind(ticket.player_id).run();

    await db.prepare(`
      UPDATE players
      SET status = 'active',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(ticket.player_id).run();

    const wallet = await db.prepare(`
      SELECT chips
      FROM wallets
      WHERE player_id = ?
    `).bind(ticket.player_id).first();

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
      VALUES (?, ?, 'cashout_denied', 0, ?, 'cashout', ?, CURRENT_TIMESTAMP)
    `).bind(
      transactionId,
      ticket.player_id,
      wallet ? wallet.chips : 0,
      "Payout denied by admin. Wallet unlocked."
    ).run();

    return json({
      ok: true,
      message: "Payout denied and wallet unlocked.",
      ticketId,
      playerId: ticket.player_id
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Deny payout failed."
    }, 500);
  }
}