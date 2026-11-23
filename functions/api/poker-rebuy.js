/* ============================================================
   CASA DE RÍOS — TEXAS HOLD'EM
   /functions/api/poker-rebuy.js

   BUSTED PLAYER REBUY

   Rules:
   - Existing poker session required.
   - Current table stack must be exactly 0.
   - Cannot rebuy while still involved in an active/settling hand.
   - Buy-in must be one of the table's approved amounts.
   - Wallet must have enough chips.
   - Chips move wallet -> table.
   - Transfer audit reason = top_up.
   ============================================================ */


/* ============================================================
   HELPERS
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


function makeId(prefix) {
  return (
    prefix +
    "-" +
    crypto.randomUUID()
  );
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


  const sessionId =
    String(
      body.sessionId || ""
    ).trim();


  const buyIn =
    Math.floor(
      Number(
        body.buyIn || 0
      )
    );


  const idempotencyKey =
    String(
      body.idempotencyKey || ""
    ).trim();


  if (
    !playerId ||
    !playerSecret ||
    !tableId ||
    !sessionId ||
    !idempotencyKey
  ) {
    return json(
      {
        ok: false,
        error:
          "Missing rebuy information."
      },
      400
    );
  }


  if (
    !Number.isInteger(buyIn) ||
    buyIn <= 0
  ) {
    return json(
      {
        ok: false,
        error:
          "Invalid rebuy amount."
      },
      400
    );
  }


  /* ============================================================
     IDEMPOTENCY
     ============================================================ */

  const existingTransfer =
    await DB.prepare(`
      SELECT
        id,
        amount,
        wallet_balance_after,
        table_stack_after

      FROM poker_transfers

      WHERE idempotency_key = ?

      LIMIT 1
    `)
      .bind(
        idempotencyKey
      )
      .first();


  if (existingTransfer) {
    return json({
      ok: true,

      duplicate: true,

      message:
        "Rebuy was already processed.",

      buyIn:
        Number(
          existingTransfer.amount ||
          0
        ),

      walletBalance:
        Number(
          existingTransfer.wallet_balance_after ||
          0
        ),

      pokerStack:
        Number(
          existingTransfer.table_stack_after ||
          0
        )
    });
  }


  /* ============================================================
     AUTH + WALLET
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
        ON w.player_id =
           p.id

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


  if (
    String(
      account.status || ""
    ) !== "active"
  ) {
    return json(
      {
        ok: false,

        error:
          `Player account is ${
            account.status ||
            "not active"
          }.`
      },
      409
    );
  }


  if (
    Number(
      account.locked || 0
    ) === 1
  ) {
    return json(
      {
        ok: false,
        error:
          "Wallet is locked."
      },
      409
    );
  }


  if (
    Number(
      account.chips || 0
    ) < buyIn
  ) {
    return json(
      {
        ok: false,

        error:
          "Not enough chips for this poker rebuy.",

        walletBalance:
          Number(
            account.chips || 0
          ),

        required:
          buyIn
      },
      409
    );
  }


  /* ============================================================
     TABLE / APPROVED BUY-IN
     ============================================================ */

  const table =
    await DB.prepare(`
      SELECT
        id,
        name,
        status

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


  const approvedBuyIn =
    await DB.prepare(`
      SELECT
        amount

      FROM poker_table_buyins

      WHERE table_id = ?
        AND amount = ?

      LIMIT 1
    `)
      .bind(
        tableId,
        buyIn
      )
      .first();


  if (!approvedBuyIn) {
    return json(
      {
        ok: false,
        error:
          "That rebuy amount is not approved for this table."
      },
      400
    );
  }


  /* ============================================================
     SESSION
     ============================================================ */

  const session =
    await DB.prepare(`
      SELECT
        id,
        table_id,
        player_id,
        seat_number,
        current_stack,
        status

      FROM poker_sessions

      WHERE id = ?
        AND table_id = ?
        AND player_id = ?

        AND status IN (
          'seated',
          'sitting_out',
          'disconnected'
        )

      LIMIT 1
    `)
      .bind(
        sessionId,
        tableId,
        playerId
      )
      .first();


  if (!session) {
    return json(
      {
        ok: false,
        error:
          "Active poker session not found."
      },
      404
    );
  }


  if (
    Number(
      session.current_stack ||
      0
    ) !== 0
  ) {
    return json(
      {
        ok: false,

        error:
          "Rebuy is only available when your poker stack reaches 0.",

        pokerStack:
          Number(
            session.current_stack ||
            0
          )
      },
      409
    );
  }


  /* ============================================================
     MAKE SURE OLD HAND IS FINISHED
     ============================================================ */

  const unfinishedHand =
    await DB.prepare(`
      SELECT
        h.id,
        h.hand_number,
        h.status

      FROM poker_hands h

      JOIN poker_hand_players hp
        ON hp.hand_id =
           h.id

      WHERE h.table_id = ?
        AND hp.session_id = ?

        AND h.status IN (
          'active',
          'settling'
        )

      LIMIT 1
    `)
      .bind(
        tableId,
        sessionId
      )
      .first();


  if (unfinishedHand) {
    return json(
      {
        ok: false,

        error:
          `Hand #${Number(
            unfinishedHand.hand_number
          )} must finish before you can rebuy.`
      },
      409
    );
  }


  /* ============================================================
     IDS
     ============================================================ */

  const transferId =
    makeId("PKT");


  /* ============================================================
     ADD CHIPS TO EXISTING TABLE SESSION
     ============================================================ */

  const updateSession =
  DB.prepare(`
    UPDATE poker_sessions

    SET
      current_stack = ?,

      status =
        'seated',

      sit_out_at =
        NULL,

      last_seen_at =
        CURRENT_TIMESTAMP

    WHERE id = ?
      AND table_id = ?
      AND player_id = ?

      AND current_stack = 0

      AND status IN (
        'seated',
        'sitting_out',
        'disconnected'
      )

      /* Wallet must STILL be able to fund the rebuy */
      AND EXISTS (
        SELECT 1

        FROM wallets w

        WHERE w.player_id = poker_sessions.player_id
          AND w.chips >= ?
          AND COALESCE(
                w.locked,
                0
              ) = 0
      )

      /* Player cannot still belong to an unfinished hand */
      AND NOT EXISTS (
        SELECT 1

        FROM poker_hand_players hp

        JOIN poker_hands h
          ON h.id =
             hp.hand_id

        WHERE hp.session_id =
              poker_sessions.id

          AND h.status IN (
            'active',
            'settling'
          )
      )
  `)
    .bind(
      buyIn,

      sessionId,
      tableId,
      playerId,

      buyIn
    );


  /* ============================================================
     DEBIT WALLET
     ============================================================ */

  const debitWallet =
    DB.prepare(`
      UPDATE wallets

      SET
        chips =
          chips - ?,

        updated_at =
          CURRENT_TIMESTAMP

      WHERE player_id = ?
        AND chips >= ?
        AND COALESCE(
              locked,
              0
            ) = 0

        AND EXISTS (
          SELECT 1

          FROM poker_sessions s

          WHERE s.id = ?
            AND s.table_id = ?
            AND s.player_id = ?
            AND s.current_stack = ?
            AND s.status =
                'seated'
        )
    `)
      .bind(
        buyIn,

        playerId,
        buyIn,

        sessionId,
        tableId,
        playerId,
        buyIn
      );


  /* ============================================================
     TRANSFER AUDIT
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

        s.table_id,
        s.id,
        s.player_id,

        'wallet_to_table',
        'top_up',

        ?,

        w.chips + ?,
        w.chips,

        0,
        s.current_stack,

        ?,

        CURRENT_TIMESTAMP

      FROM poker_sessions s

      JOIN wallets w
        ON w.player_id =
           s.player_id

      WHERE s.id = ?
        AND s.table_id = ?
        AND s.player_id = ?

        AND s.current_stack = ?
        AND s.status =
            'seated'
    `)
      .bind(
        transferId,

        buyIn,
        buyIn,

        idempotencyKey,

        sessionId,
        tableId,
        playerId,

        buyIn
      );


  /* ============================================================
     CASINO LEDGER
     ============================================================ */

  const insertLedger =
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
        s.player_id,

        'poker_table_buyin',
        'poker',

        ?,

        w.chips,

        ?,

        CURRENT_TIMESTAMP

      FROM poker_sessions s

      JOIN wallets w
        ON w.player_id =
           s.player_id

      WHERE s.id = ?
        AND s.table_id = ?
        AND s.player_id = ?
        AND s.current_stack = ?
    `)
      .bind(
        -buyIn,

        `Poker rebuy: ${table.name}, Seat ${Number(
          session.seat_number
        )}`,

        sessionId,
        tableId,
        playerId,
        buyIn
      );


  /* ============================================================
     RUN TRANSACTION
     ============================================================ */

  try {

    await DB.batch([
      updateSession,
      debitWallet,
      insertTransfer,
      insertLedger
    ]);


  } catch (error) {

    console.error(
      "Poker rebuy batch failed:",
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
        "idempotency_key"
      )
    ) {
      return json(
        {
          ok: false,

          error:
            "This rebuy request was already processed."
        },
        409
      );
    }


    return json(
      {
        ok: false,

        error:
          "Could not complete poker rebuy.",

        debug:
          message
      },
      500
    );
  }


  /* ============================================================
     VERIFY
     ============================================================ */

/* ============================================================
   VERIFY
   ============================================================ */

const updatedSession =
  await DB.prepare(`
    SELECT
      current_stack,
      status

    FROM poker_sessions

    WHERE id = ?
      AND table_id = ?
      AND player_id = ?

    LIMIT 1
  `)
    .bind(
      sessionId,
      tableId,
      playerId
    )
    .first();


const wallet =
  await DB.prepare(`
    SELECT
      chips

    FROM wallets

    WHERE player_id = ?

    LIMIT 1
  `)
    .bind(
      playerId
    )
    .first();


if (
  Number(
    updatedSession?.current_stack ||
    0
  ) !== buyIn
) {
  return json(
    {
      ok: false,

      error:
        "Rebuy did not complete. Refresh the table and try again."
    },
    409
  );
}

  return json({
    ok: true,

    message:
      `Rebuy complete — ${buyIn.toLocaleString()} chips added.`,

    session: {
      id:
        sessionId,

      seatNumber:
        Number(
          session.seat_number
        ),

      currentStack:
        Number(
          updatedSession.current_stack ||
          0
        ),

      status:
        updatedSession.status
    },

    walletBalance:
      Number(
        wallet?.chips ||
        0
      ),

    buyIn
  });
}


/* ============================================================
   CLOUDFLARE PAGES
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
      "Poker rebuy backend error:",
      error
    );


    return json(
      {
        ok: false,

        error:
          "Poker rebuy backend error.",

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