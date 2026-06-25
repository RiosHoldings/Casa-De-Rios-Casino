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

async function logBuyInToGoogleForm(payload) {
  const formUrl =
    "https://docs.google.com/forms/d/e/1FAIpQLSdByVRJLMHDkBmUBQIDTxQ6RWFGyp1agQHZHScuZjnzg3Gj0g/formResponse";

  const formData = new URLSearchParams();

  formData.append("entry.1332387906", payload.event_type || "");
  formData.append("entry.1864789056", payload.ticket_id || "");
  formData.append("entry.573482956", payload.player_id || "");
  formData.append("entry.1264617835", payload.discord || "");
  formData.append("entry.816054358", payload.rp_name || "");
  formData.append("entry.1501721170", String(payload.amount || 0));
  formData.append("entry.1678760499", payload.status || "");
  formData.append("entry.654683935", payload.source || "");
  formData.append("entry.1352898245", payload.notes || "");

  try {
    const res = await fetch(formUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: formData.toString()
    });

    console.log("Buy-in deny audit sent to Google Form:", res.status);
  } catch (err) {
    console.log("Google Form deny audit failed:", err.message);
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
        id,
        player_id,
        character_name,
        discord_name,
        amount,
        notes,
        status
      FROM buyins
      WHERE id = ?
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
      wallet ? wallet.chips : 0,
      `Buy-in denied by ${deniedBy}. ${denyNotes}`
    ).run();

    await logBuyInToGoogleForm({
      event_type: "BUYIN_DENIED",
      ticket_id: `BI-${buyinId}`,
      player_id: buyin.player_id,
      discord: buyin.discord_name,
      rp_name: buyin.character_name,
      amount: buyin.amount,
      status: "Denied",
      source: "functions/api/admin-deny-buyin.js",
      notes: `${denyNotes} Denied by ${deniedBy}.`
    });

    return json({
      ok: true,
      message: "Buy-in denied.",
      buyinId,
      playerId: buyin.player_id,
      amount: buyin.amount,
      status: "denied"
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Failed to deny buy-in."
    }, 500);
  }
}