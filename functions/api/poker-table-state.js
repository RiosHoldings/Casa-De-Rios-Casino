/* ============================================================
   CASA DE RÍOS — TEXAS HOLD'EM
   /functions/api/poker-table-state.js

   Responsibilities:
   - Authenticate player
   - Heartbeat active poker session
   - Return public table / seat state
   - Return active hand state
   - Return public hand-player state
   - Return ONLY authenticated player's hole cards
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
   JSON HELPER
   ============================================================ */

function parseJsonArray(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  try {
    const parsed =
      JSON.parse(value);

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch {
    return [];
  }
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
     AUTH
     ---------------------------------------------------------- */

  const account =
    await DB.prepare(`
      SELECT
        id,
        character_name,
        discord_name,
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

        rake_basis_points,
        rake_cap,
        no_flop_no_drop,

        turn_seconds,
        hand_delay_seconds,
        disconnect_grace_seconds,
        sitout_limit_seconds,

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


  /* ----------------------------------------------------------
     HEARTBEAT

     Only updates this authenticated player's session.
     ---------------------------------------------------------- */

  await DB.prepare(`
    UPDATE poker_sessions

    SET
      last_seen_at =
        CURRENT_TIMESTAMP

    WHERE table_id = ?
      AND player_id = ?
      AND status IN (
        'seated',
        'sitting_out',
        'disconnected',
        'leaving'
      )
  `)
    .bind(
      tableId,
      playerId
    )
    .run();


  /* ----------------------------------------------------------
     APPROVED BUY-INS
     ---------------------------------------------------------- */

  const buyinResult =
    await DB.prepare(`
      SELECT amount

      FROM poker_table_buyins

      WHERE table_id = ?

      ORDER BY amount ASC
    `)
      .bind(tableId)
      .all();


  const buyIns =
    (
      buyinResult.results ||
      []
    ).map(
      (row) =>
        Number(row.amount)
    );


  /* ----------------------------------------------------------
     LIVE SEATS
     ---------------------------------------------------------- */

  const seatResult =
    await DB.prepare(`
      SELECT
        s.id AS session_id,
        s.player_id,
        s.seat_number,

        s.buy_in,
        s.starting_stack,
        s.current_stack,

        s.status,
        s.joined_at,
        s.last_seen_at,

        p.character_name,
        p.discord_name

      FROM poker_sessions s

      JOIN players p
        ON p.id = s.player_id

      WHERE s.table_id = ?
        AND s.status IN (
          'seated',
          'sitting_out',
          'disconnected',
          'leaving'
        )

      ORDER BY
        s.seat_number ASC
    `)
      .bind(tableId)
      .all();


  const rawSeats =
    seatResult.results ||
    [];


  const seats =
    rawSeats.map(
      (row) => ({
        seatNumber:
          Number(
            row.seat_number
          ),

        characterName:
          row.character_name ||
          "Unknown Player",

        stack:
          Number(
            row.current_stack ||
            0
          ),

        status:
          row.status,

        isYou:
          row.player_id ===
          playerId
      })
    );


  /* ----------------------------------------------------------
     AUTHENTICATED PLAYER'S SESSION

     Session ID is private to the authenticated player.
     ---------------------------------------------------------- */

  const yourRawSession =
    rawSeats.find(
      (row) =>
        row.player_id ===
        playerId
    );


  let yourSession = null;


  if (yourRawSession) {
    yourSession = {
      id:
        yourRawSession
          .session_id,

      tableId,

      seatNumber:
        Number(
          yourRawSession
            .seat_number
        ),

      buyIn:
        Number(
          yourRawSession
            .buy_in ||
          0
        ),

      startingStack:
        Number(
          yourRawSession
            .starting_stack ||
          0
        ),

      currentStack:
        Number(
          yourRawSession
            .current_stack ||
          0
        ),

      status:
        yourRawSession.status,

      joinedAt:
        yourRawSession
          .joined_at,

      lastSeenAt:
        yourRawSession
          .last_seen_at
    };
  }


  /* ----------------------------------------------------------
     ACTIVE HAND
     ---------------------------------------------------------- */

  const currentHand =
    await DB.prepare(`
      SELECT
        id,
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

        current_turn_seat,
        current_bet,
        min_raise,
        last_raiser_seat,

        action_deadline,
        started_at,
        ended_at

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


  let hand = null;
  let yourCards = [];
  let handPlayers = [];


  if (currentHand) {

    /* --------------------------------------------------------
       PUBLIC HAND PLAYER STATE

       Do NOT select hole_cards_json here.
       -------------------------------------------------------- */

    const handPlayerResult =
      await DB.prepare(`
        SELECT
          hp.player_id,
          hp.seat_number,

          hp.starting_stack,
          hp.total_contributed,
          hp.street_contributed,

          hp.winnings,

          hp.folded,
          hp.all_in,
          hp.showed_cards,

          hp.acted_this_round,
          hp.last_action,

          s.current_stack,

          p.character_name

        FROM poker_hand_players hp

        JOIN poker_sessions s
          ON s.id =
             hp.session_id

        JOIN players p
          ON p.id =
             hp.player_id

        WHERE hp.hand_id = ?

        ORDER BY
          hp.seat_number ASC
      `)
        .bind(
          currentHand.id
        )
        .all();


    const rawHandPlayers =
      handPlayerResult.results ||
      [];


    handPlayers =
      rawHandPlayers.map(
        (row) => ({
          seatNumber:
            Number(
              row.seat_number
            ),

          characterName:
            row.character_name ||
            "Unknown Player",

          stack:
            Number(
              row.current_stack ||
              0
            ),

          startingStack:
            Number(
              row.starting_stack ||
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

          showedCards:
            Number(
              row.showed_cards ||
              0
            ) === 1,

          actedThisRound:
            Number(
              row.acted_this_round ||
              0
            ) === 1,

          lastAction:
            row.last_action ||
            null,

          isYou:
            row.player_id ===
            playerId
        })
      );


    /* --------------------------------------------------------
       PRIVATE HOLE CARDS

       Query ONLY the authenticated player's cards.
       -------------------------------------------------------- */

    const privateCards =
      await DB.prepare(`
        SELECT
          hole_cards_json

        FROM poker_hand_players

        WHERE hand_id = ?
          AND player_id = ?

        LIMIT 1
      `)
        .bind(
          currentHand.id,
          playerId
        )
        .first();


    if (privateCards) {
      yourCards =
        parseJsonArray(
          privateCards
            .hole_cards_json
        );
    }


    /* --------------------------------------------------------
       PUBLIC HAND
       -------------------------------------------------------- */

    hand = {
      id:
        currentHand.id,

      handNumber:
        Number(
          currentHand
            .hand_number
        ),

      status:
        currentHand.status,

      street:
        currentHand
          .street_reached,

      dealerSeat:
        Number(
          currentHand
            .dealer_seat
        ),

      smallBlindSeat:
        Number(
          currentHand
            .small_blind_seat
        ),

      bigBlindSeat:
        Number(
          currentHand
            .big_blind_seat
        ),

      currentTurnSeat:
        currentHand
          .current_turn_seat ===
          null
          ? null
          : Number(
              currentHand
                .current_turn_seat
            ),

      currentBet:
        Number(
          currentHand
            .current_bet ||
          0
        ),

      minRaise:
        Number(
          currentHand
            .min_raise ||
          0
        ),

      lastRaiserSeat:
        currentHand
          .last_raiser_seat ===
          null
          ? null
          : Number(
              currentHand
                .last_raiser_seat
            ),

      board:
        parseJsonArray(
          currentHand
            .board_json
        ),

      flopDealt:
        Number(
          currentHand
            .flop_dealt ||
          0
        ) === 1,

      pot:
        Number(
          currentHand
            .pot_before_rake ||
          0
        ),

      potBeforeRake:
        Number(
          currentHand
            .pot_before_rake ||
          0
        ),

      rake:
        Number(
          currentHand
            .rake_amount ||
          0
        ),

      potAfterRake:
        Number(
          currentHand
            .pot_after_rake ||
          0
        ),

      actionDeadline:
        currentHand
          .action_deadline,

      startedAt:
        currentHand
          .started_at,

      endedAt:
        currentHand
          .ended_at
    };
  }


  /* ----------------------------------------------------------
     RESPONSE
     ---------------------------------------------------------- */

  return json(
    {
      ok: true,

      table: {
        id:
          table.id,

        name:
          table.name,

        status:
          table.status,

        maxPlayers:
          Number(
            table.max_players
          ),

        smallBlind:
          Number(
            table.small_blind
          ),

        bigBlind:
          Number(
            table.big_blind
          ),

        rakeBasisPoints:
          Number(
            table.rake_basis_points
          ),

        rakePercent:
          Number(
            table.rake_basis_points
          ) / 100,

        rakeCap:
          Number(
            table.rake_cap
          ),

        noFlopNoDrop:
          Number(
            table.no_flop_no_drop
          ) === 1,

        turnSeconds:
          Number(
            table.turn_seconds
          ),

        handDelaySeconds:
          Number(
            table.hand_delay_seconds
          ),

        disconnectGraceSeconds:
          Number(
            table.disconnect_grace_seconds
          ),

        sitoutLimitSeconds:
          Number(
            table.sitout_limit_seconds
          ),

        handCounter:
          Number(
            table.hand_counter ||
            0
          ),

        buyIns
      },

      seats,

      seatedPlayers:
        seats.length,

      yourSession,

      hand,

      handPlayers,

      yourCards,

      serverTime:
        new Date()
          .toISOString()
    }
  );
}


/* ============================================================
   ONLY EXPORTED HANDLER
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
      "poker-table-state backend error:",
      error
    );

    return json(
      {
        ok: false,

        error:
          "Poker table state backend error.",

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