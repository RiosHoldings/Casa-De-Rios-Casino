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

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    if (!db) return json({ ok: false, error: "D1 database binding DB is missing." }, 500);

    const admin = checkAdmin(context);
    if (!admin.ok) return admin.response;

    const buyins = await db.prepare(`
      SELECT
        buyins.id,
        buyins.player_id,
        buyins.character_name,
        buyins.discord_name,
        buyins.amount,
        buyins.notes,
        buyins.status,
        buyins.created_at,
        buyins.reviewed_at,
        buyins.reviewed_by,
        wallets.chips,
        wallets.locked,
        players.vip_tier
      FROM buyins
      LEFT JOIN wallets ON wallets.player_id = buyins.player_id
      LEFT JOIN players ON players.id = buyins.player_id
      ORDER BY buyins.created_at DESC
      LIMIT 50
    `).all();

    return json({
      ok: true,
      buyins: buyins.results || []
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Admin buy-in list failed."
    }, 500);
  }
}