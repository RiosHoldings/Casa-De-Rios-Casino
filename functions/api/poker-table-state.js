/* ============================================================
   CASA DE RÍOS — TEXAS HOLD'EM
   POST /api/poker-table-state

   Responsibilities:
   - Authenticate current player
   - Return live occupied seats
   - Return current stack/status for every seated player
   - Identify the requesting player's own session
   - Refresh last_seen_at heartbeat
   - Return table configuration
   - Return current public hand state when hand engine exists
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

function cleanString(value) {
  return String(
    value ?? ""
  ).trim();
}


function safeJson(value, fallback = null) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}


/* ============================================================
   POST
   ============================================================ */

async function handlePost(context) {
  const DB =
    context.env.DB;


  /* ----------------------------------------------------------
     DATABASE
     ---------------------------------------------------------- */

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
     REQUEST BODY
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
          "Invalid JSON body."
      },
      400
    );
  }


  const playerId =
    cleanString(
      body.playerId
    );

  const playerSecret =
    cleanString(
      body.playerSecret
    );

  const tableId =
    cleanString(
      body.tableId ||
      "poker-room-1"
    );


  if (
    !playerId ||
    !playerSecret
  ) {
    return json(
      {
        ok: false,
        error:
          "Player login is missing."
      },
      400
    );
  }


  /* ============================================================
     AUTHENTICATE VIEWER
     ============================================================ */

  const player =
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


  if (!player) {
    return json(
      {
        ok: false,
        error:
          "Player authentication failed."
      },
      401
    );
  }


  /* ============================================================
     TABLE
     ============================================================ */

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
      .bind(
        tableId
      )
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


  /* ============================================================
     HEARTBEAT

     Visiting/polling table state updates last_seen_at for this
     player's active seat.

     Later this will power the disconnect grace period.
     ============================================================ */

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


  /* ============================================================
     BUY-IN OPTIONS
     ============================================================ */

  const buyinResult =
    await DB.prepare(`
      SELECT
        amount

      FROM poker_table_buyins

      WHERE table_id = ?

      ORDER BY amount ASC
    `)
      .bind(
        tableId
      )
      .all();


  const buyIns =
    (
      buyinResult.results ||
      []
    )
      .map(
        row =>
          Number(
            row.amount || 0
          )
      )
      .filter(
        amount =>
          amount > 0
      );


  /* ============================================================
     LIVE SEATS
     ============================================================ */

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
        ON p.id =
          s.player_id

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
      .bind(
        tableId
      )
      .all();


  const rawSeats =
    seatResult.results ||
    [];


  /* ============================================================
     PUBLIC SEAT DATA

     We do NOT expose:
     - player_secret
     - hole cards
     - wallet balance
     - private profile information
     ============================================================ */

  const seats =
    rawSeats.map(
      row => {

        const isYou =
          row.player_id ===
          playerId;


        return {
          seatNumber:
            Number(
              row.seat_number
            ),

          characterName:
            cleanString(
              row.character_name
            ) ||
            "Player",

          stack:
            Math.max(
              0,
              Math.floor(
                Number(
                  row.current_stack ||
                  0
                )
              )
            ),

          status:
            cleanString(
              row.status
            ) ||
            "seated",

          isYou
        };
      }
    );


  /* ============================================================
     CURRENT PLAYER SESSION

     Session ID is only returned for the authenticated player.
     ============================================================ */

  const ownRow =
    rawSeats.find(
      row =>
        row.player_id ===
        playerId
    );


  let yourSession =
    null;


  if (ownRow) {
    yourSession = {
      id:
        ownRow.session_id,

      tableId,

      seatNumber:
        Number(
          ownRow.seat_number
        ),

      buyIn:
        Number(
          ownRow.buy_in || 0
        ),

      startingStack:
        Number(
          ownRow.starting_stack ||
          0
        ),

      pokerStack:
        Number(
          ownRow.current_stack ||
          0
        ),

      status:
        ownRow.status,

      joinedAt:
        ownRow.joined_at,

      lastSeenAt:
        ownRow.last_seen_at
    };
  }


  /* ============================================================
     CURRENT HAND

     No hand engine yet, but returning the public fields now means
     poker.js will not need another table-state architecture
     rewrite when the engine is added.
     ============================================================ */

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
        pot_after_rake

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
      .bind(
        tableId
      )
      .first();


  let hand =
    null;


  if (currentHand) {
    hand = {
      id:
        currentHand.id,

      handNumber:
        Number(
          currentHand.hand_number ||
          0
        ),

      dealerSeat:
        currentHand.dealer_seat ===
          null
          ? null
          : Number(
              currentHand.dealer_seat
            ),

      smallBlindSeat:
        currentHand.small_blind_seat ===
          null
          ? null
          : Number(
              currentHand.small_blind_seat
            ),

      bigBlindSeat:
        currentHand.big_blind_seat ===
          null
          ? null
          : Number(
              currentHand.big_blind_seat
            ),

      status:
        currentHand.status,

      street:
        currentHand.street_reached,

      flopDealt:
        Number(
          currentHand.flop_dealt ||
          0
        ) === 1,

      board:
        safeJson(
          currentHand.board_json,
          []
        ) || [],

      potBeforeRake:
        Number(
          currentHand.pot_before_rake ||
          0
        ),

      rake:
        Number(
          currentHand.rake_amount ||
          0
        ),

      potAfterRake:
        Number(
          currentHand.pot_after_rake ||
          0
        ),
    };
  }


  /* ============================================================
     RESPONSE
     ============================================================ */

  return json({
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
          table.hand_delay_seconds ||
          0
        ),

      disconnectGraceSeconds:
        Number(
          table.disconnect_grace_seconds ||
          0
        ),

      sitoutLimitSeconds:
        Number(
          table.sitout_limit_seconds ||
          0
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


    serverTime:
      new Date()
        .toISOString()
  });
}


/* ============================================================
   CLOUDFLARE PAGES

   Only export onRequest.
   ============================================================ */

export async function onRequest(context) {
  try {

    if (
      context.request.method ===
      "POST"
    ) {
      return await handlePost(
        context
      );
    }


    return json(
      {
        ok: false,
        error:
          "Method not allowed."
      },
      405
    );


  } catch (error) {

    console.error(
      "POKER TABLE STATE ERROR:",
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
            "Unknown backend error"
          )
      },
      500
    );
  }
}