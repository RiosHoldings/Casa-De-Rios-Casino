function json(data, status = 200) {
  return Response.json(data, { status });
}

function checkAdmin(context) {
  const expectedKey = context.env.ADMIN_KEY;
  const givenKey = context.request.headers.get("x-admin-key");

  if (!expectedKey) {
    return {
      ok: false,
      response: json(
        {
          ok: false,
          error: "ADMIN_KEY secret is missing."
        },
        500
      )
    };
  }

  if (!givenKey || givenKey !== expectedKey) {
    return {
      ok: false,
      response: json(
        {
          ok: false,
          error: "Unauthorized admin request."
        },
        401
      )
    };
  }

  return { ok: true };
}

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

    if (!db) {
      return json(
        {
          ok: false,
          error: "D1 database binding DB is missing."
        },
        500
      );
    }

    const admin = checkAdmin(context);

    if (!admin.ok) {
      return admin.response;
    }

    const buyins = await db.prepare(`
      SELECT
        buyins.id,
        buyins.player_id,
        buyins.amount,
        buyins.status,
        buyins.notes,
        buyins.created_at,

        COALESCE(
          buyins.character_name,
          players.character_name
        ) AS character_name,

        COALESCE(
          buyins.discord_name,
          players.discord_name
        ) AS discord_name,

        COALESCE(
          players.vip_tier,
          'patron'
        ) AS vip_tier,

        COALESCE(
          wallets.chips,
          0
        ) AS chips

      FROM buyins

      LEFT JOIN players
        ON players.id = buyins.player_id

      LEFT JOIN wallets
        ON wallets.player_id = buyins.player_id

      ORDER BY buyins.created_at DESC

      LIMIT 50
    `).all();

    return json({
      ok: true,
      buyins: buyins.results || []
    });

  } catch (error) {
    return json(
      {
        ok: false,
        error:
          error.message ||
          "Admin buy-in list failed."
      },
      500
    );
  }
}
