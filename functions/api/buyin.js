export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    const playerId = body.playerId || crypto.randomUUID();
    const characterName = body.characterName || "";
    const discordName = body.discordName || "";
    const amount = Number(body.amount || 0);
    const notes = body.notes || "";

    if (!characterName || !discordName || !amount) {
      return json({
        success: false,
        error: "Character name, Discord name, and amount are required."
      }, 400);
    }

    if (amount <= 0) {
      return json({
        success: false,
        error: "Buy-in amount must be greater than 0."
      }, 400);
    }

    await env.DB.prepare(`
      INSERT INTO buyins
      (player_id, character_name, discord_name, amount, notes, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      playerId,
      characterName,
      discordName,
      amount,
      notes,
      "pending",
      Date.now()
    ).run();

    return json({
      success: true,
      message: "Buy-in request submitted.",
      playerId
    });

  } catch (err) {
    return json({
      success: false,
      error: err.message
    }, 500);
  }
}

export async function onRequestGet(context) {
  const { env } = context;

  try {
    const result = await env.DB.prepare(`
      SELECT *
      FROM buyins
      ORDER BY created_at DESC
    `).all();

    return json({
      success: true,
      buyins: result.results
    });

  } catch (err) {
    return json({
      success: false,
      error: err.message
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