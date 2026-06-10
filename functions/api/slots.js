export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    const playerId = String(body.playerId || "").trim();
    const playerSecret = String(body.playerSecret || "").trim();
    const betAmount = Math.floor(Number(body.betAmount || 0));

    if (!playerId || !playerSecret) {
      return json({ ok: false, error: "Missing player credentials." }, 400);
    }

    if (!Number.isFinite(betAmount) || betAmount < 100) {
      return json({ ok: false, error: "Minimum bet is 100 chips." }, 400);
    }

    if (betAmount > 50000) {
      return json({ ok: false, error: "Maximum bet is 50,000 chips." }, 400);
    }

    const player = await env.DB.prepare(`
      SELECT 
        p.id,
        p.character_name,
        p.discord_name,
        p.status,
        p.vip_tier,
        p.player_secret,
        w.chips,
        w.locked
      FROM players p
      LEFT JOIN wallets w ON w.player_id = p.id
      WHERE p.id = ?
    `).bind(playerId).first();

    if (!player) {
      return json({ ok: false, error: "Player not found. Create your profile first." }, 404);
    }

    if (!player.player_secret || player.player_secret !== playerSecret) {
      return json({ ok: false, error: "Invalid player secret." }, 403);
    }

    if (Number(player.locked || 0) === 1) {
      return json({ ok: false, error: "Wallet is locked." }, 403);
    }

    const status = String(player.status || "").toLowerCase();

    if (status === "banned" || status === "locked" || status === "cashout_pending") {
      return json({ ok: false, error: "Player is not allowed to play right now." }, 403);
    }

    const currentBalance = Number(player.chips || 0);

    if (currentBalance < betAmount) {
      return json({ ok: false, error: "Not enough chips." }, 400);
    }

    const symbols = [
      { name: "cherries", weight: 28, triple: 3 },
      { name: "bar", weight: 24, triple: 4 },
      { name: "whiskey", weight: 18, triple: 6 },
      { name: "coin", weight: 12, triple: 10 },
      { name: "seven", weight: 9, triple: 20 },
      { name: "logo", weight: 6, triple: 35 },
      { name: "crown", weight: 3, triple: 50 }
    ];

    const reels = [
      pickSymbol(symbols),
      pickSymbol(symbols),
      pickSymbol(symbols)
    ];

    const evaluation = evaluateSpin(reels, betAmount);

    const payout = evaluation.payout;
    const result = evaluation.result;
    const netChange = payout - betAmount;
    const balanceAfter = currentBalance + netChange;
    const roundId = crypto.randomUUID();
    const reelNames = reels.map(s => s.name);

    await env.DB.batch([
      env.DB.prepare(`
        UPDATE wallets
        SET chips = ?, updated_at = CURRENT_TIMESTAMP
        WHERE player_id = ?
      `).bind(balanceAfter, playerId),

      env.DB.prepare(`
        INSERT INTO slots_rounds (
          id,
          player_id,
          bet_amount,
          reels,
          result,
          payout,
          status
        )
        VALUES (?, ?, ?, ?, ?, ?, 'settled')
      `).bind(
        roundId,
        playerId,
        betAmount,
        JSON.stringify(reelNames),
        result,
        payout
      ),

      env.DB.prepare(`
        INSERT INTO transactions (
          id,
          player_id,
          type,
          amount,
          balance_after,
          game,
          note
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        playerId,
        "slots_bet",
        -betAmount,
        currentBalance - betAmount,
        "slots",
        "Slots bet"
      ),

      env.DB.prepare(`
        INSERT INTO transactions (
          id,
          player_id,
          type,
          amount,
          balance_after,
          game,
          note
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        playerId,
        payout > 0 ? "slots_payout" : "slots_loss",
        payout,
        balanceAfter,
        "slots",
        result
      )
    ]);

    return json({
      ok: true,
      roundId,
      reels: reelNames,
      result,
      betAmount,
      payout,
      netChange,
      balanceAfter
    });

  } catch (error) {
    return json({
      ok: false,
      error: String(error.message || error || "Slots failed.")
    }, 500);
  }
}

function pickSymbol(symbols) {
  const totalWeight = symbols.reduce((sum, symbol) => {
    return sum + Number(symbol.weight || 0);
  }, 0);

  let roll = Math.random() * totalWeight;

  for (const symbol of symbols) {
    roll -= symbol.weight;

    if (roll <= 0) {
      return symbol;
    }
  }

  return symbols[0];
}

function evaluateSpin(reels, betAmount) {
  const [a, b, c] = reels;

  if (a.name === b.name && b.name === c.name) {
    return {
      result: `Triple ${formatSymbolName(a.name)}`,
      payout: betAmount * a.triple
    };
  }

  if (a.name === "cherries") {
    if (b.name === "cherries") {
      return {
        result: "Two Cherries",
        payout: betAmount * 2
      };
    }

    return {
      result: "One Cherry",
      payout: betAmount
    };
  }

  return {
    result: "No Match",
    payout: 0
  };
}

function formatSymbolName(name) {
  return String(name || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}