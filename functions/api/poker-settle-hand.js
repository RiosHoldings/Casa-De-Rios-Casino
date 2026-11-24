/* ============================================================
   CASA DE RÍOS — TEXAS HOLD'EM
   /functions/api/poker-settle-hand.js

   HANDLES:
   - Fold wins
   - Showdowns
   - Best 5-card hand from 7 cards
   - Side pots
   - Uncalled chip returns
   - 10% rake
   - 1,000 rake cap
   - No Flop, No Drop
   - Split pots
   - Odd chips clockwise from dealer
   - Player stack payouts
   ============================================================ */


/* ============================================================
   RESPONSE
   ============================================================ */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}


/* ============================================================
   HELPERS
   ============================================================ */

function parseArray(value) {
  if (!value) {
    return [];
  }

  if (
    Array.isArray(value)
  ) {
    return value;
  }

  try {
    const parsed =
      JSON.parse(value);

    return Array.isArray(
      parsed
    )
      ? parsed
      : [];

  } catch {
    return [];
  }
}


function rankValue(rank) {
  const ranks = {
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 7,
    "8": 8,
    "9": 9,

    T: 10,
    J: 11,
    Q: 12,
    K: 13,
    A: 14
  };

  return ranks[rank] || 0;
}


function parseCard(card) {
  const text =
    String(
      card || ""
    )
      .trim()
      .toUpperCase();


  if (
    text.length !== 2
  ) {
    throw new Error(
      `Invalid card: ${text}`
    );
  }


  const rank =
    rankValue(
      text[0]
    );

  const suit =
    text[1];


  if (
    !rank ||
    ![
      "C",
      "D",
      "H",
      "S"
    ].includes(suit)
  ) {
    throw new Error(
      `Invalid card: ${text}`
    );
  }


  return {
    code:
      text,

    rank,

    suit
  };
}


/* ============================================================
   SCORE COMPARISON
   ============================================================ */

function compareScore(
  a,
  b
) {
  const length =
    Math.max(
      a.length,
      b.length
    );


  for (
    let i = 0;
    i < length;
    i++
  ) {
    const av =
      Number(
        a[i] || 0
      );

    const bv =
      Number(
        b[i] || 0
      );


    if (
      av !== bv
    ) {
      return av - bv;
    }
  }


  return 0;
}


/* ============================================================
   STRAIGHT DETECTION
   ============================================================ */

function straightHighFromRanks(
  ranks
) {
  const unique =
    [
      ...new Set(ranks)
    ].sort(
      (a, b) =>
        b - a
    );


  /*
    Ace can also be low:
    A-2-3-4-5
  */

  if (
    unique.includes(14)
  ) {
    unique.push(1);
  }


  let run =
    1;


  for (
    let i = 1;
    i < unique.length;
    i++
  ) {
    if (
      unique[i - 1] - 1 ===
      unique[i]
    ) {
      run++;


      if (
        run >= 5
      ) {
        return unique[
          i - 4
        ];
      }

    } else {
      run =
        1;
    }
  }


  return null;
}


/* ============================================================
   EVALUATE EXACTLY FIVE CARDS

   Category:
   8 Straight Flush
   7 Four of a Kind
   6 Full House
   5 Flush
   4 Straight
   3 Three of a Kind
   2 Two Pair
   1 Pair
   0 High Card
   ============================================================ */

