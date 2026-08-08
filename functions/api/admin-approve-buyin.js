function json(data, status = 200) {
  return Response.json(data, { status });
}

function checkAdmin(context) {
  const expectedKey = context.env.ADMIN_KEY;
  const givenKey = context.request.headers.get("x-admin-key");

  if (!expectedKey) {
    return {
      ok: false,
      response: json({ ok: false, error: "ADMIN_KEY secret is missing." }, 500)
    };
  }

  if (!givenKey || givenKey !== expectedKey) {
    return {
      ok: false,
      response: json({ ok: false, error: "Unauthorized admin request." }, 401)
    };
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

    const buyinId = Number(body.buyinId || 0);
    const approvedBy = String(body.approvedBy || "Casa de Ríos Admin").trim();

    if (!Number.isFinite(buyinId) || buyinId <= 0) {
      return json({ ok: false, error: "Missing buy-in request ID." }, 400);
    }

    const buyin = await db.prepare(`
      SELECT
        buyins.id,
        buyins.player_id,
        buyins.amount,
        buyins.status,
        buyins.notes,
        buyins.character_name,
        buyins.discord_name,
        players.character_name AS player_character_name,
        players.discord_name AS player_discord_name
      FROM buyins
      LEFT JOIN players ON players.id = buyins.player_id
      WHERE buyins.id = ?
    `).bind(buyinId).first();

    if (!buyin) {
      return json({ ok: false, error: "Buy-in request not found." }, 404);
    }

    if (buyin.status !== "pending") {
      return json({ ok: false, error: "Buy-in request is not pending." }, 400);
    }

    let walletBefore = await db.prepare(`
      SELECT chips
      FROM wallets
      WHERE player_id = ?
    `).bind(buyin.player_id).first();

    if (!walletBefore) {
      await db.prepare(`
        INSERT INTO wallets (
          player_id,
          chips,
          locked,
          created_at,
          updated_at
        )
        VALUES (?, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(buyin.player_id).run();

      walletBefore = { chips: 0 };
    }

    const balanceBefore = Number(walletBefore.chips || 0);

    await db.prepare(`
      UPDATE wallets
      SET chips = chips + ?,
          locked = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE player_id = ?
    `).bind(buyin.amount, buyin.player_id).run();

    const walletAfter = await db.prepare(`
      SELECT chips
      FROM wallets
      WHERE player_id = ?
    `).bind(buyin.player_id).first();

    const balanceAfter = Number(walletAfter ? walletAfter.chips : balanceBefore + Number(buyin.amount || 0));

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
      balanceAfter,
      `Buy-in approved by ${approvedBy}.`
    ).run();

    await sendAuditEvent(context.env, {
      event_type: "BUYIN_APPROVED",
      ticket_id: `BI-${buyinId}`,
      player_id: buyin.player_id,
      discord: buyin.discord_name || buyin.player_discord_name || "",
      rp_name: buyin.character_name || buyin.player_character_name || "",
      amount: buyin.amount,
      status: "Approved",
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      source: "functions/api/admin-approve-buyin.js",
      notes: `Buy-in approved by ${approvedBy}.`
    });

    return json({
      ok: true,
      message: "Buy-in approved.",
      buyinId,
      playerId: buyin.player_id,
      amountApproved: buyin.amount,
      balanceBefore,
      balanceAfter,
      transactionId
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Approve buy-in failed."
    }, 500);
  }
}