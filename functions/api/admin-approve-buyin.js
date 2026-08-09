function json(data, status = 200) {
  return Response.json(data, { status });
}

function checkAdmin(context) {
  const expectedKey = context.env.ADMIN_KEY;
  const givenKey = context.request.headers.get("x-admin-key");

  if (!expectedKey) {
    return {
      ok: false,
      response: json(
        {
          ok: false,
          error: "ADMIN_KEY secret is missing."
        },
        500
      )
    };
  }

  if (!givenKey || givenKey !== expectedKey) {
    return {
      ok: false,
      response: json(
        {
          ok: false,
          error: "Unauthorized admin request."
        },
        401
      )
    };
  }

  return { ok: true };
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
  } catch (err) {
    console.log("Audit sync error:", err.message);
  }
}

export async function onRequestPost(context) {
  try {
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

    const admin = checkAdmin(context);

    if (!admin.ok) {
      return admin.response;
    }

    const body = await context.request.json();

    const buyinId = Number(body.buyinId || body.id || 0);

    const approvedBy = String(
      body.approvedBy ||
      body.adminName ||
      "Casa de Ríos Admin"
    ).trim();

    if (!Number.isFinite(buyinId) || buyinId <= 0) {
      return json(
        {
          ok: false,
          error: "Valid buy-in ID is required."
        },
        400
      );
    }

    /* ======================================================
       LOAD BUY-IN REQUEST
    ====================================================== */

    const buyin = await db.prepare(`
      SELECT
        buyins.id,
        buyins.player_id,
        buyins.character_name,
        buyins.discord_name,
        buyins.amount,
        buyins.notes,
        buyins.status,

        players.character_name AS player_character_name,
        players.discord_name AS player_discord_name

      FROM buyins

      LEFT JOIN players
        ON players.id = buyins.player_id

      WHERE buyins.id = ?
    `)
    .bind(buyinId)
    .first();

    if (!buyin) {
      return json(
        {
          ok: false,
          error: "Buy-in request not found."
        },
        404
      );
    }

    if (buyin.status !== "pending") {
      return json(
        {
          ok: false,
          error: `Buy-in is already ${buyin.status}.`
        },
        400
      );
    }

    const amount = Math.floor(Number(buyin.amount || 0));

    if (!Number.isFinite(amount) || amount <= 0) {
      return json(
        {
          ok: false,
          error: "Buy-in amount is invalid."
        },
        400
      );
    }

    /* ======================================================
       ENSURE WALLET EXISTS
    ====================================================== */

    let wallet = await db.prepare(`
      SELECT
        player_id,
        chips,
        locked

      FROM wallets

      WHERE player_id = ?
    `)
    .bind(buyin.player_id)
    .first();

    if (!wallet) {
      await db.prepare(`
        INSERT INTO wallets (
          player_id,
          chips,
          locked,
          created_at,
          updated_at
        )
        VALUES (
          ?,
          0,
          0,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
      `)
      .bind(buyin.player_id)
      .run();

      wallet = {
        player_id: buyin.player_id,
        chips: 0,
        locked: 0
      };
    }

    const balanceBefore = Number(wallet.chips || 0);

    /* ======================================================
       ADD CHIPS
    ====================================================== */

    await db.prepare(`
      UPDATE wallets

      SET
        chips = chips + ?,
        locked = 0,
        updated_at = CURRENT_TIMESTAMP

      WHERE player_id = ?
    `)
    .bind(
      amount,
      buyin.player_id
    )
    .run();

    /* ======================================================
       APPROVE BUY-IN
    ====================================================== */

    await db.prepare(`
      UPDATE buyins

      SET
        status = 'approved',
        reviewed_at = CURRENT_TIMESTAMP,
        reviewed_by = ?

      WHERE id = ?
    `)
    .bind(
      approvedBy,
      buyinId
    )
    .run();

    /* ======================================================
       ACTIVATE PLAYER
    ====================================================== */

    await db.prepare(`
      UPDATE players

      SET
        status = 'active',
        updated_at = CURRENT_TIMESTAMP

      WHERE id = ?
    `)
    .bind(buyin.player_id)
    .run();

    /* ======================================================
       GET NEW BALANCE
    ====================================================== */

    const walletAfter = await db.prepare(`
      SELECT chips, locked

      FROM wallets

      WHERE player_id = ?
    `)
    .bind(buyin.player_id)
    .first();

    const balanceAfter = Number(
      walletAfter
        ? walletAfter.chips
        : balanceBefore + amount
    );

    /* ======================================================
       LEDGER TRANSACTION
    ====================================================== */

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

      VALUES (
        ?,
        ?,
        'admin_add_chips',
        ?,
        ?,
        'buyin',
        ?,
        CURRENT_TIMESTAMP
      )
    `)
    .bind(
      transactionId,
      buyin.player_id,
      amount,
      balanceAfter,
      `Buy-in #${buyinId} approved by ${approvedBy}.`
    )
    .run();

    /* ======================================================
       AUDIT WEBHOOK
    ====================================================== */

    await sendAuditEvent(context.env, {
      event_type: "BUYIN_APPROVED",

      ticket_id: `BI-${buyinId}`,

      player_id: buyin.player_id,

      discord:
        buyin.discord_name ||
        buyin.player_discord_name ||
        "",

      rp_name:
        buyin.character_name ||
        buyin.player_character_name ||
        "",

      amount,

      status: "Approved",

      balance_before: balanceBefore,

      balance_after: balanceAfter,

      source:
        "functions/api/admin-approve-buyin.js",

      notes:
        `Buy-in approved by ${approvedBy}.`
    });

    /* ======================================================
       RESPONSE
    ====================================================== */

    return json({
      ok: true,

      message: "Buy-in approved.",

      buyinId,

      playerId: buyin.player_id,

      amountAdded: amount,

      balanceBefore,

      balanceAfter,

      status: "approved",

      transactionId
    });

  } catch (error) {
    return json(
      {
        ok: false,
        error:
          error.message ||
          "Failed to approve buy-in."
      },
      500
    );
  }
}
