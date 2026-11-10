/* ============================================================
   CASA DE RÍOS — TEXAS HOLD'EM
   /functions/api/poker-action.js

   Actions:
   - fold
   - check
   - call
   - bet
   - raise
   - all_in

   IMPORTANT:
   - All chip math is server-side.
   - "amount" for BET / RAISE means the TOTAL street amount.
     Example:
       current bet = 200
       raise to 600
       amount = 600
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
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}


/* ============================================================
   HELPERS
   ============================================================ */

function parseArray(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value;
  }

  try {
    const parsed = JSON.parse(value);

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch {
    return [];
  }
}


function positiveInteger(value) {
  const number = Number(value);

  if (
    !Number.isInteger(number) ||
    number <= 0
  ) {
    return null;
  }

  return number;
}


function nextClockwise(
  players,
  fromSeat,
  predicate
) {
  const sorted =
    [...players].sort(
      (a, b) =>
        a.seatNumber -
        b.seatNumber
    );

  if (!sorted.length) {
    return null;
  }

  const after =
    sorted.filter(
      (player) =>
        player.seatNumber >
        fromSeat
    );

  const before =
    sorted.filter(
      (player) =>
        player.seatNumber <=
        fromSeat
    );

  const ordered = [
    ...after,
    ...before
  ];

  const found =
    ordered.find(predicate);

  return found
    ? found.seatNumber
    : null;
}


function deadlineFromNow(seconds) {
  return new Date(
    Date.now() +
    Number(seconds || 30) *
    1000
  ).toISOString();
}


/* ============================================================
   STREET DEALING
   ============================================================ */

function dealNextStreet(
  currentStreet,
  deck,
  board
) {
  const nextDeck =
    [...deck];

  const nextBoard =
    [...board];


  if (currentStreet === "preflop") {
    /*
      Burn one.
    */

    nextDeck.shift();

    /*
      Flop.
    */

    nextBoard.push(
      nextDeck.shift(),
      nextDeck.shift(),
      nextDeck.shift()
    );

    return {
      street: "flop",
      deck: nextDeck,
      board: nextBoard,
      flopDealt: 1
    };
  }


  if (currentStreet === "flop") {
    nextDeck.shift();

    nextBoard.push(
      nextDeck.shift()
    );

    return {
      street: "turn",
      deck: nextDeck,
      board: nextBoard,
      flopDealt: 1
    };
  }


  if (currentStreet === "turn") {
    nextDeck.shift();

    nextBoard.push(
      nextDeck.shift()
    );

    return {
      street: "river",
      deck: nextDeck,
      board: nextBoard,
      flopDealt: 1
    };
  }


  return {
    street: currentStreet,
    deck: nextDeck,
    board: nextBoard,
    flopDealt:
      currentStreet ===
      "preflop"
        ? 0
        : 1
  };
}


/* ============================================================
   AUTOMATIC ALL-IN RUNOUT
   ============================================================ */

function runBoardToRiver(
  currentStreet,
  deck,
  board
) {
  let street =
    currentStreet;

  let remainingDeck =
    [...deck];

  let finalBoard =
    [...board];

  let flopDealt =
    street === "preflop"
      ? 0
      : 1;


  while (
    street !== "river"
  ) {
    const dealt =
      dealNextStreet(
        street,
        remainingDeck,
        finalBoard
      );

    street =
      dealt.street;

    remainingDeck =
      dealt.deck;

    finalBoard =
      dealt.board;

    flopDealt =
      dealt.flopDealt;
  }


  return {
    street,
    deck: remainingDeck,
    board: finalBoard,
    flopDealt
  };
}

/* ============================================================
   EXPIRED TURN PROCESSING

   Timeout rule:
   - Check if checking is legal.
   - Otherwise fold.
   ============================================================ */

