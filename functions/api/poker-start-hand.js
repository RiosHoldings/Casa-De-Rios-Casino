/* ============================================================
   CASA DE RÍOS — TEXAS HOLD'EM
   /functions/api/poker-start-hand.js

   Responsibilities:
   - Authenticate seated player
   - Require at least 2 playable players
   - Prevent duplicate active hands
   - Rotate dealer button
   - Assign SB / BB
   - Securely shuffle 52-card deck
   - Deal 2 private cards per player
   - Post blinds
   - Set first player to act
   - Start 30-second turn timer
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
   IDS
   ============================================================ */

function makeId(prefix) {
  return (
    prefix +
    "-" +
    crypto.randomUUID()
  );
}


/* ============================================================
   SECURE RANDOM NUMBER
   ============================================================ */

function secureRandomInt(max) {
  if (
    !Number.isInteger(max) ||
    max <= 0
  ) {
    throw new Error(
      "Invalid random range."
    );
  }

  const maxUint =
    0x100000000;

  const limit =
    maxUint -
    (maxUint % max);

  const values =
    new Uint32Array(1);

  do {
    crypto.getRandomValues(
      values
    );
  } while (
    values[0] >= limit
  );

  return values[0] % max;
}


/* ============================================================
   DECK
   ============================================================ */

function makeDeck() {
  const ranks = [
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "T",
    "J",
    "Q",
    "K",
    "A"
  ];

  const suits = [
    "C",
    "D",
    "H",
    "S"
  ];

  const deck = [];

  for (
    const suit of suits
  ) {
    for (
      const rank of ranks
    ) {
      deck.push(
        rank + suit
      );
    }
  }

  return deck;
}


function shuffleDeck(deck) {
  const shuffled =
    [...deck];

  for (
    let i =
      shuffled.length - 1;
    i > 0;
    i--
  ) {
    const j =
      secureRandomInt(
        i + 1
      );

    [
      shuffled[i],
      shuffled[j]
    ] = [
      shuffled[j],
      shuffled[i]
    ];
  }

  return shuffled;
}


/* ============================================================
   SEAT HELPERS
   ============================================================ */

function sortedSeats(players) {
  return players
    .map(
      (player) =>
        Number(
          player.seat_number
        )
    )
    .sort(
      (a, b) =>
        a - b
    );
}


function nextSeat(
  seats,
  afterSeat
) {
  if (!seats.length) {
    return null;
  }

  const next =
    seats.find(
      (seat) =>
        seat > afterSeat
    );

  return (
    next ??
    seats[0]
  );
}


function playerAtSeat(
  players,
  seat
) {
  return players.find(
    (player) =>
      Number(
        player.seat_number
      ) ===
      Number(seat)
  );
}


/* ============================================================
   DEAL ORDER

   Cards are dealt clockwise beginning left of dealer.
   ============================================================ */

function dealOrder(
  players,
  dealerSeat
) {
  const seats =
    sortedSeats(
      players
    );

  const ordered = [];

  let seat =
    nextSeat(
      seats,
      dealerSeat
    );

  while (
    ordered.length <
    seats.length
  ) {
    const player =
      playerAtSeat(
        players,
        seat
      );

    if (player) {
      ordered.push(
        player
      );
    }

    seat =
      nextSeat(
        seats,
        seat
      );
  }

  return ordered;
}


/* ============================================================
   NEXT ACTIONABLE PLAYER
   ============================================================ */