function evaluateFive(
  cardCodes
) {
  const cards =
    cardCodes.map(
      parseCard
    );


  const ranks =
    cards
      .map(
        (card) =>
          card.rank
      )
      .sort(
        (a, b) =>
          b - a
      );


  const suits =
    cards.map(
      (card) =>
        card.suit
    );


  const counts =
    new Map();


  for (
    const rank of ranks
  ) {
    counts.set(
      rank,

      (
        counts.get(rank) ||
        0
      ) + 1
    );
  }


  const groups =
    [
      ...counts.entries()
    ].sort(
      (a, b) => {

        if (
          a[1] !== b[1]
        ) {
          return (
            b[1] -
            a[1]
          );
        }

        return (
          b[0] -
          a[0]
        );
      }
    );


  const flush =
    suits.every(
      (suit) =>
        suit === suits[0]
    );


  const straightHigh =
    straightHighFromRanks(
      ranks
    );


  /* ----------------------------------------------------------
     STRAIGHT FLUSH
     ---------------------------------------------------------- */

  if (
    flush &&
    straightHigh
  ) {
    return {
      score: [
        8,
        straightHigh
      ],

      name:
        "Straight Flush"
    };
  }


  /* ----------------------------------------------------------
     FOUR OF A KIND
     ---------------------------------------------------------- */

  if (
    groups[0]?.[1] ===
    4
  ) {
    const quad =
      groups[0][0];


    const kicker =
      groups.find(
        (group) =>
          group[0] !==
          quad
      )?.[0] || 0;


    return {
      score: [
        7,
        quad,
        kicker
      ],

      name:
        "Four of a Kind"
    };
  }


  /* ----------------------------------------------------------
     TRIPS / PAIRS
     ---------------------------------------------------------- */

  const trips =
    groups
      .filter(
        (group) =>
          group[1] >= 3
      )
      .map(
        (group) =>
          group[0]
      )
      .sort(
        (a, b) =>
          b - a
      );


  const pairs =
    groups
      .filter(
        (group) =>
          group[1] >= 2
      )
      .map(
        (group) =>
          group[0]
      )
      .sort(
        (a, b) =>
          b - a
      );


  /* ----------------------------------------------------------
     FULL HOUSE
     ---------------------------------------------------------- */

  if (
    trips.length &&
    pairs.some(
      (rank) =>
        rank !==
        trips[0]
    )
  ) {
    const trip =
      trips[0];


    const pair =
      pairs.find(
        (rank) =>
          rank !== trip
      );


    return {
      score: [
        6,
        trip,
        pair
      ],

      name:
        "Full House"
    };
  }


  /* ----------------------------------------------------------
     FLUSH
     ---------------------------------------------------------- */

  if (flush) {
    return {
      score: [
        5,
        ...ranks
      ],

      name:
        "Flush"
    };
  }


  /* ----------------------------------------------------------
     STRAIGHT
     ---------------------------------------------------------- */

  if (
    straightHigh
  ) {
    return {
      score: [
        4,
        straightHigh
      ],

      name:
        "Straight"
    };
  }


  /* ----------------------------------------------------------
     THREE OF A KIND
     ---------------------------------------------------------- */

  if (
    trips.length
  ) {
    const trip =
      trips[0];


    const kickers =
      ranks
        .filter(
          (rank) =>
            rank !== trip
        )
        .slice(
          0,
          2
        );


    return {
      score: [
        3,
        trip,
        ...kickers
      ],

      name:
        "Three of a Kind"
    };
  }


  /* ----------------------------------------------------------
     EXACT PAIRS
     ---------------------------------------------------------- */

  const exactPairs =
    groups
      .filter(
        (group) =>
          group[1] === 2
      )
      .map(
        (group) =>
          group[0]
      )
      .sort(
        (a, b) =>
          b - a
      );


  /* ----------------------------------------------------------
     TWO PAIR
     ---------------------------------------------------------- */

  if (
    exactPairs.length >=
    2
  ) {
    const highPair =
      exactPairs[0];

    const lowPair =
      exactPairs[1];


    const kicker =
      ranks.find(
        (rank) =>
          rank !== highPair &&
          rank !== lowPair
      ) || 0;


    return {
      score: [
        2,
        highPair,
        lowPair,
        kicker
      ],

      name:
        "Two Pair"
    };
  }


  /* ----------------------------------------------------------
     ONE PAIR
     ---------------------------------------------------------- */

  if (
    exactPairs.length ===
    1
  ) {
    const pair =
      exactPairs[0];


    const kickers =
      ranks
        .filter(
          (rank) =>
            rank !== pair
        )
        .slice(
          0,
          3
        );


    return {
      score: [
        1,
        pair,
        ...kickers
      ],

      name:
        "One Pair"
    };
  }


  /* ----------------------------------------------------------
     HIGH CARD
     ---------------------------------------------------------- */

  return {
    score: [
      0,
      ...ranks
    ],

    name:
      "High Card"
  };
}


