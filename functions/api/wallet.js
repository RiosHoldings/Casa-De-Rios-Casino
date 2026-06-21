function json(data, status = 200) {
  return Response.json(data, { status });
}

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

    if (!db) {
      return json({ ok: false, error: "D1 database binding DB is missing." }, 500);
    }

    const url = new URL(context.request.url);
    const playerId = String(url.searchParams.get("playerId") || "").trim();
    const playerSecret = String(url.searchParams.get("playerSecret") || "").trim();

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json({ ok: false, error: "Invalid Player ID." }, 400);
    }

    if (!playerSecret || playerSecret.length < 20) {
      return json({ ok: false, error: "Invalid Player Secret." }, 400);
    }

    const player = await db.prepare(`
      SELECT
        players.id,
        players.player_secret,
        players.character_name,
        players.discord_name,
        players.status,
        players.vip_tier,
        players.lifetime_wagered,
        wallets.chips,
        wallets.locked
      FROM players
      LEFT JOIN wallets ON wallets.player_id = players.id
      WHERE players.id = ?
    `).bind(playerId).first();

    if (!player) {
      return json({
        ok: false,
        error: "Player not found. Create Player ID first."
      }, 404);
    }

    if (!player.player_secret || player.player_secret !== playerSecret) {
      return json({
        ok: false,
        error: "Player Secret mismatch. Use the original browser/device."
      }, 401);
    }

    delete player.player_secret;

    return json({
      ok: true,
      player
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Wallet lookup failed."
    }, 500);
  }
}
export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    const url = new URL(context.request.url);
    url.searchParams.set("playerId", body.playerId || "");
    url.searchParams.set("playerSecret", body.playerSecret || "");

    const fakeRequest = new Request(url.toString(), {
      method: "GET",
      headers: context.request.headers
    });

    const response = await onRequestGet({
      ...context,
      request: fakeRequest
    });

    const data = await response.json();

    if (!data.ok) {
      return json(data, response.status);
    }

    const chips = Number(data.player?.chips || 0);

    return json({
      ...data,
      chips,
      balance: chips
    }, response.status);
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Wallet lookup failed."
    }, 500);
  }
}