function nextActionableSeat(
  players,
  afterSeat,
  stackAfterBlind
) {
  const seats =
    sortedSeats(
      players
    );

  let seat =
    nextSeat(
      seats,
      afterSeat
    );

  for (
    let i = 0;
    i < seats.length;
    i++
  ) {
    const stack =
      Number(
        stackAfterBlind.get(
          seat
        ) || 0
      );

    if (stack > 0) {
      return seat;
    }

    seat =
      nextSeat(
        seats,
        seat
      );
  }

  return null;
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
      await context.request.json();
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
      body.playerId || ""
    ).trim();

  const playerSecret =
    String(
      body.playerSecret || ""
    ).trim();

  const tableId =
    String(
      body.tableId ||
      "poker-room-1"
    ).trim();


  if (
    !playerId ||
    !playerSecret ||
    !tableId
  ) {
    return json(
      {
        ok: false,
        error:
          "Missing poker credentials."
      },
      400
    );
  }


  /* ----------------------------------------------------------
     TABLE
     ---------------------------------------------------------- */

  const table =
    await DB.prepare(`
      SELECT
        id,
        name,
        max_players,
        small_blind,
        big_blind,
        turn_seconds,
        status,
        hand_counter
      FROM poker_tables
      WHERE id = ?
      LIMIT 1
    `)
      .bind(tableId)
      .first();


  if (!table) {
    return json(
      {
        ok: false,
        error:
          "Poker table not found."
      },
      404
    );
  }


  if (
    table.status !==
    "open"
  ) {
    return json(
      {
        ok: false,
        error:
          "Poker table is not open."
      },
      409
    );
  }


  /* ----------------------------------------------------------
     AUTHENTICATE REQUESTING PLAYER

     They must actually be seated at this table.
     ---------------------------------------------------------- */

  const requestingPlayer =
    await DB.prepare(`
      SELECT
        p.id AS player_id,
        p.status AS player_status,

        s.id AS session_id,
        s.seat_number,
        s.current_stack,
        s.status AS session_status

      FROM players p

      JOIN poker_sessions s
        ON s.player_id = p.id

      WHERE p.id = ?
        AND p.player_secret = ?
        AND s.table_id = ?
        AND s.status = 'seated'

      LIMIT 1
    `)
      .bind(
        playerId,
        playerSecret,
        tableId
      )
      .first();


  if (!requestingPlayer) {
    return json(
      {
        ok: false,
        error:
          "You are not an active player at this poker table."
      },
      401
    );
  }


  if (
    requestingPlayer
      .player_status !==
    "active"
  ) {
    return json(
      {
        ok: false,
        error:
          "Player account is not active."
      },
      409
    );
  }


  /* ----------------------------------------------------------
     EXISTING ACTIVE HAND
     ---------------------------------------------------------- */

  const existingHand =
    await DB.prepare(`
      SELECT
        id,
        hand_number,
        dealer_seat,
        small_blind_seat,
        big_blind_seat,
        current_turn_seat,
        street_reached,
        action_deadline,
        status

      FROM poker_hands

      WHERE table_id = ?
        AND status IN (
          'active',
          'settling'
        )

      ORDER BY
        hand_number DESC

      LIMIT 1
    `)
      .bind(tableId)
      .first();


  if (existingHand) {
    return json(
      {
        ok: false,

        error:
          "A poker hand is already active.",

        activeHand: {
          id:
            existingHand.id,

          handNumber:
            Number(
              existingHand
                .hand_number
            ),

          dealerSeat:
            Number(
              existingHand
                .dealer_seat
            ),

          smallBlindSeat:
            Number(
              existingHand
                .small_blind_seat
            ),

          bigBlindSeat:
            Number(
              existingHand
                .big_blind_seat
            ),

          currentTurnSeat:
            existingHand
              .current_turn_seat ===
              null
              ? null
              : Number(
                  existingHand
                    .current_turn_seat
                ),

          street:
            existingHand
              .street_reached,

          actionDeadline:
            existingHand
              .action_deadline
        }
      },
      409
    );
  }


  /* ----------------------------------------------------------
     PLAYERS ELIGIBLE FOR THIS HAND
     ---------------------------------------------------------- */

  const playerResult =
    await DB.prepare(`
      SELECT
        id AS session_id,
        player_id,
        seat_number,
        current_stack

      FROM poker_sessions

      WHERE table_id = ?
        AND status = 'seated'
        AND current_stack > 0

      ORDER BY
        seat_number ASC
    `)
      .bind(tableId)
      .all();


  const players =
    playerResult.results ||
    [];


  if (
    players.length < 2
  ) {
    return json(
      {
        ok: false,
        error:
          "At least two players with chips are required to start a hand."
      },
      409
    );
  }


  /* ----------------------------------------------------------
     PREVIOUS DEALER
     ---------------------------------------------------------- */

  const previousHand =
    await DB.prepare(`
      SELECT
        dealer_seat

      FROM poker_hands

      WHERE table_id = ?
        AND status = 'completed'

      ORDER BY
        hand_number DESC

      LIMIT 1
    `)
      .bind(tableId)
      .first();


  const seats =
    sortedSeats(
      players
    );


  let dealerSeat;


  if (
    previousHand &&
    previousHand
      .dealer_seat !==
      null
  ) {
    dealerSeat =
      nextSeat(
        seats,
        Number(
          previousHand
            .dealer_seat
        )
      );
  } else {
    dealerSeat =
      seats[
        secureRandomInt(
          seats.length
        )
      ];
  }


  /* ----------------------------------------------------------
     BLIND POSITIONS

     Heads-up:
       Dealer = Small Blind
       Other player = Big Blind
       Dealer acts first preflop

     3+:
       SB = left of dealer
       BB = left of SB
       UTG = left of BB
     ---------------------------------------------------------- */

  let smallBlindSeat;
  let bigBlindSeat;


  if (
    players.length === 2
  ) {
    smallBlindSeat =
      dealerSeat;

    bigBlindSeat =
      nextSeat(
        seats,
        dealerSeat
      );
  } else {
    smallBlindSeat =
      nextSeat(
        seats,
        dealerSeat
      );

    bigBlindSeat =
      nextSeat(
        seats,
        smallBlindSeat
      );
  }


  const smallBlindPlayer =
    playerAtSeat(
      players,
      smallBlindSeat
    );

  const bigBlindPlayer =
    playerAtSeat(
      players,
      bigBlindSeat
    );


  if (
    !smallBlindPlayer ||
    !bigBlindPlayer
  ) {
    return json(
      {
        ok: false,
        error:
          "Could not determine blind positions."
      },
      500
    );
  }


  const smallBlind =
    Number(
      table.small_blind
    );

  const bigBlind =
    Number(
      table.big_blind
    );


  const smallBlindPosted =
    Math.min(
      smallBlind,
      Number(
        smallBlindPlayer
          .current_stack
      )
    );


  const bigBlindPosted =
    Math.min(
      bigBlind,
      Number(
        bigBlindPlayer
          .current_stack
      )
    );


  /* ----------------------------------------------------------
     CREATE + SHUFFLE DECK
     ---------------------------------------------------------- */

  const deck =
    shuffleDeck(
      makeDeck()
    );


  /* ----------------------------------------------------------
     DEAL HOLE CARDS

     Two rounds around the table.
     ---------------------------------------------------------- */

  const order =
    dealOrder(
      players,
      dealerSeat
    );


  const holeCards =
    new Map();


  for (
    const player of players
  ) {
    holeCards.set(
      player.player_id,
      []
    );
  }


  for (
    let round = 0;
    round < 2;
    round++
  ) {
    for (
      const player of order
    ) {
      const cards =
        holeCards.get(
          player.player_id
        );

      cards.push(
        deck.shift()
      );
    }
  }


  /* ----------------------------------------------------------
     STACKS AFTER FORCED BLINDS
     ---------------------------------------------------------- */

  const stackAfterBlind =
    new Map();


  for (
    const player of players
  ) {
    let stack =
      Number(
        player.current_stack
      );

    if (
      Number(
        player.seat_number
      ) ===
      smallBlindSeat
    ) {
      stack -=
        smallBlindPosted;
    }

    if (
      Number(
        player.seat_number
      ) ===
      bigBlindSeat
    ) {
      stack -=
        bigBlindPosted;
    }

    stackAfterBlind.set(
      Number(
        player.seat_number
      ),
      Math.max(
        0,
        stack
      )
    );
  }


  /* ----------------------------------------------------------
     FIRST PLAYER TO ACT
     ---------------------------------------------------------- */

  let currentTurnSeat;


  if (
    players.length === 2
  ) {
    /*
      Heads-up:
      dealer / small blind acts first preflop.
    */

    if (
      Number(
        stackAfterBlind.get(
          dealerSeat
        ) || 0
      ) > 0
    ) {
      currentTurnSeat =
        dealerSeat;
    } else {
      currentTurnSeat =
        nextActionableSeat(
          players,
          dealerSeat,
          stackAfterBlind
        );
    }

  } else {
    currentTurnSeat =
      nextActionableSeat(
        players,
        bigBlindSeat,
        stackAfterBlind
      );
  }


  /* ----------------------------------------------------------
     TURN DEADLINE
     ---------------------------------------------------------- */

  const turnSeconds =
    Number(
      table.turn_seconds ||
      30
    );


  const actionDeadline =
    currentTurnSeat === null
      ? null
      : new Date(
          Date.now() +
          turnSeconds * 1000
        ).toISOString();


  /* ----------------------------------------------------------
     HAND DATA
     ---------------------------------------------------------- */

  const handNumber =
    Number(
      table.hand_counter ||
      0
    ) + 1;


  const handId =
    makeId("PKH");


  const initialPot =
    smallBlindPosted +
    bigBlindPosted;


  /* ----------------------------------------------------------
     INSERT HAND
     ---------------------------------------------------------- */

  const statements = [];


  statements.push(
    DB.prepare(`
      INSERT INTO poker_hands (
        id,
        table_id,
        hand_number,

        dealer_seat,
        small_blind_seat,
        big_blind_seat,

        status,
        street_reached,
        flop_dealt,

        board_json,

        pot_before_rake,
        rake_amount,
        pot_after_rake,

        winner_summary_json,

        deck_json,

        current_turn_seat,
        current_bet,
        min_raise,
        last_raiser_seat,

        action_deadline
      )

      VALUES (
        ?,
        ?,
        ?,

        ?,
        ?,
        ?,

        'active',
        'preflop',
        0,

        '[]',

        ?,
        0,
        ?,

        '[]',

        ?,

        ?,
        ?,
        ?,
        NULL,

        ?
      )
    `)
      .bind(
        handId,
        tableId,
        handNumber,

        dealerSeat,
        smallBlindSeat,
        bigBlindSeat,

        initialPot,
        initialPot,

        JSON.stringify(
          deck
        ),

        currentTurnSeat,
        bigBlind,
        bigBlind,

        actionDeadline
      )
  );


  /* ----------------------------------------------------------
     UPDATE TABLE HAND COUNTER
     ---------------------------------------------------------- */

  statements.push(
    DB.prepare(`
      UPDATE poker_tables

      SET
        hand_counter = ?,
        updated_at =
          CURRENT_TIMESTAMP

      WHERE id = ?
        AND hand_counter = ?
    `)
      .bind(
        handNumber,
        tableId,
        Number(
          table.hand_counter ||
          0
        )
      )
  );


  /* ----------------------------------------------------------
     HAND PLAYER ROWS
     ---------------------------------------------------------- */

  for (
    const player of players
  ) {
    const seat =
      Number(
        player.seat_number
      );

    const startingStack =
      Number(
        player.current_stack
      );


    let contribution = 0;
    let lastAction = null;


    if (
      seat ===
      smallBlindSeat
    ) {
      contribution =
        smallBlindPosted;

      lastAction =
        "post_small_blind";
    }


    if (
      seat ===
      bigBlindSeat
    ) {
      contribution =
        bigBlindPosted;

      lastAction =
        "post_big_blind";
    }


    const remainingStack =
      Number(
        stackAfterBlind.get(
          seat
        ) || 0
      );


    const allIn =
      remainingStack === 0
        ? 1
        : 0;


    statements.push(
      DB.prepare(`
        INSERT INTO poker_hand_players (
          hand_id,
          session_id,
          player_id,
          seat_number,

          starting_stack,
          hole_cards_json,

          total_contributed,
          winnings,
          ending_stack,

          folded,
          all_in,
          showed_cards,

          result_text,

          street_contributed,
          acted_this_round,
          last_action
        )

        VALUES (
          ?,
          ?,
          ?,
          ?,

          ?,
          ?,

          ?,
          0,
          0,

          0,
          ?,
          0,

          NULL,

          ?,
          0,
          ?
        )
      `)
        .bind(
          handId,
          player.session_id,
          player.player_id,
          seat,

          startingStack,

          JSON.stringify(
            holeCards.get(
              player.player_id
            )
          ),

          contribution,
          allIn,
          contribution,
          lastAction
        )
    );
  }


  /* ----------------------------------------------------------
     REMOVE BLINDS FROM TABLE STACKS
     ---------------------------------------------------------- */

  statements.push(
    DB.prepare(`
      UPDATE poker_sessions

      SET current_stack =
        current_stack - ?

      WHERE id = ?
        AND table_id = ?
        AND status = 'seated'
        AND current_stack >= ?
    `)
      .bind(
        smallBlindPosted,
        smallBlindPlayer
          .session_id,
        tableId,
        smallBlindPosted
      )
  );


  statements.push(
    DB.prepare(`
      UPDATE poker_sessions

      SET current_stack =
        current_stack - ?

      WHERE id = ?
        AND table_id = ?
        AND status = 'seated'
        AND current_stack >= ?
    `)
      .bind(
        bigBlindPosted,
        bigBlindPlayer
          .session_id,
        tableId,
        bigBlindPosted
      )
  );


  /* ----------------------------------------------------------
     AUDIT — SMALL BLIND
     ---------------------------------------------------------- */

  statements.push(
    DB.prepare(`
      INSERT INTO poker_actions (
        hand_id,
        session_id,
        player_id,

        sequence_number,
        seat_number,
        street,
        action,

        amount,
        to_amount,

        pot_after,
        stack_after
      )

      VALUES (
        ?,
        ?,
        ?,

        1,
        ?,
        'preflop',
        'post_small_blind',

        ?,
        ?,

        ?,
        ?
      )
    `)
      .bind(
        handId,

        smallBlindPlayer
          .session_id,

        smallBlindPlayer
          .player_id,

        smallBlindSeat,

        smallBlindPosted,
        smallBlindPosted,

        smallBlindPosted,

        Number(
          stackAfterBlind.get(
            smallBlindSeat
          ) || 0
        )
      )
  );


  /* ----------------------------------------------------------
     AUDIT — BIG BLIND
     ---------------------------------------------------------- */

  statements.push(
    DB.prepare(`
      INSERT INTO poker_actions (
        hand_id,
        session_id,
        player_id,

        sequence_number,
        seat_number,
        street,
        action,

        amount,
        to_amount,

        pot_after,
        stack_after
      )

      VALUES (
        ?,
        ?,
        ?,

        2,
        ?,
        'preflop',
        'post_big_blind',

        ?,
        ?,

        ?,
        ?
      )
    `)
      .bind(
        handId,

        bigBlindPlayer
          .session_id,

        bigBlindPlayer
          .player_id,

        bigBlindSeat,

        bigBlindPosted,
        bigBlindPosted,

        initialPot,

        Number(
          stackAfterBlind.get(
            bigBlindSeat
          ) || 0
        )
      )
  );


  /* ----------------------------------------------------------
     COMMIT HAND
     ---------------------------------------------------------- */

  try {
    await DB.batch(
      statements
    );
  } catch (error) {
    console.error(
      "poker-start-hand batch failed:",
      error
    );


    const message =
      String(
        error?.message ||
        error ||
        ""
      );


    /*
      Another player may have started the exact same hand
      milliseconds earlier.

      The unique active-hand index protects us here.
    */

    if (
      message.includes(
        "idx_poker_one_active_hand"
      ) ||
      message.includes(
        "UNIQUE constraint failed"
      )
    ) {
      const active =
        await DB.prepare(`
          SELECT
            id,
            hand_number,
            dealer_seat,
            small_blind_seat,
            big_blind_seat,
            current_turn_seat,
            action_deadline

          FROM poker_hands

          WHERE table_id = ?
            AND status IN (
              'active',
              'settling'
            )

          ORDER BY
            hand_number DESC

          LIMIT 1
        `)
          .bind(tableId)
          .first();


      return json(
        {
          ok: false,

          error:
            "A poker hand was already started.",

          activeHand:
            active || null
        },
        409
      );
    }


    return json(
      {
        ok: false,

        error:
          "Could not start poker hand.",

        debug:
          message
      },
      500
    );
  }


  /* ----------------------------------------------------------
     PRIVATE RESPONSE

     Only return THIS player's own hole cards.
     Never return the full deck or other players' cards.
     ---------------------------------------------------------- */

  return json(
    {
      ok: true,

      message:
        `Hand #${handNumber} started.`,

      hand: {
        id:
          handId,

        handNumber,

        dealerSeat,
        smallBlindSeat,
        bigBlindSeat,

        smallBlind,
        bigBlind,

        currentTurnSeat,

        currentBet:
          bigBlind,

        minRaise:
          bigBlind,

        pot:
          initialPot,

        street:
          "preflop",

        board: [],

        actionDeadline
      },

      yourCards:
        holeCards.get(
          playerId
        ) || [],

      players:
        players.map(
          (player) => ({
            seatNumber:
              Number(
                player.seat_number
              ),

            stack:
              Number(
                stackAfterBlind.get(
                  Number(
                    player.seat_number
                  )
                ) || 0
              )
          })
        )
    }
  );
}


/* ============================================================
   ONLY EXPORTED HANDLER

   Keep this pattern.
   Do not also export onRequestPost.
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
      "poker-start-hand backend error:",
      error
    );

    return json(
      {
        ok: false,

        error:
          "Poker start-hand backend error.",

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