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

    const tickets = await db.prepare(`
      SELECT
        payout_tickets.id,
        payout_tickets.player_id,
        payout_tickets.amount,
        payout_tickets.status,
        payout_tickets.note,
        payout_tickets.created_at,
        payout_tickets.fulfilled_at,
        payout_tickets.fulfilled_by,
        players.character_name,
        players.discord_name,
        wallets.chips,
        wallets.locked
      FROM payout_tickets
      LEFT JOIN players ON players.id = payout_tickets.player_id
      LEFT JOIN wallets ON wallets.player_id = payout_tickets.player_id
      ORDER BY payout_tickets.created_at DESC
      LIMIT 50
    `).all();

    return json({
      ok: true,
      tickets: tickets.results || []
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Admin payout list failed."
    }, 500);
  }
}