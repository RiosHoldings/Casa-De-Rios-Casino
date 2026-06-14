function json(data, status = 200) {
  return Response.json(data, { status });
}

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return shuffle(deck);
}

function randomIndex(max) {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] % max;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardValue(card) {
  if (card.rank === "A") return 11;
  if (["K", "Q", "J"].includes(card.rank)) return 10;
  return Number(card.rank);
}

function handValue(hand) {
  let total = 0;
  let aces = 0;

  for (const card of hand) {
    total += cardValue(card);
    if (card.rank === "A") aces++;
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }

  return {
    total,
    soft: aces > 0
  };
}

function isBlackjack(hand) {
  return hand.length === 2 && handValue(hand).total === 21;
}

function dealerPublicHand(hand, reveal = false) {
  if (reveal) return hand;

  return hand.map((card, index) => {
    if (index === 0) return card;
    return { rank: "?", suit: "?", hidden: true };
  });
}

async function logTransaction(db, playerId, type, amount, balanceAfter, note) {
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
    VALUES (?, ?, ?, ?, ?, 'blackjack', ?, CURRENT_TIMESTAMP)
  `).bind(
    crypto.randomUUID(),
    playerId,
    type,
    amount,
    balanceAfter,
    note
  ).run();
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
    const betAmount = Math.floor(Number(body.betAmount || 0));

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json({ ok: false, error: "Invalid Player ID." }, 400);
    }

    if (!playerSecret || playerSecret.length < 20) {
      return json({ ok: false, error: "Invalid Player Secret." }, 400);
    }

    if (!Number.isFinite(betAmount) || betAmount <= 0) {
      return json({ ok: false, error: "Invalid bet amount." }, 400);
    }

    if (betAmount > 50000) {
      return json({ ok: false, error: "Max blackjack bet is 50,000." }, 400);
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

    if (player.status === "banned" || player.status === "locked") {
      return json({ ok: false, error: "Player is not allowed to play right now." }, 403);
    }

    const wallet = await db.prepare(`
      SELECT chips, locked
      FROM wallets
      WHERE player_id = ?
    `).bind(playerId).first();

    if (!wallet) {
      return json({ ok: false, error: "Wallet not found." }, 404);
    }

    if (Number(wallet.locked || 0) === 1) {
      return json({ ok: false, error: "Wallet is locked." }, 403);
    }

    if (Number(wallet.chips || 0) < betAmount) {
      return json({ ok: false, error: "Not enough chips." }, 400);
    }

    const spend = await db.prepare(`
      UPDATE wallets
      SET chips = chips - ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE player_id = ?
        AND chips >= ?
        AND locked = 0
    `).bind(betAmount, playerId, betAmount).run();

    if (!spend.meta || spend.meta.changes < 1) {
      return json({ ok: false, error: "Bet could not be placed." }, 400);
    }

    const afterBetWallet = await db.prepare(`
      SELECT chips
      FROM wallets
      WHERE player_id = ?
    `).bind(playerId).first();

    await logTransaction(
      db,
      playerId,
      "blackjack_bet",
      -betAmount,
      afterBetWallet.chips,
      `Blackjack bet placed for ${betAmount} chips.`
    );

    const newLifetimeWagered =
  Number(player.lifetime_wagered || 0) + betAmount;

let newVipTier = "patron";

if (String(player.vip_tier || "").toLowerCase() === "la_leyenda") {
  newVipTier = "la_leyenda";
} else if (newLifetimeWagered >= 1000000) {
  newVipTier = "el_jefe";
} else if (newLifetimeWagered >= 500000) {
  newVipTier = "magnate";
} else if (newLifetimeWagered >= 100000) {
  newVipTier = "caballero";
}

await db.prepare(`
  UPDATE players
  SET lifetime_wagered = ?,
      vip_tier = ?,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`).bind(
  newLifetimeWagered,
  newVipTier,
  playerId
).run();

    const deck = makeDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const dealerHand = [deck.pop(), deck.pop()];
    const handId = crypto.randomUUID();

    let status = "active";
    let result = null;
    let payout = 0;
    let message = "Choose Hit, Stand, or Double.";

    const playerBJ = isBlackjack(playerHand);
    const dealerBJ = isBlackjack(dealerHand);

    if (playerBJ || dealerBJ) {
      status = "settled";

      if (playerBJ && dealerBJ) {
        result = "push";
        payout = betAmount;
        message = "Both have blackjack. Push.";
      } else if (playerBJ) {
        result = "blackjack";
        payout = Math.floor(betAmount * 2.5);
        message = "Blackjack! Pays 3:2.";
      } else {
        result = "dealer_blackjack";
        payout = 0;
        message = "Dealer has blackjack.";
      }

      if (payout > 0) {
        await db.prepare(`
          UPDATE wallets
          SET chips = chips + ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE player_id = ?
        `).bind(payout, playerId).run();
      }
    }

    await db.prepare(`
      INSERT INTO blackjack_hands (
        id,
        player_id,
        bet_amount,
        player_hand,
        dealer_hand,
        deck,
        status,
        result,
        payout,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(
      handId,
      playerId,
      betAmount,
      JSON.stringify(playerHand),
      JSON.stringify(dealerHand),
      JSON.stringify(deck),
      status,
      result,
      payout
    ).run();

    const finalWallet = await db.prepare(`
      SELECT chips
      FROM wallets
      WHERE player_id = ?
    `).bind(playerId).first();

    if (status === "settled") {
      await logTransaction(
        db,
        playerId,
        payout > 0 ? "blackjack_payout" : "blackjack_result",
        payout,
        finalWallet.chips,
        `${message} Bet ${betAmount}. Payout ${payout}.`
      );
    }

    return json({
      ok: true,
      handId,
      status,
      result,
      message,
      betAmount,
      payout,
      playerHand,
      dealerHandPublic: dealerPublicHand(dealerHand, status === "settled"),
      playerTotal: handValue(playerHand).total,
      dealerTotal: status === "settled" ? handValue(dealerHand).total : null,
      balanceAfter: finalWallet.chips
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Blackjack start failed."
    }, 500);
  }
}