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

function parseArray(value) {
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
   AUTO-REMOVE EXPIRED SIT-OUT PLAYERS
   ============================================================ */

async function autoRemoveExpiredSitouts(
  DB,
  tableId
) {
  const expiredResult =
    await DB.prepare(`
      SELECT
        s.id,
        s.player_id,
        s.current_stack

      FROM poker_sessions s

      JOIN poker_tables t
        ON t.id =
           s.table_id

      WHERE s.table_id = ?
        AND s.status =
            'sitting_out'

        AND s.sit_out_at
            IS NOT NULL

        AND datetime(
              s.sit_out_at,
              '+' ||
              COALESCE(
                t.sitout_limit_seconds,
                600
              ) ||
              ' seconds'
            )
            <= datetime('now')

        AND NOT EXISTS (
          SELECT 1

          FROM poker_hand_players hp

          JOIN poker_hands h
            ON h.id =
               hp.hand_id

          WHERE hp.session_id =
                s.id

            AND h.status IN (
              'active',
              'settling'
            )
        )
    `)
      .bind(
        tableId
      )
      .all();


  const expiredSessions =
    expiredResult.results ||
    [];


  for (
    const session of
    expiredSessions
  ) {
    const sessionId =
      session.id;

    const playerId =
      session.player_id;

    const stack =
      Number(
        session.current_stack ||
        0
      );


    /* --------------------------------------------------------
       ZERO STACK

       Nothing to return to wallet.
       Just release the seat.
       -------------------------------------------------------- */

    if (
      stack <= 0
    ) {
      await DB.prepare(`
        UPDATE poker_sessions

        SET
          ending_stack =
            current_stack,

          current_stack =
            0,

          status =
            'left',

          left_at =
            CURRENT_TIMESTAMP,

          sit_out_at =
            NULL

        WHERE id = ?
          AND table_id = ?
          AND status =
              'sitting_out'
      `)
        .bind(
          sessionId,
          tableId
        )
        .run();


      continue;
    }


    /* --------------------------------------------------------
       ALREADY CASHED OUT?

       Protect against duplicate auto-removal.
       -------------------------------------------------------- */

    const existingTransfer =
      await DB.prepare(`
        SELECT
          id

        FROM poker_transfers

        WHERE session_id = ?
          AND direction =
              'table_to_wallet'

        LIMIT 1
      `)
        .bind(
          sessionId
        )
        .first();


    if (
      existingTransfer
    ) {
      /*
        The money was already returned.

        Clean up the session if it somehow
        remained sitting_out.
      */

      await DB.prepare(`
        UPDATE poker_sessions

        SET
          ending_stack =
            current_stack,

          current_stack =
            0,

          status =
            'left',

          left_at =
            COALESCE(
              left_at,
              CURRENT_TIMESTAMP
            ),

          sit_out_at =
            NULL

        WHERE id = ?
          AND table_id = ?
          AND status =
              'sitting_out'
      `)
        .bind(
          sessionId,
          tableId
        )
        .run();


      continue;
    }


    /* --------------------------------------------------------
       IDS
       -------------------------------------------------------- */

    const transferId =
      `PKT-${crypto.randomUUID()}`;

    const idempotencyKey =
      `poker-auto-remove-${sessionId}`;


    /* --------------------------------------------------------
       TRANSFER AUDIT

       This INSERT only succeeds if the player
       is STILL eligible for auto-removal.
       -------------------------------------------------------- */

    const insertTransfer =
      DB.prepare(`
        INSERT OR IGNORE
        INTO poker_transfers (
          id,

          table_id,
          session_id,
          player_id,

          direction,
          reason,

          amount,

          wallet_balance_before,
          wallet_balance_after,

          table_stack_before,
          table_stack_after,

          idempotency_key,

          created_at
        )

        SELECT
          ?,

          s.table_id,
          s.id,
          s.player_id,

          'table_to_wallet',
          'auto_remove',

          s.current_stack,

          w.chips,
          w.chips +
            s.current_stack,

          s.current_stack,
          0,

          ?,

          CURRENT_TIMESTAMP

        FROM poker_sessions s

        JOIN poker_tables t
          ON t.id =
             s.table_id

        JOIN wallets w
          ON w.player_id =
             s.player_id

        WHERE s.id = ?
          AND s.table_id = ?

          AND s.status =
              'sitting_out'

          AND s.current_stack > 0

          AND s.sit_out_at
              IS NOT NULL

          AND datetime(
                s.sit_out_at,
                '+' ||
                COALESCE(
                  t.sitout_limit_seconds,
                  600
                ) ||
                ' seconds'
              )
              <= datetime('now')

          AND NOT EXISTS (
            SELECT 1

            FROM poker_hand_players hp

            JOIN poker_hands h
              ON h.id =
                 hp.hand_id

            WHERE hp.session_id =
                  s.id

              AND h.status IN (
                'active',
                'settling'
              )
          )

          AND NOT EXISTS (
            SELECT 1

            FROM poker_transfers pt

            WHERE pt.session_id =
                  s.id

              AND pt.direction =
                  'table_to_wallet'
          )
      `)
        .bind(
          transferId,
          idempotencyKey,

          sessionId,
          tableId
        );


    /* --------------------------------------------------------
       RETURN CHIPS TO WALLET

       Amount comes from the transfer row itself,
       not from browser/client data.
       -------------------------------------------------------- */

    const creditWallet =
      DB.prepare(`
        UPDATE wallets

        SET
          chips =
            chips +
            COALESCE(
              (
                SELECT amount

                FROM poker_transfers

                WHERE id = ?
              ),
              0
            ),

          updated_at =
            CURRENT_TIMESTAMP

        WHERE player_id = ?

          AND EXISTS (
            SELECT 1

            FROM poker_transfers

            WHERE id = ?
          )
      `)
        .bind(
          transferId,
          playerId,
          transferId
        );


    /* --------------------------------------------------------
       MAIN CASINO LEDGER
       -------------------------------------------------------- */

    const ledger =
      DB.prepare(`
        INSERT INTO transactions (
          player_id,

          type,
          game,

          amount,
          balance_after,

          note,

          created_at
        )

        SELECT
          pt.player_id,

          'poker_table_cashout',
          'poker',

          pt.amount,

          w.chips,

          'Poker auto-remove after sit-out limit',

          CURRENT_TIMESTAMP

        FROM poker_transfers pt

        JOIN wallets w
          ON w.player_id =
             pt.player_id

        WHERE pt.id = ?
      `)
        .bind(
          transferId
        );


    /* --------------------------------------------------------
       RELEASE SEAT
       -------------------------------------------------------- */

    const closeSession =
      DB.prepare(`
        UPDATE poker_sessions

        SET
          ending_stack =
            current_stack,

          current_stack =
            0,

          status =
            'left',

          left_at =
            CURRENT_TIMESTAMP,

          sit_out_at =
            NULL

        WHERE id = ?
          AND table_id = ?
          AND player_id = ?

          AND status =
              'sitting_out'

          AND EXISTS (
            SELECT 1

            FROM poker_transfers

            WHERE id = ?
          )
      `)
        .bind(
          sessionId,
          tableId,
          playerId,
          transferId
        );


    /* --------------------------------------------------------
       COMMIT AS ONE D1 BATCH
       -------------------------------------------------------- */

    try {

      await DB.batch([
        insertTransfer,
        creditWallet,
        ledger,
        closeSession
      ]);


    } catch (error) {

      console.error(
        "Poker sit-out auto-remove failed:",
        sessionId,
        error
      );
    }
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

/* ============================================================
   SESSION HEARTBEAT / DISCONNECT GRACE
   ============================================================ */

/*
  1. The player making this request is online.

     If they were previously marked disconnected,
     restore them to seated.
*/

await DB.prepare(`
  UPDATE poker_sessions

  SET
    status =
      CASE
        WHEN status = 'disconnected'
          THEN 'seated'
        ELSE status
      END,

    last_seen_at =
      CURRENT_TIMESTAMP

  WHERE table_id = ?
    AND player_id = ?
    AND status IN (
      'seated',
      'disconnected'
    )
`)
  .bind(
    tableId,
    playerId
  )
  .run();


/*
  2. Any OTHER seated player who has not
     checked in for 60 seconds becomes disconnected.

     Their seat and chips stay reserved.
*/

await DB.prepare(`
  UPDATE poker_sessions

  SET
    status = 'disconnected'

  WHERE table_id = ?
    AND player_id <> ?
    AND status = 'seated'

    AND datetime(last_seen_at) <=
        datetime(
          'now',
          '-60 seconds'
        )
`)
  .bind(
    tableId,
    playerId
  )
  .run();

  await autoRemoveExpiredSitouts(
    DB,
    tableId
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

  /* ============================================================
   LAST COMPLETED HAND
   ============================================================ */

const lastCompletedRow =
  await DB.prepare(`
    SELECT
      id,
      hand_number,

      board_json,

      pot_before_rake,
      rake_amount,
      pot_after_rake,

      winner_summary_json,

      ended_at

    FROM poker_hands

    WHERE table_id = ?
      AND status = 'completed'

    ORDER BY
      ended_at DESC

    LIMIT 1
  `)
    .bind(
      tableId
    )
    .first();


let lastCompletedHand =
  null;


if (
  lastCompletedRow
) {
  lastCompletedHand = {
    id:
      lastCompletedRow.id,

    handNumber:
      Number(
        lastCompletedRow.hand_number
      ),

    board:
      parseArray(
        lastCompletedRow.board_json
      ),

    potBeforeRake:
      Number(
        lastCompletedRow.pot_before_rake ||
        0
      ),

    rake:
      Number(
        lastCompletedRow.rake_amount ||
        0
      ),

    potAfterRake:
      Number(
        lastCompletedRow.pot_after_rake ||
        0
      ),

    winners:
      parseArray(
        lastCompletedRow.winner_summary_json
      ),

    endedAt:
      lastCompletedRow.ended_at
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

      lastCompletedHand,

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