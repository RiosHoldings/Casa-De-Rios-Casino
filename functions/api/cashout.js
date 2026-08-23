function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function makeTicketId() {
  return `CO-${Date.now()}-${crypto.randomUUID()
    .slice(0, 8)
    .toUpperCase()}`;
}

async function sendAuditEvent(env, payload) {
  if (!env.CASA_AUDIT_WEBHOOK_URL || !env.CASA_AUDIT_SECRET) {
    console.log(
      "Audit sync skipped: missing CASA_AUDIT_WEBHOOK_URL or CASA_AUDIT_SECRET"
    );
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
  } catch (error) {
    console.log("Audit sync error:", error.message);
  }
}

async function sendCashoutWebhook(env, data) {
  if (!env.CASHOUT_WEBHOOK_URL) {
    console.log(
      "Cashout Discord webhook skipped: CASHOUT_WEBHOOK_URL missing."
    );
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

    console.log(
      "Cashout Discord webhook response:",
      res.status
    );
  } catch (error) {
    console.log(
      "Cashout Discord webhook failed:",
      error.message
    );
  }
}

export async function onRequestPost(context) {
  const db = context.env.DB;

  if (!db) {
    return json(
      {
        ok: false,
        error: "D1 database binding DB is missing."
      },
      500
    );
  }

  try {
    let body;

    try {
      body = await context.request.json();
    } catch {
      return json(
        {
          ok: false,
          error: "Invalid JSON body."
        },
        400
      );
    }

    const playerId =
      String(body.playerId || "").trim();

    const playerSecret =
      String(body.playerSecret || "").trim();

    const note =
      String(
        body.note || "Cash-out requested by player"
      ).trim();

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json(
        {
          ok: false,
          error: "Invalid Player ID."
        },
        400
      );
    }

    if (!playerSecret) {
      return json(
        {
          ok: false,
          error: "Missing player secret."
        },
        400
      );
    }

    /* ============================================================
       PLAYER + WALLET AUTHENTICATION
       IMPORTANT: current schema uses player_secret
       ============================================================ */

    const account = await db.prepare(`
      SELECT
        p.id,
        p.player_secret,
        p.character_name,
        p.discord_name,
        p.status,
        p.vip_tier,
        w.chips,
        w.locked
      FROM players p
      JOIN wallets w
        ON w.player_id = p.id
      WHERE p.id = ?
        AND p.player_secret = ?
      LIMIT 1
    `)
      .bind(playerId, playerSecret)
      .first();

    if (!account) {
      return json(
        {
          ok: false,
          error: "Player authentication failed."
        },
        401
      );
    }

    const locked =
      Number(account.locked || 0) === 1;

    const amount =
      Math.floor(Number(account.chips || 0));

    if (
      locked ||
      String(account.status) === "cashout_pending"
    ) {
      return json(
        {
          ok: false,
          error:
            "Cash-out request is already pending. Wallet is locked."
        },
        409
      );
    }

    if (String(account.status || "") !== "active") {
      return json(
        {
          ok: false,
          error:
            `Player account is ${account.status || "not active"}.`
        },
        409
      );
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return json(
        {
          ok: false,
          error: "No chips available to cash out."
        },
        400
      );
    }

    /* ============================================================
       EXISTING TICKET CHECK
       ============================================================ */

    const existingPending = await db.prepare(`
      SELECT
        id,
        amount,
        created_at
      FROM payout_tickets
      WHERE player_id = ?
        AND status = 'pending'
      LIMIT 1
    `)
      .bind(playerId)
      .first();

    if (existingPending) {
      return json(
        {
          ok: false,
          error:
            "You already have a pending cash-out ticket.",
          ticketId: existingPending.id
        },
        409
      );
    }

    const ticketId = makeTicketId();

    /* ============================================================
       PREPARE DATABASE CHANGES
       ============================================================ */

    const createTicket = db.prepare(`
      INSERT INTO payout_tickets (
        id,
        player_id,
        amount,
        status,
        note,
        created_at
      )
      VALUES (
        ?,
        ?,
        ?,
        'pending',
        ?,
        CURRENT_TIMESTAMP
      )
    `).bind(
      ticketId,
      playerId,
      amount,
      note
    );

    const lockWallet = db.prepare(`
      UPDATE wallets
      SET
        locked = 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE player_id = ?
        AND COALESCE(locked, 0) = 0
    `).bind(playerId);

    const updatePlayer = db.prepare(`
      UPDATE players
      SET
        status = 'cashout_pending',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(playerId);

    /*
      Match the current casino transaction format.

      The request itself does not remove the chips yet.
      It locks the existing balance until the house
      approves or denies the payout.
    */

    const ledgerEntry = db.prepare(`
      INSERT INTO transactions (
        player_id,
        type,
        game,
        amount,
        balance_after,
        note,
        created_at
      )
      VALUES (
        ?,
        'cashout_request',
        'cashout',
        0,
        ?,
        ?,
        CURRENT_TIMESTAMP
      )
    `).bind(
      playerId,
      amount,
      `Cash-out requested. Ticket ${ticketId}. Wallet locked. ${note}`
    );

    /* ============================================================
       RUN TOGETHER
       ============================================================ */

    await db.batch([
      createTicket,
      lockWallet,
      updatePlayer,
      ledgerEntry
    ]);

    /* ============================================================
       VERIFY
       ============================================================ */

    const ticket = await db.prepare(`
      SELECT
        id,
        player_id,
        amount,
        status,
        note,
        created_at
      FROM payout_tickets
      WHERE id = ?
      LIMIT 1
    `)
      .bind(ticketId)
      .first();

    if (!ticket) {
      return json(
        {
          ok: false,
          error:
            "Cash-out could not be verified after creation."
        },
        500
      );
    }

    /* ============================================================
       DISCORD + SHEETS/AUDIT
       ============================================================ */

    await sendCashoutWebhook(context.env, {
      ticketId,
      playerId,
      characterName: account.character_name,
      discordName: account.discord_name,
      amount,
      note
    });

    await sendAuditEvent(context.env, {
      event_type: "CASHOUT_REQUESTED",
      ticket_id: ticketId,
      player_id: playerId,
      discord: account.discord_name || "",
      rp_name: account.character_name || "",
      amount,
      status: "Pending",
      balance_before: amount,
      balance_after: amount,
      source: "functions/api/cashout.js",
      notes:
        `Cash-out requested by player. ` +
        `Wallet locked. ${note}`
    });

    return json({
      ok: true,
      message: "Cash-out ticket created.",
      ticketId,
      playerId,
      amount,
      status: "pending",
      walletLocked: true
    });

  } catch (error) {
    console.error("CASHOUT ERROR:", error);

    return json(
      {
        ok: false,
        error:
          error?.message ||
          String(error) ||
          "Cash-out request failed."
      },
      500
    );
  }
}