function json(data, status = 200) {
  return Response.json(data, { status });
}

function makePlayerId() {
  if (crypto.randomUUID) {
    return "CDR-" + crypto.randomUUID().slice(0, 8).toUpperCase();
  }

  return "CDR-" + Date.now().toString(36).toUpperCase();
}

function makeSecret() {
  if (crypto.randomUUID) {
    return crypto.randomUUID() + "-" + crypto.randomUUID();
  }

  return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
}

async function sendBuyInWebhook(env, data) {
  if (!env.BUYIN_WEBHOOK_URL) {
    console.log("Buy-in Discord webhook skipped: BUYIN_WEBHOOK_URL missing.");
    return;
  }

  const amount = Number(data.amount || 0).toLocaleString();

  const embed = {
    title: "Casa de Ríos Buy-In Request",
    color: 0x7b2db4,
    fields: [
      {
        name: "Player ID",
        value: String(data.playerId || "Unknown"),
        inline: false
      },
      {
        name: "Character",
        value: String(data.characterName || "Unknown"),
        inline: true
      },
      {
        name: "Discord",
        value: String(data.discordName || "Unknown"),
        inline: true
      },
      {
        name: "Amount",
        value: `${amount} chips`,
        inline: true
      },
      {
        name: "Notes",
        value: String(data.notes || "No notes."),
        inline: false
      }
    ],
    footer: {
      text: "Suerte. Honor. Lealtad."
    },
    timestamp: new Date().toISOString()
  };

  try {
    const res = await fetch(env.BUYIN_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        embeds: [embed]
      })
    });

    console.log("Buy-in Discord webhook response:", res.status);
  } catch (err) {
    console.log("Buy-in Discord webhook failed:", err.message);
  }
}

async function sendAuditEvent(env, payload) {
  if (!env.CASA_AUDIT_WEBHOOK_URL || !env.CASA_AUDIT_SECRET) {
    console.log("Audit sync skipped: missing CASA_AUDIT_WEBHOOK_URL or CASA_AUDIT_SECRET");
    return;
  }

  try {
    const res = await fetch(env.CASA_AUDIT_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...payload,
        secret: env.CASA_AUDIT_SECRET
      })
    });

    console.log("Audit sync response:", res.status);
  } catch (err) {
    console.log("Audit sync error:", err.message);
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;

    if (!db) {
      return json({ ok: false, error: "D1 database binding DB is missing." }, 500);
    }

    const body = await context.request.json();

    let playerId = String(body.playerId || "").trim();
    let playerSecret = String(body.playerSecret || "").trim();

    const characterName = String(body.characterName || body.character || "").trim();
    const discordName = String(body.discordName || body.discord || "").trim();
    const amount = Math.floor(Number(body.amount || 0));
    const notes = String(body.notes || "").trim();

    if (!characterName || !discordName) {
      return json({
        ok: false,
        error: "Character name and Discord name are required."
      }, 400);
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return json({
        ok: false,
        error: "Enter a valid buy-in amount."
      }, 400);
    }

    if (!playerId || !playerId.startsWith("CDR-")) {
      playerId = makePlayerId();
    }

    if (!playerSecret) {
      playerSecret = makeSecret();
    }

    const existingPlayer = await db.prepare(`
      SELECT id, secret, character_name, discord_name, status
      FROM players
      WHERE id = ?
    `).bind(playerId).first();

    if (existingPlayer) {
      if (existingPlayer.secret && existingPlayer.secret !== playerSecret) {
        return json({
          ok: false,
          error: "Player secret does not match this Player ID."
        }, 401);
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
          secret,
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

    const wallet = await db.prepare(`
      SELECT player_id, chips
      FROM wallets
      WHERE player_id = ?
    `).bind(playerId).first();

    if (!wallet) {
      await db.prepare(`
        INSERT INTO wallets (
          player_id,
          chips,
          locked,
          created_at,
          updated_at
        )
        VALUES (?, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(playerId).run();
    }

    const balanceBefore = wallet ? Number(wallet.chips || 0) : 0;

    const buyinInsert = await db.prepare(`
      INSERT INTO buyins (
        player_id,
        character_name,
        discord_name,
        amount,
        notes,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    `).bind(
      playerId,
      characterName,
      discordName,
      amount,
      notes
    ).run();

    const buyinId =
      buyinInsert?.meta?.last_row_id ||
      buyinInsert?.meta?.lastRowId ||
      Date.now();

    await sendBuyInWebhook(context.env, {
      playerId,
      characterName,
      discordName,
      amount,
      notes,
      buyinId
    });

    await sendAuditEvent(context.env, {
      event_type: "BUYIN_REQUESTED",
      ticket_id: `BI-${buyinId}`,
      player_id: playerId,
      discord: discordName,
      rp_name: characterName,
      amount,
      status: "Pending",
      balance_before: balanceBefore,
      balance_after: balanceBefore,
      source: "functions/api/buyin.js",
      notes: notes
        ? `Buy-in request submitted. Player notes: ${notes}`
        : "Buy-in request submitted."
    });

    return json({
      ok: true,
      message: "Buy-in request submitted.",
      playerId,
      playerSecret,
      buyinId,
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