/* ============================================================
   GENERATE 5-CARD COMBINATIONS
   ============================================================ */

function combinationsFive(
  cards
) {
  const result =
    [];


  for (
    let a = 0;
    a < cards.length - 4;
    a++
  ) {

    for (
      let b = a + 1;
      b < cards.length - 3;
      b++
    ) {

      for (
        let c = b + 1;
        c < cards.length - 2;
        c++
      ) {

        for (
          let d = c + 1;
          d < cards.length - 1;
          d++
        ) {

          for (
            let e = d + 1;
            e < cards.length;
            e++
          ) {

            result.push([
              cards[a],
              cards[b],
              cards[c],
              cards[d],
              cards[e]
            ]);
          }
        }
      }
    }
  }


  return result;
}


/* ============================================================
   BEST 5 OF 7
   ============================================================ */

function evaluateBest(
  cards
) {
  if (
    !Array.isArray(cards) ||
    cards.length < 5
  ) {
    throw new Error(
      "Not enough cards to evaluate poker hand."
    );
  }


  let best =
    null;


  for (
    const combo of
    combinationsFive(cards)
  ) {
    const evaluated =
      evaluateFive(
        combo
      );


    if (
      !best ||
      compareScore(
        evaluated.score,
        best.score
      ) > 0
    ) {
      best = {
        ...evaluated,

        cards:
          combo
      };
    }
  }


  return best;
}


/* ============================================================
   CLOCKWISE FROM DEALER

   Used for deterministic odd-chip distribution.
   ============================================================ */

function clockwiseSeats(
  players,
  dealerSeat
) {
  return [
    ...players
  ].sort(
    (a, b) => {

      const aDistance =
        (
          a.seatNumber -
          dealerSeat +
          100
        ) % 100;


      const bDistance =
        (
          b.seatNumber -
          dealerSeat +
          100
        ) % 100;


      const normalizedA =
        aDistance === 0
          ? 100
          : aDistance;


      const normalizedB =
        bDistance === 0
          ? 100
          : bDistance;


      return (
        normalizedA -
        normalizedB
      );
    }
  );
}


/* ============================================================
   BUILD MAIN / SIDE POTS

   Singleton upper layers are NOT pots.
   They are uncalled chips and get returned.
   ============================================================ */

function buildPotLayers(
  players
) {
  const contributionLevels =
    [
      ...new Set(
        players
          .map(
            (player) =>
              Number(
                player
                  .totalContributed ||
                0
              )
          )
          .filter(
            (amount) =>
              amount > 0
          )
      )
    ].sort(
      (a, b) =>
        a - b
    );


  const rawPots =
    [];


  const uncalledReturns =
    new Map();


  let previousLevel =
    0;


  for (
    const level of
    contributionLevels
  ) {

    const participants =
      players.filter(
        (player) =>
          Number(
            player
              .totalContributed ||
            0
          ) >=
          level
      );


    const layerAmount =
      (
        level -
        previousLevel
      ) *
      participants.length;


    if (
      layerAmount <= 0
    ) {
      previousLevel =
        level;

      continue;
    }


    /* --------------------------------------------------------
       UNCALLED CHIPS
       -------------------------------------------------------- */

    if (
      participants.length ===
      1
    ) {
      const playerId =
        participants[0]
          .playerId;


      uncalledReturns.set(
        playerId,

        Number(
          uncalledReturns.get(
            playerId
          ) || 0
        ) +
        layerAmount
      );


      previousLevel =
        level;

      continue;
    }


    /* --------------------------------------------------------
       ELIGIBLE PLAYERS

       Folded players' chips remain in the pot,
       but they cannot win it.
       -------------------------------------------------------- */

    const eligible =
      participants.filter(
        (player) =>
          !player.folded
      );


    if (
      eligible.length > 0
    ) {
      rawPots.push({
        grossAmount:
          layerAmount,

        eligible
      });
    }


    previousLevel =
      level;
  }

  /* ==========================================================
     MERGE IDENTICAL ELIGIBITY LAYERS

     Examples:

        Seat 3 folded after 100
        Seat 5 contributed 200
        Seat 6 contributed 200

      Old result:
        Main 300
        Side 200

      But Seats 5 and 6 are eligible for BOTH layers,
      so there is no real side pot.

      New result
        Main 500
      
      A true all-in side pot still remains seperate because
      the eligible player set changes between layers.
    =========================================================== */

  const pots =
  [];

  for (
    const layer of
    rawPots
  ) {

    const eligibleKey =
      layer.eligible
        .map(
          (player) =>
              player.playerId
        )
        .sort()
        .join("|");
  
  const previousPot =
  pots[
    pots.length - 1
  ];

  if (
    previousPot &&
    previousPot.eligibleKey ===
      eligibleKey
  ) {
    previousPot.grossAmount +=
      layer.grossAmount;
  } else {

    pots.push({
      grossAmount:
        layer.grossAmount,


      eligible:
        layer.eligible,

      eligibleKey
    });
  }
}

/*
  Remove internal comparisom key before returning.
*/

const cleanedPots =
  pots.map(
    (pot) => ({
      grossAmount:
      pot.grossAmount,

    eligible:
      pot.eligible
    })
  );

return {
    pots,
    uncalledReturns
  };
}


