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

async function sendAuditEvent(env, payload) {
  if (!env.CASA_AUDIT_WEBHOOK_URL || !env.CASA_AUDIT_SECRET) {
    console.log("Audit sync skipped: missing CASA_AUDIT_WEBHOOK_URL or CASA_AUDIT_SECRET");
    return;
  }

  try {
    const res = await fetch(env.CASA_AUDIT_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...payload,
        secret: env.CASA_AUDIT_SECRET
      })
    });

    console.log("Audit sync response:", res.status);
  } catch (err) {
    console.log("Audit sync error:", err.message);
  }
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
    const fulfilledBy = String(body.fulfilledBy || "Casa de Ríos Admin").trim();

    if (!ticketId) {
      return json({ ok: false, error: "Missing ticket ID." }, 400);
    }

    const ticket = await db.prepare(`
      SELECT
        payout_tickets.id,
        payout_tickets.player_id,
        payout_tickets.amount,
        payout_tickets.status,
        payout_tickets.note,
        players.character_name,
        players.discord_name
      FROM payout_tickets
      LEFT JOIN players ON players.id = payout_tickets.player_id
      WHERE payout_tickets.id = ?
    `).bind(ticketId).first();

    if (!ticket) {
      return json({ ok: false, error: "Ticket not found." }, 404);
    }

    if (ticket.status !== "pending") {
      return json({ ok: false, error: "Ticket is not pending." }, 400);
    }

    const wallet = await db.prepare(`
      SELECT chips, locked
      FROM wallets
      WHERE player_id = ?
    `).bind(ticket.player_id).first();

    if (!wallet) {
      return json({ ok: false, error: "Wallet not found." }, 404);
    }

    const balanceBefore = Number(wallet.chips || 0);

    await db.prepare(`
      UPDATE payout_tickets
      SET status = 'paid',
          fulfilled_at = CURRENT_TIMESTAMP,
          fulfilled_by = ?
      WHERE id = ?
    `).bind(fulfilledBy, ticketId).run();

    await db.prepare(`
      UPDATE wallets
      SET chips = 0,
          locked = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE player_id = ?
    `).bind(ticket.player_id).run();

    await db.prepare(`
      UPDATE players
      SET status = 'paid_out',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(ticket.player_id).run();

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
      VALUES (?, ?, 'cashout_paid', ?, 0, 'cashout', ?, CURRENT_TIMESTAMP)
    `).bind(
      transactionId,
      ticket.player_id,
      -Math.abs(Number(ticket.amount || 0)),
      "Payout marked paid by admin. Wallet reset to 0 and unlocked."
    ).run();

    await sendAuditEvent(context.env, {
      event_type: "CASHOUT_PAID",
      ticket_id: ticketId,
      player_id: ticket.player_id,
      discord: ticket.discord_name || "",
      rp_name: ticket.character_name || "",
      amount: ticket.amount,
      status: "Paid",
      balance_before: balanceBefore,
      balance_after: 0,
      source: "functions/api/admin-complete-payout.js",
      notes: `Cashout paid by ${fulfilledBy}. Wallet reset to 0.`
    });

    return json({
      ok: true,
      message: "Payout marked paid.",
      ticketId,
      playerId: ticket.player_id,
      amountPaid: ticket.amount,
      balanceAfter: 0,
      walletLocked: false
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Complete payout failed."
    }, 500);
  }
}