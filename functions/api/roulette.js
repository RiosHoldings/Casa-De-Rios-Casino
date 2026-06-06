function json(data, status = 200) {
  return Response.json(data, { status });
}

const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18,
  19, 21, 23, 25, 27, 30, 32, 34, 36
]);

function rouletteColor(number) {
  if (number === 0) return "green";
  return RED_NUMBERS.has(number) ? "red" : "black";
}

function spinNumber() {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] % 37;
}

function checkWin(betType, betValue, resultNumber, resultColor) {
  if (betType === "red") return resultColor === "red";
  if (betType === "black") return resultColor === "black";
  if (betType === "odd") return resultNumber !== 0 && resultNumber % 2 === 1;
  if (betType === "even") return resultNumber !== 0 && resultNumber % 2 === 0;
  if (betType === "low") return resultNumber >= 1 && resultNumber <= 18;
  if (betType === "high") return resultNumber >= 19 && resultNumber <= 36;
  if (betType === "number") return Number(betValue) === resultNumber;
  return false;
}

function payoutTotal(betType, betAmount, won) {
  if (!won) return 0;

  if (betType === "number") {
    return betAmount * 36;
  }

  return betAmount * 2;
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;

    if (!db) {
      return json({ ok: false, error: "D1 database binding DB is missing." }, 500);
    }

    const body = await context.request.json();

    const playerId = String(body.playerId || "").trim();
    const playerSecret = String(body.playerSecret || "").trim();
    const betType = String(body.betType || "").trim();
    const betValue = String(body.betValue || "").trim();
    const betAmount = Math.floor(Number(body.betAmount || 0));

    const allowedTypes = ["red", "black", "odd", "even", "low", "high", "number"];

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json({ ok: false, error: "Invalid Player ID." }, 400);
    }

    if (!playerSecret || playerSecret.length < 20) {
      return json({ ok: false, error: "Invalid Player Secret." }, 400);
    }

    if (!allowedTypes.includes(betType)) {
      return json({ ok: false, error: "Invalid bet type." }, 400);
    }

    if (!Number.isFinite(betAmount) || betAmount <= 0) {
      return json({ ok: false, error: "Invalid bet amount." }, 400);
    }

    if (betAmount > 50000) {
      return json({ ok: false, error: "Max roulette bet is 50,000." }, 400);
    }

    if (betType === "number") {
      const n = Number(betValue);
      if (!Number.isInteger(n) || n < 0 || n > 36) {
        return json({ ok: false, error: "Number bet must be 0 through 36." }, 400);
      }
    }

    const player = await db.prepare(`
      SELECT id, player_secret, status
      FROM players
      WHERE id = ?
    `).bind(playerId).first();

    if (!player) {
      return json({ ok: false, error: "Player not found. Create Player ID first." }, 404);
    }

    if (player.player_secret !== playerSecret) {
      return json({ ok: false, error: "Player Secret mismatch." }, 401);
    }

    const wallet = await db.prepare(`
      SELECT chips, locked
      FROM wallets
      WHERE player_id = ?
    `).bind(playerId).first();

    if (!wallet) {
      return json({ ok: false, error: "Wallet not found." }, 404);
    }

    if (wallet.locked) {
      return json({ ok: false, error: "Wallet is locked." }, 403);
    }

    if (wallet.chips < betAmount) {
      return json({ ok: false, error: "Not enough chips." }, 400);
    }

    const spend = await db.prepare(`
      UPDATE wallets
      SET chips = chips - ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE player_id = ?
        AND chips >= ?
    `).bind(betAmount, playerId, betAmount).run();

    if (!spend.meta || spend.meta.changes < 1) {
      return json({ ok: false, error: "Bet could not be placed." }, 400);
    }

    const resultNumber = spinNumber();
    const resultColor = rouletteColor(resultNumber);
    const won = checkWin(betType, betValue, resultNumber, resultColor);
    const payout = payoutTotal(betType, betAmount, won);

    if (payout > 0) {
      await db.prepare(`
        UPDATE wallets
        SET chips = chips + ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE player_id = ?
      `).bind(payout, playerId).run();
    }

    const finalWallet = await db.prepare(`
      SELECT chips
      FROM wallets
      WHERE player_id = ?
    `).bind(playerId).first();

    const roundId = crypto.randomUUID();

    await db.prepare(`
      INSERT INTO roulette_rounds (
        id,
        player_id,
        bet_type,
        bet_value,
        bet_amount,
        result_number,
        result_color,
        payout,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'settled', CURRENT_TIMESTAMP)
    `).bind(
      roundId,
      playerId,
      betType,
      betValue,
      betAmount,
      resultNumber,
      resultColor,
      payout
    ).run();

    const transactionId = crypto.randomUUID();
    const netChange = payout - betAmount;

    await db.prepare(`
      INSERT INTO transactions (
        id,
        player_id,
        type,
        amount,
        balance_after,
        game,
        note,
        created_at
      )
      VALUES (?, ?, 'roulette_spin', ?, ?, 'roulette', ?, CURRENT_TIMESTAMP)
    `).bind(
      transactionId,
      playerId,
      netChange,
      finalWallet.chips,
      `Bet ${betAmount} on ${betType}${betType === "number" ? " " + betValue : ""}. Result ${resultNumber} ${resultColor}.`
    ).run();

    return json({
      ok: true,
      roundId,
      resultNumber,
      resultColor,
      won,
      betAmount,
      payout,
      netChange,
      balanceAfter: finalWallet.chips
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Roulette failed."
    }, 500);
  }
}