async function processExpiredTurn(
  DB,
  hand,
  players
) {
  if (
    !hand.action_deadline ||
    hand.current_turn_seat === null ||
    hand.current_turn_seat === undefined
  ) {
    return null;
  }


  const deadlineMs =
    Date.parse(
      hand.action_deadline
    );


  if (
    !Number.isFinite(deadlineMs) ||
    Date.now() < deadlineMs
  ) {
    return null;
  }


  const timedSeat =
    Number(
      hand.current_turn_seat
    );


  const timedPlayer =
    players.find(
      (player) =>
        player.seatNumber ===
        timedSeat
    );


  if (
    !timedPlayer ||
    timedPlayer.folded ||
    timedPlayer.allIn
  ) {
    return null;
  }


  const currentBet =
    Number(
      hand.current_bet ||
      0
    );


  const callRequired =
    Math.max(
      0,
      currentBet -
      timedPlayer.streetContributed
    );


  const timeoutAction =
    callRequired === 0
      ? "timeout_check"
      : "timeout_fold";


  /* ----------------------------------------------------------
     COPY PLAYER STATE
     ---------------------------------------------------------- */

  const updatedPlayers =
    players.map(
      (player) => ({
        ...player
      })
    );


  const updatedTimedPlayer =
    updatedPlayers.find(
      (player) =>
        player.seatNumber ===
        timedSeat
    );


  updatedTimedPlayer.acted =
    true;

  updatedTimedPlayer.lastAction =
    timeoutAction;


  if (
    timeoutAction ===
    "timeout_fold"
  ) {
    updatedTimedPlayer.folded =
      true;
  }


  /* ----------------------------------------------------------
     HAND STATE
     ---------------------------------------------------------- */

  const remainingPlayers =
    updatedPlayers.filter(
      (player) =>
        !player.folded
    );


  let nextTurnSeat = null;

  let newStreet =
    hand.street_reached;

  let board =
    parseArray(
      hand.board_json
    );

  let deck =
    parseArray(
      hand.deck_json
    );

  let flopDealt =
    Number(
      hand.flop_dealt ||
      0
    );

  let newCurrentBet =
    currentBet;

  let newMinRaise =
    Number(
      hand.min_raise ||
      hand.big_blind ||
      200
    );

  let newLastRaiser =
    hand.last_raiser_seat;

  let status =
    "active";

  let resetStreetPlayers =
    false;


  /* ----------------------------------------------------------
     ONLY ONE PLAYER REMAINS
     ---------------------------------------------------------- */

  if (
    remainingPlayers.length <= 1
  ) {
    status =
      "settling";

  } else {

    const playersAbleToAct =
      remainingPlayers.filter(
        (player) =>
          !player.allIn
      );


    const roundComplete =
      playersAbleToAct.every(
        (player) =>
          player.acted &&
          player.streetContributed ===
            newCurrentBet
      );


    /* --------------------------------------------------------
       ROUND COMPLETE
       -------------------------------------------------------- */

    if (roundComplete) {

      if (
        newStreet ===
        "river"
      ) {
        status =
          "settling";

      } else if (
        playersAbleToAct.length <=
        1
      ) {

        /*
          Nobody can make another betting decision.
          Run the remaining board automatically.
        */

        const runout =
          runBoardToRiver(
            newStreet,
            deck,
            board
          );


        newStreet =
          runout.street;

        deck =
          runout.deck;

        board =
          runout.board;

        flopDealt =
          runout.flopDealt;

        status =
          "settling";

      } else {

        /*
          Advance one street.
        */

        const dealt =
          dealNextStreet(
            newStreet,
            deck,
            board
          );


        newStreet =
          dealt.street;

        deck =
          dealt.deck;

        board =
          dealt.board;

        flopDealt =
          dealt.flopDealt;


        newCurrentBet = 0;

        newMinRaise =
          Number(
            hand.big_blind
          );

        newLastRaiser =
          null;

        resetStreetPlayers =
          true;


        /*
          First post-flop action:
          clockwise from dealer.
        */

        nextTurnSeat =
          nextClockwise(
            updatedPlayers,
            Number(
              hand.dealer_seat
            ),
            (player) =>
              !player.folded &&
              !player.allIn
          );
      }

    } else {

      /* ------------------------------------------------------
         SAME STREET
         ------------------------------------------------------ */

      nextTurnSeat =
        nextClockwise(
          updatedPlayers,
          timedSeat,
          (player) =>
            !player.folded &&
            !player.allIn &&
            (
              !player.acted ||
              player.streetContributed <
                newCurrentBet
            )
        );
    }
  }


  /* ----------------------------------------------------------
     NEW DEADLINE
     ---------------------------------------------------------- */

  const actionDeadline =
    status === "active" &&
    nextTurnSeat !== null
      ? deadlineFromNow(
          hand.turn_seconds
        )
      : null;


  /* ----------------------------------------------------------
     ACTION SEQUENCE
     ---------------------------------------------------------- */

  const sequenceRow =
    await DB.prepare(`
      SELECT
        COALESCE(
          MAX(sequence_number),
          0
        ) AS max_sequence

      FROM poker_actions

      WHERE hand_id = ?
    `)
      .bind(hand.id)
      .first();


  const sequenceNumber =
    Number(
      sequenceRow?.max_sequence ||
      0
    ) + 1;


  const statements = [];


  /* ----------------------------------------------------------
     AUDIT TIMEOUT
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
        ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?
      )
    `)
      .bind(
        hand.id,

        timedPlayer.sessionId,
        timedPlayer.playerId,

        sequenceNumber,
        timedSeat,

        hand.street_reached,
        timeoutAction,

        0,
        timedPlayer.streetContributed,

        Number(
          hand.pot_before_rake ||
          0
        ),

        timedPlayer.currentStack
      )
  );


  /* ----------------------------------------------------------
     UPDATE TIMED PLAYER
     ---------------------------------------------------------- */

  statements.push(
    DB.prepare(`
      UPDATE poker_hand_players

      SET
        folded =
          CASE
            WHEN ? = 1
              THEN 1
            ELSE folded
          END,

        acted_this_round = 1,
        last_action = ?

      WHERE hand_id = ?
        AND player_id = ?
    `)
      .bind(
        timeoutAction ===
          "timeout_fold"
          ? 1
          : 0,

        timeoutAction,

        hand.id,
        timedPlayer.playerId
      )
  );


  /* ----------------------------------------------------------
     RESET NEW STREET
     ---------------------------------------------------------- */

  if (
    resetStreetPlayers
  ) {
    statements.push(
      DB.prepare(`
        UPDATE poker_hand_players

        SET
          street_contributed = 0,
          acted_this_round = 0,
          last_action = NULL

        WHERE hand_id = ?
      `)
        .bind(
          hand.id
        )
    );
  }


  /* ----------------------------------------------------------
     UPDATE HAND
     ---------------------------------------------------------- */

  statements.push(
    DB.prepare(`
      UPDATE poker_hands

      SET
        status = ?,

        street_reached = ?,
        flop_dealt = ?,

        board_json = ?,
        deck_json = ?,

        current_turn_seat = ?,
        current_bet = ?,
        min_raise = ?,
        last_raiser_seat = ?,

        action_deadline = ?

      WHERE id = ?
        AND status = 'active'
        AND current_turn_seat = ?
    `)
      .bind(
        status,

        newStreet,
        flopDealt,

        JSON.stringify(
          board
        ),

        JSON.stringify(
          deck
        ),

        nextTurnSeat,

        newCurrentBet,
        newMinRaise,
        newLastRaiser,

        actionDeadline,

        hand.id,
        timedSeat
      )
  );


  await DB.batch(
    statements
  );


  return {
    processed: true,

    timedOutSeat:
      timedSeat,

    timeoutAction,

    status,

    street:
      newStreet,

    board,

    currentTurnSeat:
      nextTurnSeat,

    currentBet:
      newCurrentBet,

    minRaise:
      newMinRaise,

    actionDeadline
  };
}

