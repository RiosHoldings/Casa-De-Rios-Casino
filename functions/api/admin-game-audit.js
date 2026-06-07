export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);

    const adminKey =
      request.headers.get("x-admin-key") ||
      url.searchParams.get("adminKey") ||
      url.searchParams.get("key") ||
      "";

    if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
      return json({ ok: false, error: "Unauthorized." }, 401);
    }

    const blackjack = await env.DB.prepare(`
      SELECT 
        bh.id,
        bh.player_id,
        p.character_name,
        p.discord_name,
        bh.bet_amount,
        bh.player_hand,
        bh.dealer_hand,
        bh.status,
        bh.result,
        bh.payout,
        bh.created_at
      FROM blackjack_hands bh
      LEFT JOIN players p ON p.id = bh.player_id
      ORDER BY bh.created_at DESC
      LIMIT 50
    `).all();

    const roulette = await env.DB.prepare(`
      SELECT 
        rr.id,
        rr.player_id,
        p.character_name,
        p.discord_name,
        rr.bet_type,
        rr.bet_value,
        rr.bet_amount,
        rr.result_number,
        rr.result_color,
        rr.payout,
        rr.status,
        rr.created_at
      FROM roulette_rounds rr
      LEFT JOIN players p ON p.id = rr.player_id
      ORDER BY rr.created_at DESC
      LIMIT 50
    `).all();

    const slots = await env.DB.prepare(`
      SELECT
        sr.id,
        sr.player_id,
        p.character_name,
        p.discord_name,
        sr.bet_amount,
        sr.reels,
        sr.result,
        sr.payout,
        sr.status,
        sr.created_at
      FROM slots_rounds sr
      LEFT JOIN players p ON p.id = sr.player_id
      ORDER BY sr.created_at DESC
      LIMIT 50
    `).all();

    return json({
      ok: true,
      blackjack: blackjack.results || [],
      roulette: roulette.results || [],
      slots: slots.results || []
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Game audit failed."
    }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}