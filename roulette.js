/*
  OPTIONAL Cloudflare Pages Function: /functions/api/roulette.js

  This is a server-side spin template for D1.
  You may need to change PLAYER_TABLE / PLAYER_ID_COLUMN / BALANCE_COLUMN to match your exact DB schema.

  Expected request:
    POST /api/roulette
    { "playerId": "...", "bets": [{ "type":"straight", "value":"17", "amount":100 }] }

  Response:
    { ok, result:{number,color}, totalBet, payout, balance }
*/

const PLAYER_TABLE = "players";
const PLAYER_ID_COLUMN = "player_id";
const BALANCE_COLUMN = "balance";

const WHEEL_SEQUENCE = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
  5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26
];

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const BLACK_NUMBERS = new Set(Array.from({ length: 36 }, (_, i) => i + 1).filter(n => !RED_NUMBERS.has(n)));
const MIN_BET = 50;
const MAX_TOTAL_BET = 50000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function numberColor(num) {
  if (num === 0) return "green";
  return RED_NUMBERS.has(num) ? "red" : "black";
}

function numbersForBet(type, value) {
  const all = Array.from({ length: 36 }, (_, i) => i + 1);
  if (type === "straight") return [Number(value)];
  if (type === "color") return value === "red" ? [...RED_NUMBERS] : [...BLACK_NUMBERS];
  if (type === "parity") return all.filter(n => value === "even" ? n % 2 === 0 : n % 2 === 1);
  if (type === "range") return value === "low" ? all.filter(n => n <= 18) : all.filter(n => n >= 19);
  if (type === "dozen") {
    const dozen = Number(value);
    const start = (dozen - 1) * 12 + 1;
    return all.filter(n => n >= start && n <= start + 11);
  }
  if (type === "column") return all.filter(n => n % 3 === Number(value) % 3);
  return [];
}

function payoutForBet(type) {
  if (type === "straight") return 35;
  if (type === "dozen" || type === "column") return 2;
  return 1;
}

function validateBet(raw) {
  const type = String(raw?.type || "");
  const value = String(raw?.value ?? "");
  const amount = Number(raw?.amount);

  const allowedTypes = new Set(["straight", "color", "parity", "range", "dozen", "column"]);
  if (!allowedTypes.has(type)) throw new Error("Invalid bet type.");
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Invalid bet amount.");

  const numbers = numbersForBet(type, value);
  if (!numbers.length && !(type === "straight" && value === "0")) throw new Error("Invalid bet value.");
  if (type === "straight" && (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 36)) throw new Error("Invalid straight number.");
  if (type === "color" && !["red", "black"].includes(value)) throw new Error("Invalid color.");
  if (type === "parity" && !["even", "odd"].includes(value)) throw new Error("Invalid parity.");
  if (type === "range" && !["low", "high"].includes(value)) throw new Error("Invalid range.");
  if (type === "dozen" && !["1", "2", "3"].includes(value)) throw new Error("Invalid dozen.");
  if (type === "column" && !["1", "2", "3"].includes(value)) throw new Error("Invalid column.");

  return { type, value, amount, numbers, payout: payoutForBet(type) };
}

function secureRandomIndex(maxExclusive) {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] % maxExclusive;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ ok: false, error: "Missing D1 binding env.DB." }, 500);

    const body = await request.json();
    const playerId = String(body?.playerId || "").trim();
    if (!playerId) return json({ ok: false, error: "Missing playerId." }, 400);

    const bets = Array.isArray(body?.bets) ? body.bets.map(validateBet) : [];
    if (!bets.length) return json({ ok: false, error: "Place a bet first." }, 400);

    const totalBet = bets.reduce((sum, bet) => sum + bet.amount, 0);
    if (totalBet < MIN_BET) return json({ ok: false, error: `Minimum bet is ${MIN_BET}.` }, 400);
    if (totalBet > MAX_TOTAL_BET) return json({ ok: false, error: `Table limit is ${MAX_TOTAL_BET}.` }, 400);

    const player = await env.DB.prepare(
      `SELECT ${BALANCE_COLUMN} AS balance FROM ${PLAYER_TABLE} WHERE ${PLAYER_ID_COLUMN} = ? LIMIT 1`
    ).bind(playerId).first();

    if (!player) return json({ ok: false, error: "Player not found." }, 404);

    const currentBalance = Number(player.balance || 0);
    if (currentBalance < totalBet) return json({ ok: false, error: "Not enough chips." }, 400);

    const winningNumber = WHEEL_SEQUENCE[secureRandomIndex(WHEEL_SEQUENCE.length)];
    let payout = 0;

    for (const bet of bets) {
      if (bet.numbers.includes(winningNumber)) {
        payout += bet.amount * (bet.payout + 1);
      }
    }

    const newBalance = currentBalance - totalBet + payout;

    await env.DB.prepare(
      `UPDATE ${PLAYER_TABLE} SET ${BALANCE_COLUMN} = ? WHERE ${PLAYER_ID_COLUMN} = ?`
    ).bind(newBalance, playerId).run();

    // Optional audit table. Uncomment after creating the table.
    // await env.DB.prepare(
    //   `INSERT INTO game_audit (player_id, game, wager, payout, result, created_at)
    //    VALUES (?, 'roulette', ?, ?, ?, datetime('now'))`
    // ).bind(playerId, totalBet, payout, String(winningNumber)).run();

    return json({
      ok: true,
      result: { number: winningNumber, color: numberColor(winningNumber) },
      totalBet,
      payout,
      balance: newBalance,
    });
  } catch (error) {
    return json({ ok: false, error: error.message || "Roulette failed." }, 500);
  }
}