/* ============================================================
   POST
   ============================================================ */

async function handlePost(context) {
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

  const handId =
    String(
      body.handId || ""
    ).trim();

  const action =
    String(
      body.action || ""
    )
      .trim()
      .toLowerCase();


  const allowedActions = [
    "fold",
    "check",
    "call",
    "bet",
    "raise",
    "all_in"
  ];


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
          "Missing poker action information."
      },
      400
    );
  }


  if (
    !allowedActions.includes(
      action
    )
  ) {
    return json(
      {
        ok: false,
        error:
          "Invalid poker action."
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
        id,
        status

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
     HAND + TABLE
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
        h.deck_json,

        h.flop_dealt,

        h.pot_before_rake,
        h.pot_after_rake,

        h.current_turn_seat,
        h.current_bet,
        h.min_raise,
        h.last_raiser_seat,
        h.action_deadline,

        t.big_blind,
        t.turn_seconds

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


  if (
    hand.status !== "active"
  ) {
    return json(
      {
        ok: false,
        error:
          "This hand is no longer accepting actions."
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

        hp.starting_stack,

        hp.total_contributed,
        hp.street_contributed,

        hp.folded,
        hp.all_in,

        hp.acted_this_round,
        hp.last_action,

        s.current_stack,
        s.status AS session_status

      FROM poker_hand_players hp

      JOIN poker_sessions s
        ON s.id =
           hp.session_id

      WHERE hp.hand_id = ?

      ORDER BY
        hp.seat_number ASC
    `)
      .bind(handId)
      .all();


  const rawPlayers =
    playerResult.results ||
    [];


  const players =
    rawPlayers.map(
      (row) => ({
        sessionId:
          row.session_id,

        playerId:
          row.player_id,

        seatNumber:
          Number(
            row.seat_number
          ),

        currentStack:
          Number(
            row.current_stack ||
            0
          ),

        totalContributed:
          Number(
            row.total_contributed ||
            0
          ),

        streetContributed:
          Number(
            row.street_contributed ||
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

        acted:
          Number(
            row.acted_this_round ||
            0
          ) === 1,

        lastAction:
          row.last_action ||
          null,

        sessionStatus:
          row.session_status
      })
    );


  const player =
    players.find(
      (item) =>
        item.playerId ===
        playerId
    );


  if (!player) {
    return json(
      {
        ok: false,
        error:
          "You are not part of this poker hand."
      },
      403
    );
  }


  if (
    player.sessionStatus !==
    "seated"
  ) {
    return json(
      {
        ok: false,
        error:
          "Your poker session is not active."
      },
      409
    );
  }


  if (
    player.folded ||
    player.allIn
  ) {
    return json(
      {
        ok: false,
        error:
          "You cannot act in this hand."
      },
      409
    );
  }


/* ----------------------------------------------------------
   RESOLVE EXPIRED TURN FIRST
   ---------------------------------------------------------- */

const timeoutResult =
  await processExpiredTurn(
    DB,
    hand,
    players
  );


if (timeoutResult) {
  return json(
    {
      ok: false,

      timeoutProcessed:
        true,

      error:
        timeoutResult.timeoutAction ===
        "timeout_fold"
          ? `Seat ${timeoutResult.timedOutSeat} timed out and folded. Retry your action.`
          : `Seat ${timeoutResult.timedOutSeat} timed out and checked. Retry your action.`,

      timedOutSeat:
        timeoutResult.timedOutSeat,

      timeoutAction:
        timeoutResult.timeoutAction,

      hand: {
        status:
          timeoutResult.status,

        street:
          timeoutResult.street,

        board:
          timeoutResult.board,

        currentTurnSeat:
          timeoutResult.currentTurnSeat,

        currentBet:
          timeoutResult.currentBet,

        minRaise:
          timeoutResult.minRaise,

        actionDeadline:
          timeoutResult.actionDeadline
      }
    },
    409
  );
}


/* ----------------------------------------------------------
   NORMAL TURN CHECK
   ---------------------------------------------------------- */

if (
  Number(
    hand.current_turn_seat
  ) !==
  player.seatNumber
) {
  return json(
    {
      ok: false,

      error:
        "It is not your turn.",

      currentTurnSeat:
        hand.current_turn_seat
    },
    409
  );
}


  /* ----------------------------------------------------------
     CURRENT BETTING STATE
     ---------------------------------------------------------- */

  const currentBet =
    Number(
      hand.current_bet ||
      0
    );

  const oldMinRaise =
    Number(
      hand.min_raise ||
      hand.big_blind ||
      200
    );

  const streetContribution =
    player.streetContributed;

  const stack =
    player.currentStack;

  const callRequired =
    Math.max(
      0,
      currentBet -
      streetContribution
    );


  let chipsAdded = 0;

  let newStreetContribution =
    streetContribution;

  let newStack =
    stack;

  let newCurrentBet =
    currentBet;

  let newMinRaise =
    oldMinRaise;

  let newLastRaiser =
    hand.last_raiser_seat;

  let folded = false;

  let allIn = false;

  let fullRaise = false;


  /* ----------------------------------------------------------
     FOLD
     ---------------------------------------------------------- */

  if (action === "fold") {
    folded = true;
  }


  /* ----------------------------------------------------------
     CHECK
     ---------------------------------------------------------- */

  if (action === "check") {
    if (callRequired !== 0) {
      return json(
        {
          ok: false,
          error:
            `You must call ${callRequired} chips or fold.`
        },
        409
      );
    }
  }


  /* ----------------------------------------------------------
     CALL
     ---------------------------------------------------------- */

  if (action === "call") {
    if (callRequired <= 0) {
      return json(
        {
          ok: false,
          error:
            "There is nothing to call. Check instead."
        },
        409
      );
    }


    chipsAdded =
      Math.min(
        callRequired,
        stack
      );

    newStreetContribution =
      streetContribution +
      chipsAdded;

    newStack =
      stack -
      chipsAdded;

    allIn =
      newStack === 0;
  }


  /* ----------------------------------------------------------
     BET
     ---------------------------------------------------------- */

  if (action === "bet") {
    if (currentBet !== 0) {
      return json(
        {
          ok: false,
          error:
            "You cannot bet into an existing bet. Raise instead."
        },
        409
      );
    }


    const target =
      positiveInteger(
        body.amount
      );


    if (!target) {
      return json(
        {
          ok: false,
          error:
            "Enter a valid bet amount."
        },
        400
      );
    }


    const maximumTarget =
      streetContribution +
      stack;


    if (
      target >
      maximumTarget
    ) {
      return json(
        {
          ok: false,
          error:
            "Bet exceeds your poker stack."
        },
        409
      );
    }


    const isAllIn =
      target ===
      maximumTarget;


    if (
      target <
        Number(
          hand.big_blind
        ) &&
      !isAllIn
    ) {
      return json(
        {
          ok: false,
          error:
            `Minimum bet is ${hand.big_blind}.`
        },
        409
      );
    }


    chipsAdded =
      target -
      streetContribution;

    newStreetContribution =
      target;

    newStack =
      stack -
      chipsAdded;

    newCurrentBet =
      target;

    allIn =
      newStack === 0;


    if (
      target >=
      Number(
        hand.big_blind
      )
    ) {
      fullRaise = true;

      newMinRaise =
        target;

      newLastRaiser =
        player.seatNumber;
    }
  }


  /* ----------------------------------------------------------
     RAISE
     ---------------------------------------------------------- */

  if (action === "raise") {
    if (currentBet <= 0) {
      return json(
        {
          ok: false,
          error:
            "There is no bet to raise. Bet instead."
        },
        409
      );
    }


    const target =
      positiveInteger(
        body.amount
      );


    if (!target) {
      return json(
        {
          ok: false,
          error:
            "Enter a valid raise-to amount."
        },
        400
      );
    }


    if (
      target <=
      currentBet
    ) {
      return json(
        {
          ok: false,
          error:
            `Raise must be above ${currentBet}.`
        },
        409
      );
    }


    const maximumTarget =
      streetContribution +
      stack;


    if (
      target >
      maximumTarget
    ) {
      return json(
        {
          ok: false,
          error:
            "Raise exceeds your poker stack."
        },
        409
      );
    }


    const raiseSize =
      target -
      currentBet;

    const isAllIn =
      target ===
      maximumTarget;


    if (
      raiseSize <
        oldMinRaise &&
      !isAllIn
    ) {
      return json(
        {
          ok: false,

          error:
            `Minimum raise is to ${
              currentBet +
              oldMinRaise
            }.`
        },
        409
      );
    }


    chipsAdded =
      target -
      streetContribution;

    newStreetContribution =
      target;

    newStack =
      stack -
      chipsAdded;

    newCurrentBet =
      target;

    allIn =
      newStack === 0;


    if (
      raiseSize >=
      oldMinRaise
    ) {
      fullRaise = true;

      newMinRaise =
        raiseSize;

      newLastRaiser =
        player.seatNumber;
    }
  }


  /* ----------------------------------------------------------
     ALL IN
     ---------------------------------------------------------- */

  if (action === "all_in") {
    if (stack <= 0) {
      return json(
        {
          ok: false,
          error:
            "You have no chips remaining."
        },
        409
      );
    }


    chipsAdded =
      stack;

    newStreetContribution =
      streetContribution +
      stack;

    newStack = 0;

    allIn = true;


    if (
      newStreetContribution >
      currentBet
    ) {
      const raiseSize =
        newStreetContribution -
        currentBet;


      newCurrentBet =
        newStreetContribution;


      if (
        raiseSize >=
        oldMinRaise
      ) {
        fullRaise = true;

        newMinRaise =
          raiseSize;

        newLastRaiser =
          player.seatNumber;
      }
    }
  }


  /* ----------------------------------------------------------
     APPLY ACTION TO IN-MEMORY STATE
     ---------------------------------------------------------- */

  const updatedPlayers =
    players.map(
      (item) => ({
        ...item
      })
    );


  const updatedPlayer =
    updatedPlayers.find(
      (item) =>
        item.playerId ===
        playerId
    );


  updatedPlayer.currentStack =
    newStack;

  updatedPlayer.streetContributed =
    newStreetContribution;

  updatedPlayer.totalContributed +=
    chipsAdded;

  updatedPlayer.folded =
    folded;

  updatedPlayer.allIn =
    allIn;

  updatedPlayer.acted =
    true;

  updatedPlayer.lastAction =
    action;


  /*
    A FULL raise reopens action for everyone
    else who can still act.

    A short all-in raise does NOT reopen action.
  */

  if (fullRaise) {
    updatedPlayers.forEach(
      (item) => {
        if (
          item.playerId !==
            playerId &&
          !item.folded &&
          !item.allIn
        ) {
          item.acted =
            false;
        }
      }
    );
  }


  /* ----------------------------------------------------------
     POT
     ---------------------------------------------------------- */

  const oldPot =
    Number(
      hand.pot_before_rake ||
      0
    );

  const newPot =
    oldPot +
    chipsAdded;


  /* ----------------------------------------------------------
     DETERMINE HAND STATE
     ---------------------------------------------------------- */

  const remainingPlayers =
    updatedPlayers.filter(
      (item) =>
        !item.folded
    );


  let nextTurnSeat = null;

  let newStreet =
    hand.street_reached;

  let board =
    parseArray(
      hand.board_json
    );

  let deck =
    parseArray(
      hand.deck_json
    );

  let flopDealt =
    Number(
      hand.flop_dealt ||
      0
    );

  let status =
    "active";

  let roundAdvanced =
    false;

  let needsSettlement =
    false;

  let resetStreetPlayers =
    false;


  /* ----------------------------------------------------------
     EVERYBODY ELSE FOLDED
     ---------------------------------------------------------- */

  if (
    remainingPlayers.length <=
    1
  ) {
    status =
      "settling";

    needsSettlement =
      true;
  } else {

    /* --------------------------------------------------------
       IS BETTING ROUND COMPLETE?
       -------------------------------------------------------- */

    const playersAbleToAct =
      remainingPlayers.filter(
        (item) =>
          !item.allIn
      );


    const roundComplete =
      playersAbleToAct.every(
        (item) =>
          item.acted &&
          item.streetContributed ===
            newCurrentBet
      );


    if (roundComplete) {

      /* ------------------------------------------------------
         RIVER COMPLETE
         ------------------------------------------------------ */

      if (
        newStreet === "river"
      ) {
        status =
          "settling";

        needsSettlement =
          true;

      } else if (
        playersAbleToAct.length <=
        1
      ) {

        /* ----------------------------------------------------
           EVERYBODY IS ALL-IN / NO MORE BETTING POSSIBLE

           Automatically deal through river.
           ---------------------------------------------------- */

        const runout =
          runBoardToRiver(
            newStreet,
            deck,
            board
          );


        newStreet =
          runout.street;

        deck =
          runout.deck;

        board =
          runout.board;

        flopDealt =
          runout.flopDealt;

        status =
          "settling";

        needsSettlement =
          true;

        roundAdvanced =
          true;

      } else {

        /* ----------------------------------------------------
           ADVANCE ONE STREET
           ---------------------------------------------------- */

        const dealt =
          dealNextStreet(
            newStreet,
            deck,
            board
          );


        newStreet =
          dealt.street;

        deck =
          dealt.deck;

        board =
          dealt.board;

        flopDealt =
          dealt.flopDealt;

        newCurrentBet = 0;

        newMinRaise =
          Number(
            hand.big_blind
          );

        newLastRaiser =
          null;

        roundAdvanced =
          true;

        resetStreetPlayers =
          true;


        /*
          First post-flop player:
          first active player clockwise
          left of dealer.
        */

        nextTurnSeat =
          nextClockwise(
            updatedPlayers,
            Number(
              hand.dealer_seat
            ),
            (item) =>
              !item.folded &&
              !item.allIn
          );
      }

    } else {

      /* ------------------------------------------------------
         SAME BETTING ROUND — NEXT PLAYER WHO OWES ACTION
         ------------------------------------------------------ */

      nextTurnSeat =
        nextClockwise(
          updatedPlayers,
          player.seatNumber,
          (item) =>
            !item.folded &&
            !item.allIn &&
            (
              !item.acted ||
              item.streetContributed <
                newCurrentBet
            )
        );
    }
  }


  /* ----------------------------------------------------------
     ACTION DEADLINE
     ---------------------------------------------------------- */

  const actionDeadline =
    status === "active" &&
    nextTurnSeat !== null
      ? deadlineFromNow(
          hand.turn_seconds
        )
      : null;


  /* ----------------------------------------------------------
     ACTION SEQUENCE
     ---------------------------------------------------------- */

  const sequenceRow =
    await DB.prepare(`
      SELECT
        COALESCE(
          MAX(sequence_number),
          0
        ) AS max_sequence

      FROM poker_actions

      WHERE hand_id = ?
    `)
      .bind(handId)
      .first();


  const sequenceNumber =
    Number(
      sequenceRow?.max_sequence ||
      0
    ) + 1;


  /* ----------------------------------------------------------
     DATABASE BATCH
     ---------------------------------------------------------- */

  const statements = [];


  /*
    Action audit first.

    UNIQUE(hand_id, sequence_number)
    gives us protection against duplicate
    simultaneous action requests.
  */

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
        ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?
      )
    `)
      .bind(
        handId,
        player.sessionId,
        playerId,

        sequenceNumber,
        player.seatNumber,

        hand.street_reached,
        action,

        chipsAdded,
        newStreetContribution,

        newPot,
        newStack
      )
  );


  /* ----------------------------------------------------------
     FULL RAISE REOPENS OTHER PLAYERS
     ---------------------------------------------------------- */

  if (fullRaise) {
    statements.push(
      DB.prepare(`
        UPDATE poker_hand_players

        SET
          acted_this_round = 0

        WHERE hand_id = ?
          AND player_id <> ?
          AND folded = 0
          AND all_in = 0
      `)
        .bind(
          handId,
          playerId
        )
    );
  }


  /* ----------------------------------------------------------
     UPDATE ACTING PLAYER
     ---------------------------------------------------------- */

  statements.push(
    DB.prepare(`
      UPDATE poker_hand_players

      SET
        total_contributed =
          total_contributed + ?,

        street_contributed = ?,

        ending_stack = ?,

        folded = ?,
        all_in = ?,

        acted_this_round = 1,
        last_action = ?

      WHERE hand_id = ?
        AND player_id = ?
    `)
      .bind(
        chipsAdded,
        newStreetContribution,
        newStack,

        folded
          ? 1
          : 0,

        allIn
          ? 1
          : 0,

        action,

        handId,
        playerId
      )
  );


  /* ----------------------------------------------------------
     UPDATE TABLE STACK
     ---------------------------------------------------------- */

  if (chipsAdded > 0) {
    statements.push(
      DB.prepare(`
        UPDATE poker_sessions

        SET
          current_stack =
            current_stack - ?,

          last_seen_at =
            CURRENT_TIMESTAMP

        WHERE id = ?
          AND player_id = ?
          AND current_stack >= ?
      `)
        .bind(
          chipsAdded,
          player.sessionId,
          playerId,
          chipsAdded
        )
    );
  } else {
    statements.push(
      DB.prepare(`
        UPDATE poker_sessions

        SET
          last_seen_at =
            CURRENT_TIMESTAMP

        WHERE id = ?
          AND player_id = ?
      `)
        .bind(
          player.sessionId,
          playerId
        )
    );
  }


  /* ----------------------------------------------------------
     NEW STREET RESET
     ---------------------------------------------------------- */

  if (
    resetStreetPlayers
  ) {
    statements.push(
      DB.prepare(`
        UPDATE poker_hand_players

        SET
          street_contributed = 0,
          acted_this_round = 0,
          last_action = NULL

        WHERE hand_id = ?
      `)
        .bind(handId)
    );
  }


  /* ----------------------------------------------------------
     UPDATE HAND
     ---------------------------------------------------------- */

  statements.push(
    DB.prepare(`
      UPDATE poker_hands

      SET
        status = ?,

        street_reached = ?,
        flop_dealt = ?,

        board_json = ?,
        deck_json = ?,

        pot_before_rake = ?,
        pot_after_rake = ?,

        current_turn_seat = ?,
        current_bet = ?,
        min_raise = ?,
        last_raiser_seat = ?,

        action_deadline = ?

      WHERE id = ?
        AND table_id = ?
        AND status = 'active'
        AND current_turn_seat = ?
    `)
      .bind(
        status,

        newStreet,
        flopDealt,

        JSON.stringify(board),
        JSON.stringify(deck),

        newPot,
        newPot,

        nextTurnSeat,
        newCurrentBet,
        newMinRaise,
        newLastRaiser,

        actionDeadline,

        handId,
        tableId,
        player.seatNumber
      )
  );


  try {
    await DB.batch(
      statements
    );
  } catch (error) {
    console.error(
      "Poker action batch failed:",
      error
    );

    return json(
      {
        ok: false,

        error:
          "Poker action could not be committed.",

        debug:
          String(
            error?.message ||
            error ||
            ""
          )
      },
      409
    );
  }


  /* ----------------------------------------------------------
     PRIVATE CARDS
     ---------------------------------------------------------- */

  const privateHand =
    await DB.prepare(`
      SELECT
        hole_cards_json

      FROM poker_hand_players

      WHERE hand_id = ?
        AND player_id = ?

      LIMIT 1
    `)
      .bind(
        handId,
        playerId
      )
      .first();


  const yourCards =
    parseArray(
      privateHand
        ?.hole_cards_json
    );


  /* ----------------------------------------------------------
     RESPONSE
     ---------------------------------------------------------- */

  return json(
    {
      ok: true,

      message:
        `${action
          .replaceAll("_", " ")
          .toUpperCase()} accepted.`,

      action: {
        type:
          action,

        seatNumber:
          player.seatNumber,

        chipsAdded,

        toAmount:
          newStreetContribution,

        stackAfter:
          newStack
      },

      hand: {
        id:
          handId,

        handNumber:
          Number(
            hand.hand_number
          ),

        status,

        street:
          newStreet,

        dealerSeat:
          Number(
            hand.dealer_seat
          ),

        board,

        flopDealt:
          flopDealt === 1,

        pot:
          newPot,

        currentTurnSeat:
          nextTurnSeat,

        currentBet:
          newCurrentBet,

        minRaise:
          newMinRaise,

        lastRaiserSeat:
          newLastRaiser,

        actionDeadline
      },

      yourCards,

      roundAdvanced,

      needsSettlement
    }
  );
}


/* ============================================================
   EXPORTED HANDLER
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
      "Poker action backend error:",
      error
    );

    return json(
      {
        ok: false,

        error:
          "Poker action backend error.",

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