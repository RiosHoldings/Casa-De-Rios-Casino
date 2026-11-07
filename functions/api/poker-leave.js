/* ============================================================
   CASA DE RÍOS — TEXAS HOLD'EM
   POST /api/poker-leave

   Returns the player's remaining poker stack to the main
   Casa de Ríos wallet.

   Expected body:
   {
     playerId,
     playerSecret,
     tableId,
     sessionId,
     idempotencyKey
   }
   ============================================================ */


/* ============================================================
   RESPONSE HELPER
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


function makeId(prefix) {
  return (
    prefix +
    "-" +
    crypto.randomUUID()
  );
}


/* ============================================================
   POST HANDLER
   ============================================================ */

async function handlePost(context) {
  const DB =
    context.env.DB;


  /* ----------------------------------------------------------
     DATABASE CHECK
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
     BODY
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


  /* ----------------------------------------------------------
     INPUT
     ---------------------------------------------------------- */

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

  const sessionId =
    cleanString(
      body.sessionId
    );

  const idempotencyKey =
    cleanString(
      body.idempotencyKey
    ) ||
    (
      "poker-leave-" +
      crypto.randomUUID()
    );


  /* ----------------------------------------------------------
     VALIDATION
     ---------------------------------------------------------- */

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


  if (!sessionId) {
    return json(
      {
        ok: false,
        error:
          "Poker session is missing."
      },
      400
    );
  }


  /* ============================================================
     IDEMPOTENCY

     If this exact leave request was already processed,
     return the original result instead of paying twice.
     ============================================================ */

  const existingTransfer =
    await DB.prepare(`
      SELECT
        id,
        table_id,
        session_id,
        player_id,
        amount,
        wallet_balance_after,
        table_stack_before,
        table_stack_after
      FROM poker_transfers
      WHERE idempotency_key = ?
        AND direction = 'table_to_wallet'
      LIMIT 1
    `)
      .bind(
        idempotencyKey
      )
      .first();


  if (existingTransfer) {

    if (
      existingTransfer.player_id !==
        playerId ||

      existingTransfer.session_id !==
        sessionId ||

      existingTransfer.table_id !==
        tableId
    ) {
      return json(
        {
          ok: false,
          error:
            "Idempotency key was already used for another request."
        },
        409
      );
    }


    return json({
      ok: true,

      duplicate: true,

      message:
        "Poker stack was already returned to the wallet.",

      sessionId:
        existingTransfer.session_id,

      transferId:
        existingTransfer.id,

      amountReturned:
        Number(
          existingTransfer.amount || 0
        ),

      pokerStack:
        0,

      walletBalance:
        Number(
          existingTransfer.wallet_balance_after ||
          0
        ),

      status:
        "left"
    });
  }


  /* ============================================================
     AUTHENTICATE PLAYER
     ============================================================ */

  const account =
    await DB.prepare(`
      SELECT
        p.id,
        p.status,
        w.chips,
        w.locked
      FROM players p
      JOIN wallets w
        ON w.player_id = p.id
      WHERE p.id = ?
        AND p.player_secret = ?
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


  /* ============================================================
     LOAD POKER SESSION
     ============================================================ */

  const session =
    await DB.prepare(`
      SELECT
        s.id,
        s.table_id,
        s.player_id,
        s.seat_number,
        s.buy_in,
        s.starting_stack,
        s.current_stack,
        s.ending_stack,
        s.status,
        s.joined_at,
        s.left_at,

        t.name AS table_name

      FROM poker_sessions s

      JOIN poker_tables t
        ON t.id = s.table_id

      WHERE s.id = ?
        AND s.player_id = ?
        AND s.table_id = ?

      LIMIT 1
    `)
      .bind(
        sessionId,
        playerId,
        tableId
      )
      .first();


  if (!session) {
    return json(
      {
        ok: false,
        error:
          "Poker session not found."
      },
      404
    );
  }


  /* ============================================================
     ALREADY LEFT

     This protects us even if the browser somehow loses its old
     idempotency key.
     ============================================================ */

  if (
    session.status === "left"
  ) {

    const previousCashout =
      await DB.prepare(`
        SELECT
          id,
          amount,
          wallet_balance_after
        FROM poker_transfers
        WHERE session_id = ?
          AND direction = 'table_to_wallet'
        ORDER BY created_at DESC
        LIMIT 1
      `)
        .bind(
          sessionId
        )
        .first();


    return json({
      ok: true,

      alreadyLeft: true,

      message:
        "You already left this poker table.",

      sessionId,

      transferId:
        previousCashout?.id ||
        null,

      amountReturned:
        Number(
          previousCashout?.amount ||
          session.ending_stack ||
          0
        ),

      pokerStack: 0,

      walletBalance:
        Number(
          previousCashout?.wallet_balance_after ??
          account.chips ??
          0
        ),

      status:
        "left"
    });
  }


  /* ============================================================
     ACTIVE HAND PROTECTION

     Once the hand engine exists, a player cannot leave halfway
     through a hand to escape a bet or remove table chips.

     They must finish the current hand first.
     ============================================================ */

  const activeHand =
    await DB.prepare(`
      SELECT
        h.id,
        h.hand_number,
        h.status
      FROM poker_hands h

      JOIN poker_hand_players hp
        ON hp.hand_id = h.id

      WHERE hp.session_id = ?
        AND h.table_id = ?
        AND h.status IN (
          'active',
          'settling'
        )

      LIMIT 1
    `)
      .bind(
        sessionId,
        tableId
      )
      .first();


  if (activeHand) {
    return json(
      {
        ok: false,

        error:
          "You cannot leave during an active poker hand.",

        handId:
          activeHand.id,

        handNumber:
          Number(
            activeHand.hand_number || 0
          )
      },
      409
    );
  }


  /* ============================================================
     STACK
     ============================================================ */

  const stack =
    Math.max(
      0,
      Math.floor(
        Number(
          session.current_stack || 0
        )
      )
    );


  /* ============================================================
     BUSTED PLAYER

     If the player has zero chips there is nothing to transfer.
     We simply close the session.
     ============================================================ */

  if (stack === 0) {

    await DB.prepare(`
      UPDATE poker_sessions
      SET
        ending_stack = 0,
        current_stack = 0,
        status = 'left',
        last_seen_at =
          CURRENT_TIMESTAMP,
        left_at =
          CURRENT_TIMESTAMP

      WHERE id = ?
        AND player_id = ?
        AND table_id = ?
        AND status IN (
          'seated',
          'sitting_out',
          'disconnected',
          'leaving'
        )
    `)
      .bind(
        sessionId,
        playerId,
        tableId
      )
      .run();


    return json({
      ok: true,

      message:
        "You left the poker table with no remaining chips.",

      sessionId,

      seatNumber:
        Number(
          session.seat_number
        ),

      amountReturned: 0,

      pokerStack: 0,

      walletBalance:
        Number(
          account.chips || 0
        ),

      status:
        "left"
    });
  }


  /* ============================================================
     IDS
     ============================================================ */

  const transferId =
    makeId(
      "PKT"
    );


  /* ============================================================
     STEP 1
     CLAIM THE SESSION FOR LEAVING

     The NOT EXISTS prevents another leave transaction from
     claiming the same session.
     ============================================================ */

  const markLeaving =
    DB.prepare(`
      UPDATE poker_sessions

      SET
        status = 'leaving',
        last_seen_at =
          CURRENT_TIMESTAMP

      WHERE id = ?
        AND player_id = ?
        AND table_id = ?

        AND current_stack = ?

        AND status IN (
          'seated',
          'sitting_out',
          'disconnected'
        )

        AND NOT EXISTS (
          SELECT 1
          FROM poker_transfers pt

          WHERE pt.session_id =
            poker_sessions.id

            AND pt.direction =
              'table_to_wallet'
        )
    `)
      .bind(
        sessionId,
        playerId,
        tableId,
        stack
      );


  /* ============================================================
     STEP 2
     CREDIT MAIN WALLET

     Wallet lock does NOT prevent chips being returned.
     A locked wallet can receive money; it simply cannot spend it.
     ============================================================ */

  const creditWallet =
    DB.prepare(`
      UPDATE wallets

      SET
        chips =
          chips + ?,

        updated_at =
          CURRENT_TIMESTAMP

      WHERE player_id = ?

        AND EXISTS (
          SELECT 1
          FROM poker_sessions s

          WHERE s.id = ?
            AND s.player_id = ?
            AND s.table_id = ?
            AND s.status = 'leaving'
            AND s.current_stack = ?
        )

        AND NOT EXISTS (
          SELECT 1
          FROM poker_transfers pt

          WHERE pt.session_id = ?

            AND pt.direction =
              'table_to_wallet'
        )
    `)
      .bind(
        stack,

        playerId,

        sessionId,
        playerId,
        tableId,
        stack,

        sessionId
      );


  /* ============================================================
     STEP 3
     WRITE TRANSFER AUDIT
     ============================================================ */

  const insertTransfer =
    DB.prepare(`
      INSERT INTO poker_transfers (
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
        ?,
        s.id,
        s.player_id,

        'table_to_wallet',
        'leave_table',

        ?,

        w.chips - ?,
        w.chips,

        s.current_stack,
        0,

        ?,

        CURRENT_TIMESTAMP

      FROM poker_sessions s

      JOIN wallets w
        ON w.player_id =
          s.player_id

      WHERE s.id = ?
        AND s.player_id = ?
        AND s.table_id = ?
        AND s.status = 'leaving'
        AND s.current_stack = ?

        AND NOT EXISTS (
          SELECT 1
          FROM poker_transfers existing

          WHERE existing.session_id =
            s.id

            AND existing.direction =
              'table_to_wallet'
        )
    `)
      .bind(
        transferId,

        tableId,

        stack,

        stack,

        idempotencyKey,

        sessionId,
        playerId,
        tableId,
        stack
      );


  /* ============================================================
     STEP 4
     CLOSE SESSION

     Only finalizes after the transfer record exists.
     ============================================================ */

  const closeSession =
    DB.prepare(`
      UPDATE poker_sessions

      SET
        ending_stack = ?,

        current_stack = 0,

        status = 'left',

        last_seen_at =
          CURRENT_TIMESTAMP,

        left_at =
          CURRENT_TIMESTAMP

      WHERE id = ?
        AND player_id = ?
        AND table_id = ?
        AND status = 'leaving'
        AND current_stack = ?

        AND EXISTS (
          SELECT 1
          FROM poker_transfers pt

          WHERE pt.id = ?
            AND pt.session_id =
              poker_sessions.id

            AND pt.direction =
              'table_to_wallet'
        )
    `)
      .bind(
        stack,

        sessionId,
        playerId,
        tableId,
        stack,

        transferId
      );


  /* ============================================================
     RUN TRANSACTION
     ============================================================ */

  try {

    await DB.batch([
      markLeaving,
      creditWallet,
      insertTransfer,
      closeSession
    ]);

  } catch (error) {

    console.error(
      "POKER LEAVE BATCH ERROR:",
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
        "idx_poker_one_table_cashout"
      )
    ) {
      return json(
        {
          ok: false,

          error:
            "This poker session has already been cashed out."
        },
        409
      );
    }


    if (
      message.includes(
        "idempotency_key"
      )
    ) {
      return json(
        {
          ok: false,

          error:
            "This leave-table request was already processed."
        },
        409
      );
    }


    return json(
      {
        ok: false,

        error:
          "Could not return poker chips to the wallet.",

        debug:
          message
      },
      500
    );
  }


  /* ============================================================
     VERIFY SESSION
     ============================================================ */

  const finalSession =
    await DB.prepare(`
      SELECT
        id,
        seat_number,
        ending_stack,
        current_stack,
        status,
        left_at

      FROM poker_sessions

      WHERE id = ?
        AND player_id = ?

      LIMIT 1
    `)
      .bind(
        sessionId,
        playerId
      )
      .first();


  if (
    !finalSession ||
    finalSession.status !== "left"
  ) {
    return json(
      {
        ok: false,

        error:
          "Poker leave request could not be completed. Refresh the table before trying again."
      },
      409
    );
  }


  /* ============================================================
     FINAL WALLET
     ============================================================ */

  const wallet =
    await DB.prepare(`
      SELECT
        chips,
        locked

      FROM wallets

      WHERE player_id = ?

      LIMIT 1
    `)
      .bind(
        playerId
      )
      .first();


  /* ============================================================
     SUCCESS
     ============================================================ */

  return json({
    ok: true,

    message:
      `Left ${session.table_name}. ${stack.toLocaleString()} chips returned to wallet.`,

    tableId,

    sessionId,

    seatNumber:
      Number(
        session.seat_number
      ),

    amountReturned:
      stack,

    pokerStack: 0,

    walletBalance:
      Number(
        wallet?.chips || 0
      ),

    walletLocked:
      Number(
        wallet?.locked || 0
      ) === 1,

    status:
      "left",

    transferId,

    idempotencyKey
  });
}


/* ============================================================
   CLOUDFLARE PAGES FUNCTION

   IMPORTANT:
   Only export onRequest.

   Do NOT export onRequestPost separately.
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
      "POKER LEAVE UNHANDLED ERROR:",
      error
    );


    return json(
      {
        ok: false,

        error:
          "Poker leave backend error.",

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