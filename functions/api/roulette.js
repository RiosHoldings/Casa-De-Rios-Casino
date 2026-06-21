function json(data, status = 200) {
  return Response.json(data, { status });
}

/* Correct European roulette red numbers */
const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18,
  19, 21, 23, 25, 27, 30, 32, 34, 36
]);

const MAX_TOTAL_ROULETTE_BET = 50000;
const MAX_BETS_PER_SPIN = 100;

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
  if (betType === "number") return Number(betValue) === resultNumber;
  if (betType === "color") return betValue === resultColor;

  if (resultNumber === 0) return false;

  if (betType === "oddEven") {
    return betValue === "odd"
      ? resultNumber % 2 === 1
      : resultNumber % 2 === 0;
  }

  if (betType === "range") {
    return betValue === "low"
      ? resultNumber >= 1 && resultNumber <= 18
      : resultNumber >= 19 && resultNumber <= 36;
  }

  if (betType === "dozen") {
    const dozen = Number(betValue);
    if (dozen === 1) return resultNumber >= 1 && resultNumber <= 12;
    if (dozen === 2) return resultNumber >= 13 && resultNumber <= 24;
    if (dozen === 3) return resultNumber >= 25 && resultNumber <= 36;
  }

  if (betType === "column") {
    const column = Number(betValue);
    if (column === 1) return resultNumber % 3 === 1;
    if (column === 2) return resultNumber % 3 === 2;
    if (column === 3) return resultNumber % 3 === 0;
  }

  return false;
}

function payoutTotal(betType, betAmount, won) {
  if (!won) return 0;

  if (betType === "number") return betAmount * 36;
  if (betType === "dozen") return betAmount * 3;
  if (betType === "column") return betAmount * 3;

  return betAmount * 2;
}

function validateBet(betType, betValue) {
  const allowedTypes = ["number", "color", "oddEven", "range", "dozen", "column"];

  if (!allowedTypes.includes(betType)) {
    return "Invalid bet type.";
  }

  if (betType === "number") {
    const n = Number(betValue);
    if (!Number.isInteger(n) || n < 0 || n > 36) {
      return "Number bet must be 0 through 36.";
    }
  }

  if (betType === "color" && !["red", "black"].includes(betValue)) {
    return "Color bet must be red or black.";
  }

  if (betType === "oddEven" && !["odd", "even"].includes(betValue)) {
    return "Odd/even bet must be odd or even.";
  }

  if (betType === "range" && !["low", "high"].includes(betValue)) {
    return "Range bet must be low or high.";
  }

  if (betType === "dozen") {
    const dozen = Number(betValue);
    if (![1, 2, 3].includes(dozen)) {
      return "Dozen bet must be 1, 2, or 3.";
    }
  }

  if (betType === "column") {
    const column = Number(betValue);
    if (![1, 2, 3].includes(column)) {
      return "Column bet must be 1, 2, or 3.";
    }
  }

  return null;
}

function normalizeBet(rawBet) {
  const betType = String(rawBet.betType ?? rawBet.type ?? "").trim();

  let betValue = String(rawBet.betValue ?? rawBet.value ?? "").trim();

  if (["color", "oddEven", "range"].includes(betType)) {
    betValue = betValue.toLowerCase();
  }

  const betAmount = Math.floor(Number(rawBet.betAmount ?? rawBet.amount ?? 0));

  const betError = validateBet(betType, betValue);
  if (betError) {
    return { ok: false, error: betError };
  }

  if (!Number.isFinite(betAmount) || betAmount <= 0) {
    return { ok: false, error: "Invalid bet amount." };
  }

  return {
    ok: true,
    bet: {
      betType,
      betValue,
      betAmount
    }
  };
}

