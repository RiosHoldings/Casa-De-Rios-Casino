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

    const playerId = String(body.playerId || "").trim();
    const amount = Math.floor(Number(body.amount || 0));
    const note = String(body.note || "Admin chip add").trim();
    const adminName = String(body.adminName || "Casa de Ríos Admin").trim();

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json({ ok: false, error: "Invalid Player ID." }, 400);
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ ok: false, error: "Amount must be a positive number." }, 400);
    }

    const player = await db.prepare(`
      SELECT
        id,
        character_name,
        discord_name,
        status
      FROM players
      WHERE id = ?
    `).bind(playerId).first();

    if (!player) {
      return json({
        ok: false,
        error: "Player not found. They must create a Player ID first."
      }, 404);
    }

    let walletBefore = await db.prepare(`
      SELECT chips, locked
      FROM wallets
      WHERE player_id = ?
    `).bind(playerId).first();

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
      `).bind(playerId).run();

      walletBefore = {
        chips: 0,
        locked: 0
      };
    }

    const balanceBefore = Number(walletBefore.chips || 0);

    await db.prepare(`
      UPDATE wallets
      SET chips = chips + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE player_id = ?
    `).bind(amount, playerId).run();

    const walletAfter = await db.prepare(`
      SELECT chips, locked
      FROM wallets
      WHERE player_id = ?
    `).bind(playerId).first();

    const balanceAfter = Number(walletAfter ? walletAfter.chips : balanceBefore + amount);

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
      balanceAfter,
      `${note}. By ${adminName}.`
    ).run();

    await sendAuditEvent(context.env, {
      event_type: "ADMIN_ADD_CHIPS",
      ticket_id: transactionId,
      player_id: playerId,
      discord: player.discord_name || "",
      rp_name: player.character_name || "",
      amount,
      status: "Completed",
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      source: "functions/api/admin-add-chips.js",
      notes: `${note}. By ${adminName}.`
    });

    return json({
      ok: true,
      message: "Chips added.",
      playerId,
      amountAdded: amount,
      balanceBefore,
      balanceAfter,
      transactionId
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Admin add chips failed."
    }, 500);
  }
}