/* ============================================================
   DETERMINE POT WINNER(S)
   ============================================================ */

function chooseWinners(
  eligiblePlayers,
  board
) {
  /*
    One eligible player means no showdown
    evaluation is needed for this pot.
  */

  if (
    eligiblePlayers.length ===
    1
  ) {
    return {
      winners:
        eligiblePlayers,

      evaluations:
        new Map()
    };
  }


  const evaluations =
    new Map();


  let bestScore =
    null;


  for (
    const player of
    eligiblePlayers
  ) {
    const evaluation =
      evaluateBest([
        ...player.holeCards,
        ...board
      ]);


    evaluations.set(
      player.playerId,
      evaluation
    );


    if (
      !bestScore ||
      compareScore(
        evaluation.score,
        bestScore
      ) > 0
    ) {
      bestScore =
        evaluation.score;
    }
  }


  const winners =
    eligiblePlayers.filter(
      (player) => {

        const evaluation =
          evaluations.get(
            player.playerId
          );


        return (
          compareScore(
            evaluation.score,
            bestScore
          ) === 0
        );
      }
    );


  return {
    winners,
    evaluations
  };
}


/* ============================================================
   POST
   ============================================================ */

async function handlePost(
  context
) {
  const DB =
    context.env.DB;


  if (!DB) {
    return json(
      {
        ok: false,

        error:
          "Poker database is not configured."
      },
      500
    );
  }


  /* ----------------------------------------------------------
     REQUEST
     ---------------------------------------------------------- */

  let body;


  try {
    body =
      await context
        .request
        .json();

  } catch {

    return json(
      {
        ok: false,

        error:
          "Invalid request body."
      },
      400
    );
  }


  const playerId =
    String(
      body.playerId ||
      ""
    ).trim();


  const playerSecret =
    String(
      body.playerSecret ||
      ""
    ).trim();


  const tableId =
    String(
      body.tableId ||
      "poker-room-1"
    ).trim();


  const handId =
    String(
      body.handId ||
      ""
    ).trim();


  if (
    !playerId ||
    !playerSecret ||
    !tableId ||
    !handId
  ) {
    return json(
      {
        ok: false,

        error:
          "Missing poker settlement information."
      },
      400
    );
  }


  /* ----------------------------------------------------------
     AUTH
     ---------------------------------------------------------- */

  const account =
    await DB.prepare(`
      SELECT
        id

      FROM players

      WHERE id = ?
        AND player_secret = ?

      LIMIT 1
    `)
      .bind(
        playerId,
        playerSecret
      )
      .first();


  if (!account) {
    return json(
      {
        ok: false,

        error:
          "Player authentication failed."
      },
      401
    );
  }


  /* ----------------------------------------------------------
     HAND + TABLE RULES
     ---------------------------------------------------------- */

  const hand =
    await DB.prepare(`
      SELECT
        h.id,
        h.table_id,
        h.hand_number,

        h.dealer_seat,

        h.status,
        h.street_reached,

        h.board_json,

        h.flop_dealt,

        h.pot_before_rake,
        h.rake_amount,
        h.pot_after_rake,

        h.winner_summary_json,

        h.ended_at,

        t.rake_basis_points,
        t.rake_cap,
        t.no_flop_no_drop

      FROM poker_hands h

      JOIN poker_tables t
        ON t.id =
           h.table_id

      WHERE h.id = ?
        AND h.table_id = ?

      LIMIT 1
    `)
      .bind(
        handId,
        tableId
      )
      .first();


  if (!hand) {
    return json(
      {
        ok: false,

        error:
          "Poker hand not found."
      },
      404
    );
  }


  /* ----------------------------------------------------------
     ALREADY COMPLETE
     ---------------------------------------------------------- */

  if (
    hand.status ===
    "completed"
  ) {
    return json({
      ok: true,

      alreadySettled:
        true,

      hand: {
        id:
          hand.id,

        handNumber:
          Number(
            hand.hand_number
          ),

        status:
          hand.status,

        potBeforeRake:
          Number(
            hand
              .pot_before_rake ||
            0
          ),

        rake:
          Number(
            hand.rake_amount ||
            0
          ),

        potAfterRake:
          Number(
            hand
              .pot_after_rake ||
            0
          ),

        winners:
          parseArray(
            hand
              .winner_summary_json
          )
      }
    });
  }


  /* ----------------------------------------------------------
     MUST BE SETTLING
     ---------------------------------------------------------- */

  if (
    hand.status !==
    "settling"
  ) {
    return json(
      {
        ok: false,

        error:
          "This poker hand is not ready to settle."
      },
      409
    );
  }


  /* ----------------------------------------------------------
     LOAD HAND PLAYERS
     ---------------------------------------------------------- */

  const playerResult =
    await DB.prepare(`
      SELECT
        hp.session_id,
        hp.player_id,
        hp.seat_number,

        hp.hole_cards_json,

        hp.total_contributed,

        hp.folded,
        hp.all_in,

        s.current_stack

      FROM poker_hand_players hp

      JOIN poker_sessions s
        ON s.id =
           hp.session_id

      WHERE hp.hand_id = ?

      ORDER BY
        hp.seat_number ASC
    `)
      .bind(
        handId
      )
      .all();


  const players =
    (
      playerResult.results ||
      []
    ).map(
      (row) => ({
        sessionId:
          row.session_id,

        playerId:
          row.player_id,

        seatNumber:
          Number(
            row.seat_number
          ),

        holeCards:
          parseArray(
            row
              .hole_cards_json
          ),

        totalContributed:
          Number(
            row
              .total_contributed ||
            0
          ),

        folded:
          Number(
            row.folded ||
            0
          ) === 1,

        allIn:
          Number(
            row.all_in ||
            0
          ) === 1,

        currentStack:
          Number(
            row.current_stack ||
            0
          )
      })
    );


  if (
    players.length < 2
  ) {
    return json(
      {
        ok: false,

        error:
          "Poker settlement requires at least two hand players."
      },
      409
    );
  }


  /* ----------------------------------------------------------
     BOARD / LIVE PLAYERS
     ---------------------------------------------------------- */

  const board =
    parseArray(
      hand.board_json
    );


  const livePlayers =
    players.filter(
      (player) =>
        !player.folded
    );


  if (
    livePlayers.length ===
    0
  ) {
    return json(
      {
        ok: false,

        error:
          "Poker hand has no eligible winner."
      },
      409
    );
  }


  /*
    Multiple live players means showdown.

    The board must have all five cards.
  */

  if (
    livePlayers.length > 1 &&
    board.length !== 5
  ) {
    return json(
      {
        ok: false,

        error:
          "Showdown cannot settle until the board contains five cards."
      },
      409
    );
  }


  /* ----------------------------------------------------------
     BUILD POT LAYERS
     ---------------------------------------------------------- */

  const {
    pots,
    uncalledReturns
  } =
    buildPotLayers(
      players
    );


  const grossPot =
    pots.reduce(
      (
        total,
        pot
      ) =>
        total +
        pot.grossAmount,

      0
    );


  /* ==========================================================
     RAKE

     One rake calculation across the entire hand.

     10% = 1000 basis points.

     Cap comes from poker_tables.

     No Flop, No Drop:
     preflop finish = 0 rake.
     ========================================================== */

  const rakeBasisPoints =
    Number(
      hand
        .rake_basis_points ||
      0
    );


  const rakeCap =
    Number(
      hand.rake_cap ||
      0
    );


  const flopDealt =
    Number(
      hand.flop_dealt ||
      0
    ) === 1;


  const noFlopNoDrop =
    Number(
      hand
        .no_flop_no_drop ||
      0
    ) === 1;


  const calculatedRake =
    noFlopNoDrop &&
    !flopDealt

      ? 0

      : Math.floor(
          grossPot *
          rakeBasisPoints /
          10000
        );


  const collectedRake =
    Math.max(
      0,

      Math.min(
        calculatedRake,
        rakeCap
      )
    );


/* ==========================================================
   DISTRIBUTE RAKE ACROSS ALL POTS PROPORTIONALLY

   The hand still has ONE rake calculation and ONE rake cap.

   This only determines how much of that rake belongs to
   each main/side pot so one winner is not unfairly charged
   the entire hand rake.
   ========================================================== */

const rakeByPot =
  pots.map(
    (pot) => {

      if (
        collectedRake <= 0 ||
        grossPot <= 0
      ) {
        return {
          rake: 0,
          remainder: 0
        };
      }


      const exactNumerator =
        collectedRake *
        pot.grossAmount;


      const rake =
        Math.floor(
          exactNumerator /
          grossPot
        );


      const remainder =
        exactNumerator %
        grossPot;


      return {
        rake,
        remainder
      };
    }
  );


/*
  Flooring can leave a few chips undistributed.

  Give those chips to pots with the largest fractional
  remainder so the final rake still equals collectedRake.
*/

let distributedRake =
  rakeByPot.reduce(
    (total, item) =>
      total +
      item.rake,

    0
  );


let rakeLeft =
  collectedRake -
  distributedRake;


const rakeRemainderOrder =
  rakeByPot
    .map(
      (item, index) => ({
        index,
        remainder:
          item.remainder
      })
    )
    .sort(
      (a, b) => {

        if (
          b.remainder !==
          a.remainder
        ) {
          return (
            b.remainder -
            a.remainder
          );
        }

        return (
          a.index -
          b.index
        );
      }
    );


for (
  let i = 0;
  i <
    rakeRemainderOrder.length &&
  rakeLeft > 0;
  i++
) {
  rakeByPot[
    rakeRemainderOrder[i]
      .index
  ].rake += 1;

  rakeLeft--;
}

  /* ----------------------------------------------------------
     PAYOUT MAPS
     ---------------------------------------------------------- */

  const payoutByPlayer =
    new Map();


  const evaluationByPlayer =
    new Map();


  const potRows =
    [];


  /* ==========================================================
     SETTLE EACH POT
     ========================================================== */

  for (
    let index = 0;
    index < pots.length;
    index++
  ) {
    const pot =
      pots[index];


    const rakeFromThisPot =
      Number(
        rakeByPot[index]
          ?.rake ||
        0
      );


    const netAmount =
      pot.grossAmount -
      rakeFromThisPot;


    const {
      winners,
      evaluations
    } =
      chooseWinners(
        pot.eligible,
        board
      );


    for (
      const [
        id,
        evaluation
      ] of
      evaluations.entries()
    ) {
      evaluationByPlayer.set(
        id,
        evaluation
      );
    }


    /* --------------------------------------------------------
       ODD CHIP ORDER
       -------------------------------------------------------- */

    const orderedWinners =
      clockwiseSeats(
        winners,

        Number(
          hand.dealer_seat
        )
      );


    const baseShare =
      Math.floor(
        netAmount /
        orderedWinners.length
      );


    let oddChips =
      netAmount %
      orderedWinners.length;


    const winnerDetails =
      [];


    for (
      const winner of
      orderedWinners
    ) {
      const extra =
        oddChips > 0
          ? 1
          : 0;


      if (
        oddChips > 0
      ) {
        oddChips--;
      }


      const payout =
        baseShare +
        extra;


      payoutByPlayer.set(
        winner.playerId,

        Number(
          payoutByPlayer.get(
            winner.playerId
          ) || 0
        ) +
        payout
      );


      winnerDetails.push({
        playerId:
          winner.playerId,

        seatNumber:
          winner.seatNumber,

        payout
      });
    }


    potRows.push({
      potNumber:
        index + 1,

      potType:
        index === 0
          ? "main"
          : "side",

      grossAmount:
        pot.grossAmount,

      rake:
        rakeFromThisPot,

      netAmount,

      eligible:
        pot.eligible.map(
          (player) => ({
            playerId:
              player.playerId,

            seatNumber:
              player.seatNumber
          })
        ),

      winners:
        winnerDetails
    });
  }


  /* ----------------------------------------------------------
     WINNER SUMMARY
     ---------------------------------------------------------- */

  const winnerSummary =
    players
      .map(
        (player) => {

          const payout =
            Number(
              payoutByPlayer.get(
                player.playerId
              ) || 0
            );


          const uncalledReturn =
            Number(
              uncalledReturns.get(
                player.playerId
              ) || 0
            );


          const evaluation =
            evaluationByPlayer.get(
              player.playerId
            ) || null;


          return {
            playerId:
              player.playerId,

            seatNumber:
              player.seatNumber,

            payout,

            uncalledReturn,

            totalCredit:
              payout +
              uncalledReturn,

            folded:
              player.folded,

            handName:
              evaluation?.name ||
              null
          };
        }
      )
      .filter(
        (entry) =>
          entry.payout > 0 ||
          entry.uncalledReturn >
            0
      );


  const netPot =
    grossPot -
    collectedRake;


  /* ==========================================================
     DATABASE BATCH
     ========================================================== */

  const statements =
    [];


  /*
    poker_pots has:

      PRIMARY KEY (
        hand_id,
        pot_number
      )

    This also protects against duplicate
    settlement attempts.
  */

  for (
    const pot of potRows
  ) {
    statements.push(
      DB.prepare(`
        INSERT INTO poker_pots (
          hand_id,
          pot_number,
          pot_type,

          amount,

          eligible_players_json,
          winners_json,

          payout_amount
        )

        VALUES (
          ?, ?, ?,
          ?,
          ?, ?,
          ?
        )
      `)
        .bind(
          handId,

          pot.potNumber,

          pot.potType,

          pot.grossAmount,

          JSON.stringify(
            pot.eligible
          ),

          JSON.stringify(
            pot.winners
          ),

          pot.netAmount
        )
    );
  }


  /* ----------------------------------------------------------
     RAKE AUDIT
     ---------------------------------------------------------- */

  statements.push(
    DB.prepare(`
      INSERT INTO poker_rake_log (
        hand_id,
        table_id,

        pot_before_rake,

        rake_basis_points,
        rake_cap,

        flop_dealt,

        calculated_rake,
        collected_rake
      )

      VALUES (
        ?, ?,
        ?,
        ?, ?,
        ?,
        ?, ?
      )
    `)
      .bind(
        handId,
        tableId,

        grossPot,

        rakeBasisPoints,
        rakeCap,

        flopDealt
          ? 1
          : 0,

        calculatedRake,
        collectedRake
      )
  );


  /* ==========================================================
     PLAYER PAYOUTS
     ========================================================== */

  for (
    const player of
    players
  ) {
    const payout =
      Number(
        payoutByPlayer.get(
          player.playerId
        ) || 0
      );


    const uncalledReturn =
      Number(
        uncalledReturns.get(
          player.playerId
        ) || 0
      );


    const totalCredit =
      payout +
      uncalledReturn;


    const endingStack =
      player.currentStack +
      totalCredit;


    const evaluation =
      evaluationByPlayer.get(
        player.playerId
      ) || null;


    let resultText;


    if (
      player.folded
    ) {
      resultText =
        "Folded";

    } else if (
      payout > 0 &&
      livePlayers.length === 1
    ) {
      resultText =
        `Won ${payout} by fold`;

    } else if (
      payout > 0
    ) {
      resultText =
        evaluation
          ? `Won ${payout} — ${evaluation.name}`
          : `Won ${payout}`;

    } else {
      resultText =
        evaluation
          ? `Lost — ${evaluation.name}`
          : "Lost";
    }


    if (
      uncalledReturn > 0
    ) {
      resultText +=
        `; ${uncalledReturn} returned`;
    }


    /* --------------------------------------------------------
       CREDIT TABLE STACK
       -------------------------------------------------------- */

    if (
      totalCredit > 0
    ) {
      statements.push(
        DB.prepare(`
          UPDATE poker_sessions

          SET
            current_stack =
              current_stack + ?,

            last_seen_at =
              CURRENT_TIMESTAMP

          WHERE id = ?
            AND player_id = ?
        `)
          .bind(
            totalCredit,

            player.sessionId,

            player.playerId
          )
      );
    }


    /* --------------------------------------------------------
       HAND PLAYER RESULT
       -------------------------------------------------------- */

    statements.push(
      DB.prepare(`
        UPDATE poker_hand_players

        SET
          winnings = ?,

          ending_stack = ?,

          showed_cards = ?,

          result_text = ?

        WHERE hand_id = ?
          AND player_id = ?
      `)
        .bind(
          payout,

          endingStack,

          livePlayers.length > 1 &&
          !player.folded
            ? 1
            : 0,

          resultText,

          handId,

          player.playerId
        )
    );
  }


  /* ==========================================================
     COMPLETE HAND
     ========================================================== */

  statements.push(
    DB.prepare(`
      UPDATE poker_hands

      SET
        status =
          'completed',

        pot_before_rake = ?,

        rake_amount = ?,

        pot_after_rake = ?,

        winner_summary_json = ?,

        current_turn_seat =
          NULL,

        action_deadline =
          NULL,

        ended_at =
          CURRENT_TIMESTAMP

      WHERE id = ?
        AND table_id = ?
        AND status =
          'settling'
    `)
      .bind(
        grossPot,

        collectedRake,

        netPot,

        JSON.stringify(
          winnerSummary
        ),

        handId,

        tableId
      )
  );


  /* ==========================================================
     COMMIT
     ========================================================== */

  try {
    await DB.batch(
      statements
    );

  } catch (error) {

    console.error(
      "Poker settlement batch failed:",
      error
    );


    const message =
      String(
        error?.message ||
        error ||
        ""
      );


    if (
      message.includes(
        "UNIQUE constraint failed"
      )
    ) {
      return json(
        {
          ok: false,

          error:
            "This poker hand was already settled or settlement is already in progress.",

          debug:
            message
        },
        409
      );
    }


    return json(
      {
        ok: false,

        error:
          "Poker hand could not be settled.",

        debug:
          message
      },
      409
    );
  }


  /* ==========================================================
     RESPONSE
     ========================================================== */

  return json({
    ok: true,

    message:
      "Poker hand settled.",

    hand: {
      id:
        handId,

      handNumber:
        Number(
          hand.hand_number
        ),

      status:
        "completed",

      potBeforeRake:
        grossPot,

      rake:
        collectedRake,

      potAfterRake:
        netPot,

      winners:
        winnerSummary
    },

    pots:
      potRows
  });
}


/* ============================================================
   CLOUDFLARE PAGES HANDLER
   ============================================================ */

export async function onRequest(
  context
) {
  try {

    if (
      context.request.method !==
      "POST"
    ) {
      return json(
        {
          ok: false,

          error:
            "Method not allowed."
        },
        405
      );
    }


    return await handlePost(
      context
    );


  } catch (error) {

    console.error(
      "Poker settlement backend error:",
      error
    );


    return json(
      {
        ok: false,

        error:
          "Poker settlement backend error.",

        debug:
          String(
            error?.message ||
            error ||
            ""
          )
      },
      500
    );
  }
}