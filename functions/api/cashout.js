function json(data, status = 200) {
  return Response.json(data, { status });
}

function makeTicketId() {
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `CO-${Date.now()}-${random}`;
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

async function sendCashoutWebhook(env, data) {
  if (!env.CASHOUT_WEBHOOK_URL) {
    console.log("Cashout Discord webhook skipped: CASHOUT_WEBHOOK_URL missing.");
    return;
  }

  const amount = Number(data.amount || 0).toLocaleString();

  const embed = {
    title: "Casa de Ríos Cash-Out Request",
    color: 0xd4a64a,
    fields: [
      {
        name: "Ticket ID",
        value: String(data.ticketId || "Unknown"),
        inline: false
      },
      {
        name: "Player ID",
        value: String(data.playerId || "Unknown"),
        inline: false
      },
      {
        name: "Character",
        value: String(data.characterName || "Unknown"),
        inline: true
      },
      {
        name: "Discord",
        value: String(data.discordName || "Unknown"),
        inline: true
      },
      {
        name: "Amount",
        value: `${amount} chips`,
        inline: true
      },
      {
        name: "Notes",
        value: String(data.note || "No notes."),
        inline: false
      }
    ],
    footer: {
      text: "Suerte. Honor. Lealtad."
    },
    timestamp: new Date().toISOString()
  };

  try {
    const res = await fetch(env.CASHOUT_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        embeds: [embed]
      })
    });

    console.log("Cashout Discord webhook response:", res.status);
  } catch (err) {
    console.log("Cashout Discord webhook failed:", err.message);
  }
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
    const note = String(body.note || "Cash-out requested by player").trim();

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json({ ok: false, error: "Invalid Player ID." }, 400);
    }

    if (!playerSecret) {
      return json({ ok: false, error: "Missing player secret." }, 400);
    }

    const player = await db.prepare(`
      SELECT
        id,
        secret,
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

    if (player.secret !== playerSecret) {
      return json({ ok: false, error: "Player secret does not match this Player ID." }, 401);
    }

    const wallet = await db.prepare(`
      SELECT
        player_id,
        chips,
        locked
      FROM wallets
      WHERE player_id = ?
    `).bind(playerId).first();

    if (!wallet) {
      return json({ ok: false, error: "Wallet not found." }, 404);
    }

    const locked = Number(wallet.locked || 0) === 1;
    const amount = Math.floor(Number(wallet.chips || 0));

    if (locked || player.status === "cashout_pending") {
      return json({
        ok: false,
        error: "Cash-out request is already pending. Wallet is locked."
      }, 400);
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return json({
        ok: false,
        error: "No chips available to cash out."
      }, 400);
    }

    const existingPending = await db.prepare(`
      SELECT id
      FROM payout_tickets
      WHERE player_id = ?
        AND status = 'pending'
      LIMIT 1
    `).bind(playerId).first();

    if (existingPending) {
      return json({
        ok: false,
        error: "You already have a pending cash-out ticket.",
        ticketId: existingPending.id
      }, 400);
    }

    const ticketId = makeTicketId();

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
    `).bind(
      ticketId,
      playerId,
      amount,
      note
    ).run();

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
      VALUES (?, ?, 'cashout_request', 0, ?, 'cashout', ?, CURRENT_TIMESTAMP)
    `).bind(
      transactionId,
      playerId,
      amount,
      `Cash-out requested. Ticket ${ticketId}. Wallet locked. ${note}`
    ).run();

    await sendCashoutWebhook(context.env, {
      ticketId,
      playerId,
      characterName: player.character_name,
      discordName: player.discord_name,
      amount,
      note
    });

    await sendAuditEvent(context.env, {
      event_type: "CASHOUT_REQUESTED",
      ticket_id: ticketId,
      player_id: playerId,
      discord: player.discord_name || "",
      rp_name: player.character_name || "",
      amount,
      status: "Pending",
      balance_before: amount,
      balance_after: amount,
      source: "functions/api/cashout.js",
      notes: `Cash-out requested by player. Wallet locked. ${note}`
    });

    return json({
      ok: true,
      message: "Cash-out ticket created.",
      ticketId,
      playerId,
      amount,
      status: "pending",
      walletLocked: true,
      transactionId
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Cash-out request failed."
    }, 500);
  }
}