function getVipTier(currentTier, lifetimeWagered) {
  if (String(currentTier || "").toLowerCase() === "la_leyenda") {
    return "la_leyenda";
  }

  if (lifetimeWagered >= 1000000) return "el_jefe";
  if (lifetimeWagered >= 500000) return "magnate";
  if (lifetimeWagered >= 100000) return "caballero";

  return "patron";
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

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json({ ok: false, error: "Invalid Player ID." }, 400);
    }

    if (!playerSecret || playerSecret.length < 20) {
      return json({ ok: false, error: "Invalid Player Secret." }, 400);
    }

    /*
      Supports BOTH:
      New frontend:
        { bets: [{ betType, betValue, betAmount }] }

      Old frontend:
        { betType, betValue, betAmount }
    */
    const rawBets = Array.isArray(body.bets)
      ? body.bets
      : [{
          betType: body.betType,
          betValue: body.betValue,
          betAmount: body.betAmount
        }];

    if (!rawBets.length) {
      return json({ ok: false, error: "No bets provided." }, 400);
    }

    if (rawBets.length > MAX_BETS_PER_SPIN) {
      return json({ ok: false, error: `Max ${MAX_BETS_PER_SPIN} bets per spin.` }, 400);
    }

    const bets = [];

    for (const rawBet of rawBets) {
      const normalized = normalizeBet(rawBet);

      if (!normalized.ok) {
        return json({ ok: false, error: normalized.error }, 400);
      }

      bets.push(normalized.bet);
    }

    const totalBetAmount = bets.reduce((sum, bet) => {
      return sum + bet.betAmount;
    }, 0);

    if (!Number.isFinite(totalBetAmount) || totalBetAmount <= 0) {
      return json({ ok: false, error: "Invalid total bet amount." }, 400);
    }

    if (totalBetAmount > MAX_TOTAL_ROULETTE_BET) {
      return json({
        ok: false,
        error: `Max roulette bet per spin is ${MAX_TOTAL_ROULETTE_BET}.`
      }, 400);
    }

    const player = await db.prepare(`
      SELECT id, player_secret, status, vip_tier, lifetime_wagered
      FROM players
      WHERE id = ?
    `).bind(playerId).first();

    if (!player) {
      return json({ ok: false, error: "Player not found. Create Player ID first." }, 404);
    }

    if (player.player_secret !== playerSecret) {
      return json({ ok: false, error: "Player Secret mismatch." }, 401);
    }

    if (player.status && player.status !== "active") {
      return json({ ok: false, error: "Player account is not active." }, 403);
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

    if (wallet.chips < totalBetAmount) {
      return json({ ok: false, error: "Not enough chips." }, 400);
    }

    const spend = await db.prepare(`
      UPDATE wallets
      SET chips = chips - ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE player_id = ?
        AND chips >= ?
    `).bind(totalBetAmount, playerId, totalBetAmount).run();

    if (!spend.meta || spend.meta.changes < 1) {
      return json({ ok: false, error: "Bet could not be placed." }, 400);
    }

    const resultNumber = spinNumber();
    const resultColor = rouletteColor(resultNumber);

    const settlements = bets.map((bet) => {
      const won = checkWin(
        bet.betType,
        bet.betValue,
        resultNumber,
        resultColor
      );

      const payout = payoutTotal(bet.betType, bet.betAmount, won);

      return {
        betType: bet.betType,
        betValue: bet.betValue,
        betAmount: bet.betAmount,
        won,
        payout,
        netChange: payout - bet.betAmount
      };
    });

    const totalPayout = settlements.reduce((sum, bet) => {
      return sum + bet.payout;
    }, 0);

    if (totalPayout > 0) {
      await db.prepare(`
        UPDATE wallets
        SET chips = chips + ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE player_id = ?
      `).bind(totalPayout, playerId).run();
    }

    const finalWallet = await db.prepare(`
      SELECT chips
      FROM wallets
      WHERE player_id = ?
    `).bind(playerId).first();

    const roundId = crypto.randomUUID();

    for (const settlement of settlements) {
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
        crypto.randomUUID(),
        playerId,
        settlement.betType,
        settlement.betValue,
        settlement.betAmount,
        resultNumber,
        resultColor,
        settlement.payout
      ).run();
    }

    const transactionId = crypto.randomUUID();
    const netChange = totalPayout - totalBetAmount;

    const betSummary = settlements
      .map((bet) => `${bet.betAmount} on ${bet.betType} ${bet.betValue}`)
      .join("; ")
      .slice(0, 700);

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
      `Round ${roundId}. Bets: ${betSummary}. Result ${resultNumber} ${resultColor}.`
    ).run();

    const newLifetimeWagered = Number(player.lifetime_wagered || 0) + totalBetAmount;
    const newVipTier = getVipTier(player.vip_tier, newLifetimeWagered);

    await db.prepare(`
      UPDATE players
      SET lifetime_wagered = ?,
          vip_tier = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(newLifetimeWagered, newVipTier, playerId).run();

    return json({
      ok: true,
      roundId,
      resultNumber,
      resultColor,

      bets: settlements,
      totalBetAmount,
      totalPayout,

      /* Kept for frontend compatibility */
      payout: totalPayout,
      won: totalPayout > 0,

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