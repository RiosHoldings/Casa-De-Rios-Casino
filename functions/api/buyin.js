function json(data, status = 200) {
  return Response.json(data, { status });
}

function makePlayerId() {
  return "CDR-" + crypto.randomUUID().slice(0, 8).toUpperCase();
}

function makeSecret() {
  return crypto.randomUUID() + "-" + crypto.randomUUID();
}

async function sendBuyInWebhook(env, data) {
  try {
    if (!env.BUYIN_WEBHOOK_URL) {
      console.log("BUYIN_WEBHOOK_URL missing");
      return;
    }

    const amount = Number(data.amount || 0).toLocaleString("en-US");

    const payload = {
      username: "Casa de Ríos Cashier Cage",
      embeds: [
        {
          title: "💵 New Buy-In Request",
          color: 0x7b2cff,
          fields: [
            {
              name: "Player ID",
              value: data.playerId || "Not provided",
              inline: false
            },
            {
              name: "Discord",
              value: data.discordName || "Not provided",
              inline: true
            },
            {
              name: "Character Name",
              value: data.characterName || "Not provided",
              inline: true
            },
            {
              name: "Amount",
              value: `${amount} chips`,
              inline: true
            },
            {
              name: "Notes",
              value: data.notes || "None",
              inline: false
            },
            {
              name: "Status",
              value: "Pending approval",
              inline: true
            }
          ],
          footer: {
            text: "Casino Casa de Ríos • Buy-In"
          },
          timestamp: new Date().toISOString()
        }
      ]
    };

    const res = await fetch(env.BUYIN_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      console.log("Buy-in webhook failed:", res.status, await res.text());
    }
  } catch (err) {
    console.log("Buy-in webhook error:", err);
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;

    if (!db) {
      return json({ ok: false, error: "D1 database binding DB is missing." }, 500);
    }

    const body = await context.request.json();

    const existingPlayerId = String(body.playerId || "").trim();
    const existingPlayerSecret = String(body.playerSecret || "").trim();

    const playerId = existingPlayerId || makePlayerId();
    const playerSecret = existingPlayerSecret || makeSecret();

    const characterName = String(body.characterName || "").trim();
    const discordName = String(body.discordName || "").trim();
    const amount = Math.floor(Number(body.amount || 0));
    const notes = String(body.notes || "").trim();

    if (!characterName || !discordName) {
      return json({ ok: false, error: "Character name and Discord name are required." }, 400);
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ ok: false, error: "Enter a valid buy-in amount." }, 400);
    }

    const existingPlayer = await db.prepare(`
      SELECT id, player_secret
      FROM players
      WHERE id = ?
    `).bind(playerId).first();

    if (existingPlayer) {
      if (existingPlayer.player_secret !== playerSecret) {
        return json({ ok: false, error: "Player Secret mismatch." }, 401);
      }

      await db.prepare(`
        UPDATE players
        SET character_name = ?,
            discord_name = ?,
            status = 'waiting_buyin',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(characterName, discordName, playerId).run();
    } else {
      await db.prepare(`
        INSERT INTO players (
          id,
          player_secret,
          character_name,
          discord_name,
          status,
          vip_tier,
          lifetime_wagered,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'waiting_buyin', 'patron', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(
        playerId,
        playerSecret,
        characterName,
        discordName
      ).run();
    }

    await db.prepare(`
      INSERT OR IGNORE INTO wallets (
        player_id,
        chips,
        locked,
        updated_at
      )
      VALUES (?, 0, 0, CURRENT_TIMESTAMP)
    `).bind(playerId).run();

    await db.prepare(`
      INSERT INTO buyins (
        player_id,
        character_name,
        discord_name,
        amount,
        notes,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, 'pending', strftime('%s','now'))
    `).bind(
      playerId,
      characterName,
      discordName,
      amount,
      notes
    ).run();

    await sendBuyInWebhook(context.env, {
      playerId,
      characterName,
      discordName,
      amount,
      notes
    });

    return json({
      ok: true,
      message: "Buy-in request submitted.",
      playerId,
      playerSecret,
      characterName,
      discordName,
      amount,
      status: "pending"
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Buy-in request failed."
    }, 500);
  }
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
    await fetch(formUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: formData.toString()
    });

    console.log("Buy-in audit sent to Google Form");
  } catch (err) {
    console.log("Google Form audit failed:", err.message);
  }
}

