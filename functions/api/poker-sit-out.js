/* ============================================================
   CASA DE RÍOS — TEXAS HOLD'EM
   /functions/api/poker-sit-out.js

   ACTIONS:
   - sit_out
   - return

   RULES:
   - Cannot sit out in the middle of a hand you are playing.
   - Returning does not join an already-started hand.
   - Sit-out timer begins with sit_out_at.
   - Maximum sit-out time: poker_tables.sitout_limit_seconds.
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


  const action =
    String(
      body.action || ""
    )
      .trim()
      .toLowerCase();


  if (
    !playerId ||
    !playerSecret ||
    !tableId
  ) {
    return json(
      {
        ok: false,

        error:
          "Missing poker session information."
      },
      400
    );
  }


  if (
    action !== "sit_out" &&
    action !== "return"
  ) {
    return json(
      {
        ok: false,

        error:
          "Invalid poker sit-out action."
      },
      400
    );
  }


  /* ============================================================
     AUTH
     ============================================================ */

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


  /* ============================================================
     TABLE
     ============================================================ */

  const table =
    await DB.prepare(`
      SELECT
        id,
        name,

        status,

        sitout_limit_seconds

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

        status,

        sit_out_at,
        last_seen_at

      FROM poker_sessions

      WHERE table_id = ?
        AND player_id = ?

        AND status IN (
          'seated',
          'sitting_out',
          'disconnected'
        )

      LIMIT 1
    `)
      .bind(
        tableId,
        playerId
      )
      .first();


  if (!session) {
    return json(
      {
        ok: false,

        error:
          "You are not seated at this poker table."
      },
      404
    );
  }


  /* ============================================================
     SIT OUT
     ============================================================ */

  if (
    action === "sit_out"
  ) {

    if (
      session.status ===
      "sitting_out"
    ) {
      return json({
        ok: true,

        duplicate:
          true,

        message:
          "You are already sitting out.",

        session: {
          id:
            session.id,

          seatNumber:
            Number(
              session.seat_number
            ),

          stack:
            Number(
              session.current_stack ||
              0
            ),

          status:
            "sitting_out",

          sitOutAt:
            session.sit_out_at
        }
      });
    }


    /*
      A player currently participating in an
      active/settling hand must finish that hand.
    */

    const activeHand =
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
          session.id
        )
        .first();


    if (activeHand) {
      return json(
        {
          ok: false,

          error:
            `Finish Hand #${Number(
              activeHand.hand_number
            )} before sitting out.`,

          handId:
            activeHand.id
        },
        409
      );
    }


    const result =
      await DB.prepare(`
        UPDATE poker_sessions

        SET
          status =
            'sitting_out',

          sit_out_at =
            CURRENT_TIMESTAMP,

          last_seen_at =
            CURRENT_TIMESTAMP

        WHERE id = ?
          AND table_id = ?
          AND player_id = ?

          AND status IN (
            'seated',
            'disconnected'
          )
      `)
        .bind(
          session.id,
          tableId,
          playerId
        )
        .run();


    if (
      Number(
        result?.meta?.changes ||
        0
      ) !== 1
    ) {
      return json(
        {
          ok: false,

          error:
            "Poker session changed before sit-out could be applied."
        },
        409
      );
    }


    return json({
      ok: true,

      message:
        "You are now sitting out.",

      sitOutLimitSeconds:
        Number(
          table.sitout_limit_seconds ||
          600
        ),

      session: {
        id:
          session.id,

        seatNumber:
          Number(
            session.seat_number
          ),

        stack:
          Number(
            session.current_stack ||
            0
          ),

        status:
          "sitting_out",

        sitOutAt:
          new Date()
            .toISOString()
      }
    });
  }


  /* ============================================================
     RETURN TO TABLE
     ============================================================ */

  if (
    action === "return"
  ) {

    if (
      session.status ===
      "seated"
    ) {
      return json({
        ok: true,

        duplicate:
          true,

        message:
          "You are already active at the table.",

        session: {
          id:
            session.id,

          seatNumber:
            Number(
              session.seat_number
            ),

          stack:
            Number(
              session.current_stack ||
              0
            ),

          status:
            "seated"
        }
      });
    }


    /*
      If they have been sitting out longer than the
      table limit, don't silently reactivate them.

      Later we will auto-remove/cash them out.
    */

    if (
      session.status ===
        "sitting_out" &&
      session.sit_out_at
    ) {

      const sitOutStart =
        Date.parse(
          session.sit_out_at
        );


      const limitMs =
        Number(
          table.sitout_limit_seconds ||
          600
        ) * 1000;


      if (
        Number.isFinite(
          sitOutStart
        ) &&
        Date.now() -
          sitOutStart >=
          limitMs
      ) {
        return json(
          {
            ok: false,

            error:
              "Your sit-out limit has expired.",

            expired:
              true
          },
          409
        );
      }
    }


    const result =
      await DB.prepare(`
        UPDATE poker_sessions

        SET
          status =
            'seated',

          sit_out_at =
            NULL,

          last_seen_at =
            CURRENT_TIMESTAMP

        WHERE id = ?
          AND table_id = ?
          AND player_id = ?

          AND status IN (
            'sitting_out',
            'disconnected'
          )
      `)
        .bind(
          session.id,
          tableId,
          playerId
        )
        .run();


    if (
      Number(
        result?.meta?.changes ||
        0
      ) !== 1
    ) {
      return json(
        {
          ok: false,

          error:
            "Poker session changed before return could be applied."
        },
        409
      );
    }


    return json({
      ok: true,

      message:
        "You have returned to the table.",

      session: {
        id:
          session.id,

        seatNumber:
          Number(
            session.seat_number
          ),

        stack:
          Number(
            session.current_stack ||
            0
          ),

        status:
          "seated"
      }
    });
  }


  return json(
    {
      ok: false,

      error:
        "Invalid poker sit-out action."
    },
    400
  );
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
      "Poker sit-out backend error:",
      error
    );


    return json(
      {
        ok: false,

        error:
          "Poker sit-out backend error.",

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