function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        }
    });
}

function cleanString(value) {
    return String(value ?? "").trim();
}

function makeId(prefix) {
    return `${prefix}-${crypto.randomUUID()}`;
}

export async function onRequestPost(context) {
    const DB = context.env.DB;

    if (!DB) {
        return json(
            {
                ok: false,
                error: "Poker database is not configured."
            },
            500
        );
    }

    let body;

    try {
        body = await context.request.json();
    }   catch {
        return json(
            {
                ok: false,
                error: "Invalid JSON body."
            },
            400
        );
    }

    const playerId = cleanString(body.playerId);
    const playerSecret = cleanString(body.playerSecret);
    const tableId = cleanString(body.tableId || "poker-room-1");

    const seatNumber = Math.floor(Number(body.seatNumber));
    const buyIn = Math.floor(Number(body.buyIn));

    const idempotencyKey =
        cleanString(body.idempotencyKey) ||
        `poker-sit-${crypto.randomUUID()}`;

    if (!playerId || !playerSecret) {
        return json(
            {
                ok: false,
                error: "Player login is missing."
            },
            400
        );
    }

    if (!tableId) {
        return json(
            {
                ok: false,
                error: "Poker table is required."
            },
            400
        );
    }

    if (
        !Number.isInterger(seatNumber) ||
        seatNumber < 1 ||
        seatNumber > 10
    ) {
        return json(
            {
                ok: false,
                error: "Invalid seat number."
            },
            400
        );
    }

    if (!Number.isInterger(buyIn) || buyIn <= 0) {
        return json(
            {
                ok:false,
                error:"Invalid poker buy-in."
            },
            400
        );
    }

    /* ========================================================================================
        IDEMPOTENCY CHECK
        ====================================================================================== */ 
    
    const existingTransfer = await DB.prepare(`
        SELECT
            pt.id AS transfer_id,
            pt.session_id,
            pt.table_id,
            pt.amount,
            pt.wallet_balance_after,
            pt.table_stack_after,
            ps.seat_number,
            ps.status AS session_status
        FROM poker_transfers pt
        LEFT JOIN poker_sessions ps
            ON  ps.id = pt.session_id
        WHERE pt.idempotency_key = ?
        LIMIT 1
        `)
            .bind(idempotencyKey)
            .first();

    if (existingTransfer) {
        if (
            existingTransfer.player_id !== playerId ||
            existingTransfer.table_id !== tableId ||
            Number(existingTransfer.amount) !== buyIn
        ) {
            return json(
                {
                    ok:false,
                    error:
                        "Idempotency key was already used for another request."
                },
                409
            );
        }

        return json({
            ok: true, 
            duplicate: true,
            message: "Player is already seated from this request.",
            tableId: existingTransfer.table_id,
            sessionId: existingTransfer.session_id,
            seatNumber: Number(existingTransfer.seat_number),
            buyIn: Number(existingTransfer.amount),
            pokerStack: Number(existingTransfer.table_stack_after),
            walletBalance: Number(existingTransfer.wallet_balance_after),
            status: existingTransfer.session_status || "seated"
        });
    }
    
    const table = await DB.prepare(`
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
            status
        FROM poker_tables
        WHERE id = ?
        LIMIT 1
    `)
        .bind(tableId)
        .first();

    if (!table) {
        return json(
            {
                ok:false,
                error:"Poker table not found."
            },
            404
        );
    }

    if (table.status !== "open") {
        return json(
            {
            ok: false,
            error: "This poker table is not open."    
            },
            409
        );
    }

    if (seatNumber > Number(table.max_players)) {
        return json(
            {
                ok: false,
                error: `Seat ${seatNumber} does not exist at this table.`
            },
            400
        );
    }

    const allowedBuyIn = await DB.prepare(`
        SELECT amount
        FROM poker_table_buyins
        WHERE table_id = ?
            AND amount = ? 
        LIMIT 1
    `)
        .bind(tableId, buyIn)
        .first();

    if (!allowedBuyIn) {
        return json(
            {
                ok: false,
                error: "That buy-in is not allowed at this table."
            },
            400
        );
    }

    const account = await DB.prepare(`\
        SELECT
            p.id,
            p.status,
            w.chips,
            w.locked,
        FROM players p
        JOIN wallets w
            ON w.player_id = p.id
        WHERE p.id = ? 
            AND p.player_secret = ?
        LIMIT 1
    `)
        .bind(playerId, playerSecret)
        .first();

    if (!account) {
        return json(
            {
                ok: false,
                error: "Player authentication failed."
            },
            401
        );
    }

      if (String(account.status || "") !== "active") {
    return json(
      {
        ok: false,
        error:
          `Player account is ${account.status || "not active"}.`
      },
      409
    );
  }

  if (Number(account.locked || 0) === 1) {
    return json(
      {
        ok: false,
        error: "Wallet is locked."
      },
      409
    );
  }

  if (Number(account.chips || 0) < buyIn) {
    return json(
      {
        ok: false,
        error: "Not enough chips for this poker buy-in.",
        walletBalance: Number(account.chips || 0),
        required: buyIn
      },
      409
    );
  }

  /* ============================================================
     CURRENT SESSION CHECK
     ============================================================ */

  const existingSession = await DB.prepare(`
    SELECT
      id,
      table_id,
      seat_number,
      current_stack,
      status
    FROM poker_sessions
    WHERE table_id = ?
      AND player_id = ?
      AND status IN (
        'seated',
        'sitting_out',
        'disconnected',
        'leaving'
      )
    LIMIT 1
  `)
    .bind(tableId, playerId)
    .first();

  if (existingSession) {
    return json(
      {
        ok: false,
        error: "You are already seated at this poker table.",
        sessionId: existingSession.id,
        seatNumber: Number(existingSession.seat_number),
        pokerStack: Number(
          existingSession.current_stack || 0
        ),
        status: existingSession.status
      },
      409
    );
  }

  const occupiedSeat = await DB.prepare(`
    SELECT
      id,
      player_id
    FROM poker_sessions
    WHERE table_id = ?
      AND seat_number = ?
      AND status IN (
        'seated',
        'sitting_out',
        'disconnected',
        'leaving'
      )
    LIMIT 1
  `)
    .bind(tableId, seatNumber)
    .first();

  if (occupiedSeat) {
    return json(
      {
        ok: false,
        error: "That seat is already occupied."
      },
      409
    );
  }

  /* ============================================================
     IDS
     ============================================================ */

  const sessionId = makeId("PKS");
  const transferId = makeId("PKT");

  /* ============================================================
     CREATE SESSION
     ============================================================ */

  const insertSession = DB.prepare(`
    INSERT INTO poker_sessions (
      id,
      table_id,
      player_id,
      seat_number,
      buy_in,
      starting_stack,
      current_stack,
      status,
      joined_at,
      last_seen_at
    )
    SELECT
      ?,
      ?,
      p.id,
      ?,
      ?,
      ?,
      ?,
      'seated',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM players p
    JOIN wallets w
      ON w.player_id = p.id
    WHERE p.id = ?
      AND p.player_secret = ?
      AND p.status = 'active'
      AND COALESCE(w.locked, 0) = 0
      AND w.chips >= ?

      AND EXISTS (
        SELECT 1
        FROM poker_tables t
        WHERE t.id = ?
          AND t.status = 'open'
          AND ? BETWEEN 1 AND t.max_players
      )

      AND EXISTS (
        SELECT 1
        FROM poker_table_buyins b
        WHERE b.table_id = ?
          AND b.amount = ?
      )

      AND NOT EXISTS (
        SELECT 1
        FROM poker_sessions s
        WHERE s.table_id = ?
          AND s.player_id = p.id
          AND s.status IN (
            'seated',
            'sitting_out',
            'disconnected',
            'leaving'
          )
      )

      AND NOT EXISTS (
        SELECT 1
        FROM poker_sessions s
        WHERE s.table_id = ?
          AND s.seat_number = ?
          AND s.status IN (
            'seated',
            'sitting_out',
            'disconnected',
            'leaving'
          )
      )
  `).bind(
    sessionId,
    tableId,
    seatNumber,
    buyIn,
    buyIn,
    buyIn,

    playerId,
    playerSecret,
    buyIn,

    tableId,
    seatNumber,

    tableId,
    buyIn,

    tableId,

    tableId,
    seatNumber
  );

  /* ============================================================
     DEBIT MAIN WALLET
     ============================================================ */

  const debitWallet = DB.prepare(`
    UPDATE wallets
    SET
      chips = chips - ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE player_id = ?
      AND chips >= ?
      AND COALESCE(locked, 0) = 0
      AND EXISTS (
        SELECT 1
        FROM poker_sessions s
        WHERE s.id = ?
          AND s.table_id = ?
          AND s.player_id = ?
          AND s.current_stack = ?
          AND s.status = 'seated'
      )
  `).bind(
    buyIn,
    playerId,
    buyIn,
    sessionId,
    tableId,
    playerId,
    buyIn
  );

  /* ============================================================
     POKER TRANSFER AUDIT
     ============================================================ */

  const insertTransfer = DB.prepare(`
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
      'wallet_to_table',
      'sit_down',
      ?,
      w.chips + ?,
      w.chips,
      0,
      s.current_stack,
      ?,
      CURRENT_TIMESTAMP
    FROM poker_sessions s
    JOIN wallets w
      ON w.player_id = s.player_id
    WHERE s.id = ?
      AND s.table_id = ?
      AND s.player_id = ?
      AND s.current_stack = ?
      AND s.status = 'seated'
  `).bind(
    transferId,
    tableId,
    buyIn,
    buyIn,
    idempotencyKey,
    sessionId,
    tableId,
    playerId,
    buyIn
  );

  /* ============================================================
     MAIN CASINO LEDGER ENTRY
     ============================================================ */

  const insertCasinoLedger = DB.prepare(`
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
      ON w.player_id = s.player_id
    WHERE s.id = ?
      AND s.table_id = ?
      AND s.player_id = ?
      AND s.status = 'seated'
  `).bind(
    -buyIn,
    `Poker buy-in: ${table.name}, Seat ${seatNumber}`,
    sessionId,
    tableId,
    playerId
  );

  /* ============================================================
     RUN AS ONE D1 BATCH
     ============================================================ */

  try {
    await DB.batch([
      insertSession,
      debitWallet,
      insertTransfer,
      insertCasinoLedger
    ]);
  } catch (error) {
    console.error("poker-sit batch failed:", error);

    const message = String(
      error?.message || error || ""
    );

    if (
      message.includes("idx_poker_active_seat") ||
      message.includes(
        "UNIQUE constraint failed: poker_sessions.table_id, poker_sessions.seat_number"
      )
    ) {
      return json(
        {
          ok: false,
          error: "That seat was just taken by another player."
        },
        409
      );
    }

    if (
      message.includes("idx_poker_active_player") ||
      message.includes(
        "UNIQUE constraint failed: poker_sessions.table_id, poker_sessions.player_id"
      )
    ) {
      return json(
        {
          ok: false,
          error:
            "You are already seated at this poker table."
        },
        409
      );
    }

    if (message.includes("idempotency_key")) {
      return json(
        {
          ok: false,
          error:
            "This sit-down request was already processed."
        },
        409
      );
    }

    return json(
      {
        ok: false,
        error:
          "Could not move chips to the poker table."
      },
      500
    );
  }

  /* ============================================================
     VERIFY SESSION WAS CREATED
     ============================================================ */

  const session = await DB.prepare(`
    SELECT
      id,
      table_id,
      player_id,
      seat_number,
      buy_in,
      starting_stack,
      current_stack,
      status,
      joined_at
    FROM poker_sessions
    WHERE id = ?
      AND table_id = ?
      AND player_id = ?
    LIMIT 1
  `)
    .bind(sessionId, tableId, playerId)
    .first();

  if (!session) {
    return json(
      {
        ok: false,
        error:
          "Seat or wallet availability changed before the buy-in completed. Refresh the table and try again."
      },
      409
    );
  }

  /* ============================================================
     LOAD NEW WALLET BALANCE
     ============================================================ */

  const wallet = await DB.prepare(`
    SELECT
      chips,
      locked
    FROM wallets
    WHERE player_id = ?
    LIMIT 1
  `)
    .bind(playerId)
    .first();

  /* ============================================================
     SUCCESS RESPONSE
     ============================================================ */

  return json({
    ok: true,

    message: `Seated at ${table.name}.`,

    table: {
      id: table.id,
      name: table.name,
      maxPlayers: Number(table.max_players),
      smallBlind: Number(table.small_blind),
      bigBlind: Number(table.big_blind),
      rakePercent:
        Number(table.rake_basis_points) / 100,
      rakeCap: Number(table.rake_cap),
      noFlopNoDrop:
        Number(table.no_flop_no_drop) === 1,
      turnSeconds: Number(table.turn_seconds)
    },

    session: {
      id: session.id,
      seatNumber: Number(session.seat_number),
      buyIn: Number(session.buy_in),
      pokerStack: Number(session.current_stack),
      status: session.status
    },

    wallet: {
      balanceAfter: Number(wallet?.chips || 0),
      locked:
        Number(wallet?.locked || 0) === 1
    },

    transferId,
    idempotencyKey
  });
}

export async function onRequest(context) {
    try {
        if (context.request.method === "POST") {
            return await onRequestPost(context);
  }

  return json(
    {
      ok: false,
      error: "Method not allowed."
    },
    405
  );
} catch (error) {
    console.error("POKER SIT UNHANDLED ERROR:", error);

    return json(
        {
            ok: false,
            error: "Poker sit backend error.",
            debug: String(
                error?.message ||
                error ||
                "Unknown backend error"
            )
        },
        500
        );
    }
}