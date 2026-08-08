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

    const buyinId = Number(body.buyinId || body.id || 0);
    const deniedBy = String(body.deniedBy || "Casa de Ríos Admin").trim();
    const denyNotes = String(body.notes || "Buy-in denied by admin.").trim();

    if (!Number.isFinite(buyinId) || buyinId <= 0) {
      return json({ ok: false, error: "Valid buy-in ID is required." }, 400);
    }

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
      LEFT JOIN players ON players.id = buyins.player_id
      WHERE buyins.id = ?
    `).bind(buyinId).first();

    if (!buyin) {
      return json({ ok: false, error: "Buy-in request not found." }, 404);
    }

    if (buyin.status !== "pending") {
      return json({
        ok: false,
        error: `Buy-in is already ${buyin.status}.`
      }, 400);
    }

    const wallet = await db.prepare(`
      SELECT chips
      FROM wallets
      WHERE player_id = ?
    `).bind(buyin.player_id).first();

    const balanceBefore = Number(wallet ? wallet.chips : 0);

    await db.prepare(`
      UPDATE buyins
      SET status = 'denied',
          reviewed_at = CURRENT_TIMESTAMP,
          reviewed_by = ?
      WHERE id = ?
    `).bind(deniedBy, buyinId).run();

    await db.prepare(`
      UPDATE players
      SET status = 'active',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(buyin.player_id).run();

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
      VALUES (?, ?, 'buyin_denied', 0, ?, 'buyin', ?, CURRENT_TIMESTAMP)
    `).bind(
      transactionId,
      buyin.player_id,
      balanceBefore,
      `Buy-in denied by ${deniedBy}. ${denyNotes}`
    ).run();

    await sendAuditEvent(context.env, {
      event_type: "BUYIN_DENIED",
      ticket_id: `BI-${buyinId}`,
      player_id: buyin.player_id,
      discord: buyin.discord_name || buyin.player_discord_name || "",
      rp_name: buyin.character_name || buyin.player_character_name || "",
      amount: buyin.amount,
      status: "Denied",
      balance_before: balanceBefore,
      balance_after: balanceBefore,
      source: "functions/api/admin-deny-buyin.js",
      notes: `Buy-in denied by ${deniedBy}. ${denyNotes}`
    });

    return json({
      ok: true,
      message: "Buy-in denied.",
      buyinId,
      playerId: buyin.player_id,
      amount: buyin.amount,
      status: "denied",
      balanceBefore,
      balanceAfter: balanceBefore,
      transactionId
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Failed to deny buy-in."
    }, 500);
  }
}