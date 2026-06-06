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

    const playerId = String(body.playerId || "").trim();
    const action = String(body.action || "").trim();
    const adminName = String(body.adminName || "Casa de Ríos Admin").trim();

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json({ ok: false, error: "Invalid Player ID." }, 400);
    }

    const player = await db.prepare(`
      SELECT id
      FROM players
      WHERE id = ?
    `).bind(playerId).first();

    if (!player) {
      return json({ ok: false, error: "Player not found." }, 404);
    }

    let note = "";
    let transactionAmount = 0;

    if (action === "set_balance") {
      const newBalance = Math.floor(Number(body.newBalance || 0));

      if (!Number.isFinite(newBalance) || newBalance < 0) {
        return json({ ok: false, error: "Balance must be 0 or higher." }, 400);
      }

      await db.prepare(`
        UPDATE wallets
        SET chips = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE player_id = ?
      `).bind(newBalance, playerId).run();

      note = `Admin set wallet balance to ${newBalance}. By ${adminName}.`;
      transactionAmount = 0;
    }

    else if (action === "lock_wallet") {
      await db.prepare(`
        UPDATE wallets
        SET locked = 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE player_id = ?
      `).bind(playerId).run();

      await db.prepare(`
        UPDATE players
        SET status = 'locked',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(playerId).run();

      note = `Admin locked wallet. By ${adminName}.`;
    }

    else if (action === "unlock_wallet") {
      await db.prepare(`
        UPDATE wallets
        SET locked = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE player_id = ?
      `).bind(playerId).run();

      await db.prepare(`
        UPDATE players
        SET status = 'active',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(playerId).run();

      note = `Admin unlocked wallet. By ${adminName}.`;
    }

    else if (action === "set_status") {
      const status = String(body.status || "").trim();

      const allowedStatuses = [
        "waiting_buyin",
        "active",
        "cashout_pending",
        "paid_out",
        "locked",
        "banned"
      ];

      if (!allowedStatuses.includes(status)) {
        return json({ ok: false, error: "Invalid status." }, 400);
      }

      await db.prepare(`
        UPDATE players
        SET status = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(status, playerId).run();

      note = `Admin changed player status to ${status}. By ${adminName}.`;
    }

    else if (action === "set_vip") {
      const vipTier = String(body.vipTier || "none").trim();

      const allowedTiers = [
        "none",
        "bronze",
        "silver",
        "gold",
        "platinum",
        "lealtad"
      ];

      if (!allowedTiers.includes(vipTier)) {
        return json({ ok: false, error: "Invalid VIP tier." }, 400);
      }

      await db.prepare(`
        UPDATE players
        SET vip_tier = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(vipTier, playerId).run();

      note = `Admin changed VIP tier to ${vipTier}. By ${adminName}.`;
    }

    else {
      return json({ ok: false, error: "Invalid admin action." }, 400);
    }

    const wallet = await db.prepare(`
      SELECT chips, locked
      FROM wallets
      WHERE player_id = ?
    `).bind(playerId).first();

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
      VALUES (?, ?, 'admin_player_update', ?, ?, 'admin', ?, CURRENT_TIMESTAMP)
    `).bind(
      transactionId,
      playerId,
      transactionAmount,
      wallet ? wallet.chips : 0,
      note
    ).run();

    const updatedPlayer = await db.prepare(`
      SELECT
        players.id,
        players.character_name,
        players.discord_name,
        players.status,
        players.vip_tier,
        wallets.chips,
        wallets.locked
      FROM players
      LEFT JOIN wallets ON wallets.player_id = players.id
      WHERE players.id = ?
    `).bind(playerId).first();

    return json({
      ok: true,
      message: "Player updated.",
      player: updatedPlayer
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Admin player update failed."
    }, 500);
  }
}