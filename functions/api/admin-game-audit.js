export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const adminKey = url.searchParams.get("adminKey") || "";
  const limitRaw = Number(url.searchParams.get("limit") || 25);
  const limit = Math.min(Math.max(limitRaw, 1), 100);

  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
    return Response.json(
      { ok: false, error: "Unauthorized admin key." },
      { status: 401 }
    );
  }

  try {
    const blackjack = await env.DB.prepare(`
      SELECT
        h.id,
        h.player_id,
        p.character_name,
        p.discord_name,
        h.bet_amount,
        h.status,
        h.result,
        h.payout,
        h.player_hand,
        h.dealer_hand,
        h.created_at,
        h.updated_at
      FROM blackjack_hands h
      LEFT JOIN players p ON p.id = h.player_id
      ORDER BY h.created_at DESC
      LIMIT ?
    `).bind(limit).all();

    const roulette = await env.DB.prepare(`
      SELECT
        r.id,
        r.player_id,
        p.character_name,
        p.discord_name,
        r.bet_type,
        r.bet_value,
        r.bet_amount,
        r.result_number,
        r.result_color,
        r.payout,
        r.status,
        r.created_at
      FROM roulette_rounds r
      LEFT JOIN players p ON p.id = r.player_id
      ORDER BY r.created_at DESC
      LIMIT ?
    `).bind(limit).all();

    return Response.json({
      ok: true,
      blackjack: blackjack.results || [],
      roulette: roulette.results || []
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error.message || "Failed to load game audit."
      },
      { status: 500 }
    );
  }
}