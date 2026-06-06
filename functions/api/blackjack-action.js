function json(data, status = 200) {
  return Response.json(data, { status });
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

function dealerPublicHand(hand, reveal = false) {
  if (reveal) return hand;

  return hand.map((card, index) => {
    if (index === 0) return card;
    return { rank: "?", suit: "?", hidden: true };
  });
}

function draw(deck) {
  return deck.pop();
}

function playDealer(deck, dealerHand) {
  while (handValue(dealerHand).total < 17) {
    dealerHand.push(draw(deck));
  }
}

function settleResult(playerHand, dealerHand) {
  const playerTotal = handValue(playerHand).total;
  const dealerTotal = handValue(dealerHand).total;

  if (playerTotal > 21) return "loss";
  if (dealerTotal > 21) return "win";
  if (playerTotal > dealerTotal) return "win";
  if (playerTotal === dealerTotal) return "push";
  return "loss";
}

function payoutFor(result, betAmount) {
  if (result === "win") return betAmount * 2;
  if (result === "push") return betAmount;
  return 0;
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

async function settleHand(db, hand, playerHand, dealerHand, deck, betAmount, result) {
  const payout = payoutFor(result, betAmount);

  if (payout > 0) {
    await db.prepare(`
      UPDATE wallets
      SET chips = chips + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE player_id = ?
    `).bind(payout, hand.player_id).run();
  }

  await db.prepare(`
    UPDATE blackjack_hands
    SET player_hand = ?,
        dealer_hand = ?,
        deck = ?,
        bet_amount = ?,
        status = 'settled',
        result = ?,
        payout = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    JSON.stringify(playerHand),
    JSON.stringify(dealerHand),
    JSON.stringify(deck),
    betAmount,
    result,
    payout,
    hand.id
  ).run();

  const finalWallet = await db.prepare(`
    SELECT chips
    FROM wallets
    WHERE player_id = ?
  `).bind(hand.player_id).first();

  await logTransaction(
    db,
    hand.player_id,
    payout > 0 ? "blackjack_payout" : "blackjack_result",
    payout,
    finalWallet.chips,
    `Blackjack ${result}. Bet ${betAmount}. Payout ${payout}.`
  );

  return {
    status: "settled",
    result,
    payout,
    balanceAfter: finalWallet.chips
  };
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
    const handId = String(body.handId || "").trim();
    const action = String(body.action || "").trim();

    if (!playerId || !playerId.startsWith("CDR-")) {
      return json({ ok: false, error: "Invalid Player ID." }, 400);
    }

    if (!playerSecret || playerSecret.length < 20) {
      return json({ ok: false, error: "Invalid Player Secret." }, 400);
    }

    if (!handId) {
      return json({ ok: false, error: "Missing hand ID." }, 400);
    }

    if (!["hit", "stand", "double"].includes(action)) {
      return json({ ok: false, error: "Invalid blackjack action." }, 400);
    }

    const hand = await db.prepare(`
      SELECT
        blackjack_hands.*,
        players.player_secret,
        players.status AS player_status,
        wallets.chips,
        wallets.locked
      FROM blackjack_hands
      LEFT JOIN players ON players.id = blackjack_hands.player_id
      LEFT JOIN wallets ON wallets.player_id = blackjack_hands.player_id
      WHERE blackjack_hands.id = ?
        AND blackjack_hands.player_id = ?
    `).bind(handId, playerId).first();

    if (!hand) {
      return json({ ok: false, error: "Blackjack hand not found." }, 404);
    }

    if (hand.player_secret !== playerSecret) {
      return json({ ok: false, error: "Player Secret mismatch." }, 401);
    }

    if (hand.player_status === "banned" || hand.player_status === "locked") {
      return json({ ok: false, error: "Player is not allowed to play right now." }, 403);
    }

    if (Number(hand.locked || 0) === 1) {
      return json({ ok: false, error: "Wallet is locked." }, 403);
    }

    if (hand.status !== "active") {
      return json({ ok: false, error: "This hand is already settled." }, 400);
    }

    let playerHand = JSON.parse(hand.player_hand || "[]");
    let dealerHand = JSON.parse(hand.dealer_hand || "[]");
    let deck = JSON.parse(hand.deck || "[]");
    let betAmount = Number(hand.bet_amount || 0);
    let message = "";

    if (action === "hit") {
      playerHand.push(draw(deck));

      if (handValue(playerHand).total > 21) {
        const settled = await settleHand(db, hand, playerHand, dealerHand, deck, betAmount, "loss");
        message = "Bust. Dealer wins.";

        return json({
          ok: true,
          handId,
          message,
          betAmount,
          playerHand,
          dealerHandPublic: dealerPublicHand(dealerHand, true),
          playerTotal: handValue(playerHand).total,
          dealerTotal: handValue(dealerHand).total,
          ...settled
        });
      }

      await db.prepare(`
        UPDATE blackjack_hands
        SET player_hand = ?,
            deck = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(JSON.stringify(playerHand), JSON.stringify(deck), handId).run();

      message = "Card dealt. Hit or Stand.";

      return json({
        ok: true,
        handId,
        status: "active",
        message,
        betAmount,
        payout: 0,
        playerHand,
        dealerHandPublic: dealerPublicHand(dealerHand, false),
        playerTotal: handValue(playerHand).total,
        dealerTotal: null,
        balanceAfter: Number(hand.chips || 0)
      });
    }

    if (action === "double") {
      if (playerHand.length !== 2) {
        return json({ ok: false, error: "Double is only allowed on your first two cards." }, 400);
      }

      if (Number(hand.chips || 0) < betAmount) {
        return json({ ok: false, error: "Not enough chips to double." }, 400);
      }

      const doubleSpend = await db.prepare(`
        UPDATE wallets
        SET chips = chips - ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE player_id = ?
          AND chips >= ?
          AND locked = 0
      `).bind(betAmount, playerId, betAmount).run();

      if (!doubleSpend.meta || doubleSpend.meta.changes < 1) {
        return json({ ok: false, error: "Double bet could not be placed." }, 400);
      }

      const afterDoubleWallet = await db.prepare(`
        SELECT chips
        FROM wallets
        WHERE player_id = ?
      `).bind(playerId).first();

      await logTransaction(
        db,
        playerId,
        "blackjack_double",
        -betAmount,
        afterDoubleWallet.chips,
        `Blackjack double placed for ${betAmount} extra chips.`
      );

      betAmount = betAmount * 2;
      playerHand.push(draw(deck));

      if (handValue(playerHand).total > 21) {
        const settled = await settleHand(db, hand, playerHand, dealerHand, deck, betAmount, "loss");
        message = "Double down bust. Dealer wins.";

        return json({
          ok: true,
          handId,
          message,
          betAmount,
          playerHand,
          dealerHandPublic: dealerPublicHand(dealerHand, true),
          playerTotal: handValue(playerHand).total,
          dealerTotal: handValue(dealerHand).total,
          ...settled
        });
      }

      playDealer(deck, dealerHand);
      const result = settleResult(playerHand, dealerHand);
      const settled = await settleHand(db, hand, playerHand, dealerHand, deck, betAmount, result);
      message = result === "win" ? "Double down win." : result === "push" ? "Double down push." : "Double down loss.";

      return json({
        ok: true,
        handId,
        message,
        betAmount,
        playerHand,
        dealerHandPublic: dealerPublicHand(dealerHand, true),
        playerTotal: handValue(playerHand).total,
        dealerTotal: handValue(dealerHand).total,
        ...settled
      });
    }

    playDealer(deck, dealerHand);
    const result = settleResult(playerHand, dealerHand);
    const settled = await settleHand(db, hand, playerHand, dealerHand, deck, betAmount, result);

    if (result === "win") message = "You win.";
    else if (result === "push") message = "Push. Bet returned.";
    else message = "Dealer wins.";

    return json({
      ok: true,
      handId,
      message,
      betAmount,
      playerHand,
      dealerHandPublic: dealerPublicHand(dealerHand, true),
      playerTotal: handValue(playerHand).total,
      dealerTotal: handValue(dealerHand).total,
      ...settled
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Blackjack action failed."
    }, 500);
  }
}