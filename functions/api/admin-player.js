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

    if (!db) {
      return json({ ok: false, error: "D1 database binding DB is missing." }, 500);
    }

    const admin = checkAdmin(context);
    if (!admin.ok) return admin.response;

    const url = new URL(context.request.url);
    const playerId = String(url.searchParams.get("playerId") || "").trim();

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json({ ok: false, error: "Invalid Player ID." }, 400);
    }

    const player = await db.prepare(`
      SELECT
        players.id,
        players.character_name,
        players.discord_name,
        players.status,
        players.vip_tier,
        players.created_at,
        players.updated_at,
        wallets.chips,
        wallets.locked
      FROM players
      LEFT JOIN wallets ON wallets.player_id = players.id
      WHERE players.id = ?
    `).bind(playerId).first();

    if (!player) {
      return json({ ok: false, error: "Player not found." }, 404);
    }

    const transactions = await db.prepare(`
      SELECT
        id,
        type,
        amount,
        balance_after,
        game,
        note,
        created_at
      FROM transactions
      WHERE player_id = ?
      ORDER BY created_at DESC
      LIMIT 25
    `).bind(playerId).all();

    const tickets = await db.prepare(`
      SELECT
        id,
        amount,
        status,
        note,
        created_at,
        fulfilled_at,
        fulfilled_by
      FROM payout_tickets
      WHERE player_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).bind(playerId).all();

    return json({
      ok: true,
      player,
      transactions: transactions.results || [],
      tickets: tickets.results || []
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Admin player lookup failed."
    }, 500);
  }
}