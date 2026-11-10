/* ============================================================
   CASA DE RÍOS — TEXAS HOLD'EM
   poker.js

   Current responsibilities:
   - Load Casa de Ríos wallet
   - Select poker seat
   - Select approved buy-in
   - POST sit-down request to /api/poker-sit
   - Move wallet chips into poker stack
   - Remember successful poker session locally
   - Prevent accidental duplicate sit requests

   NEXT:
   - /api/poker-table-state
   - Live occupied seats
   - /api/poker-leave
   - Multiplayer hand engine
   ============================================================ */


/* ============================================================
   STORAGE KEYS
   ============================================================ */

const PLAYER_KEY = "casa_rios_player_id";
const PLAYER_SECRET_KEY = "casa_rios_player_secret";

const POKER_SESSION_KEY = "casa_rios_poker_session";
const POKER_PENDING_SIT_KEY = "casa_rios_poker_pending_sit";
const POKER_PENDING_LEAVE_KEY = "casa_rios_poker_pending_leave";

/* ============================================================
   TABLE CONFIG
   ============================================================ */

const TABLE_ID = "poker-room-1";

const APPROVED_BUYINS = [
  10000,
  25000,
  50000,
  100000
];


/* ============================================================
   STATE
   ============================================================ */

let walletBalance = null;

let selectedSeat = null;
let selectedBuyin = null;

let pokerSession = null;

let submittingSit = false;

let loadingTableState = false;

let tableStateFailures = 0;
let tableStateTimer = null;
let tableStatePollingEnabled = false;

const TABLE_STATE_POLL_MS = 2000;
const TABLE_STATE_MAX_FAILURES = 3;

/* ============================================================
   DOM
   ============================================================ */

const walletBalanceEl =
  document.getElementById("walletBalance");

const pokerStackEl =
  document.getElementById("pokerStack");

const pokerStatusEl =
  document.getElementById("playerPokerStatus");

const selectedSeatText =
  document.getElementById("selectedSeatText");

const selectedBuyinText =
  document.getElementById("selectedBuyinText");

const sitDownBtn =
  document.getElementById("sitDownBtn");

const leaveTableBtn =
  document.getElementById("leaveTableBtn");

const pokerMessage =
  document.getElementById("pokerMessage");


/* ============================================================
   HELPERS
   ============================================================ */

function money(value) {
  return Math.floor(
    Number(value || 0)
  ).toLocaleString();
}


function getPlayerCredentials() {
  return {
    playerId:
      localStorage.getItem(PLAYER_KEY),

    playerSecret:
      localStorage.getItem(PLAYER_SECRET_KEY)
  };
}


function setText(element, value) {
  if (!element) return;

  element.textContent = value;
}


function setMessage(message, tone = "") {
  if (!pokerMessage) return;

  pokerMessage.textContent = message;

  pokerMessage.classList.remove(
    "good",
    "bad",
    "warn"
  );

  if (tone) {
    pokerMessage.classList.add(tone);
  }
}


function makeIdempotencyKey() {
  if (crypto.randomUUID) {
    return (
      "poker-sit-" +
      crypto.randomUUID()
    );
  }

  return (
    "poker-sit-" +
    Date.now() +
    "-" +
    Math.random()
      .toString(36)
      .slice(2)
  );
}


/* ============================================================
   LOCAL POKER SESSION
   ============================================================ */

function loadSavedPokerSession() {
  const raw =
    localStorage.getItem(
      POKER_SESSION_KEY
    );

  if (!raw) {
    pokerSession = null;
    return;
  }

  try {
    const parsed = JSON.parse(raw);

    if (
      !parsed ||
      parsed.tableId !== TABLE_ID ||
      !parsed.sessionId
    ) {
      localStorage.removeItem(
        POKER_SESSION_KEY
      );

      pokerSession = null;
      return;
    }

    pokerSession = parsed;

  } catch {
    localStorage.removeItem(
      POKER_SESSION_KEY
    );

    pokerSession = null;
  }
}


function savePokerSession(session) {
  pokerSession = session;

  localStorage.setItem(
    POKER_SESSION_KEY,
    JSON.stringify(session)
  );
}


function clearPokerSession() {
  pokerSession = null;

  localStorage.removeItem(
    POKER_SESSION_KEY
  );
}


/* ============================================================
   PENDING SIT REQUEST

   If the network dies after the server processes a buy-in,
   this lets the next click reuse the SAME idempotency key.

   That prevents the same player from being charged twice.
   ============================================================ */

function getPendingSit() {
  const raw =
    sessionStorage.getItem(
      POKER_PENDING_SIT_KEY
    );

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    sessionStorage.removeItem(
      POKER_PENDING_SIT_KEY
    );

    return null;
  }
}


function savePendingSit(data) {
  sessionStorage.setItem(
    POKER_PENDING_SIT_KEY,
    JSON.stringify(data)
  );
}


function clearPendingSit() {
  sessionStorage.removeItem(
    POKER_PENDING_SIT_KEY
  );
}


/* ============================================================
   WALLET
   ============================================================ */

async function loadWallet() {
  const {
    playerId,
    playerSecret
  } = getPlayerCredentials();

  if (!playerId || !playerSecret) {
    walletBalance = 0;

    setText(
      walletBalanceEl,
      "0"
    );

    setMessage(
      "Create and save your player profile from the lobby first.",
      "bad"
    );

    updateControls();

    return;
  }

  setText(
    walletBalanceEl,
    "..."
  );

  try {
    const response = await fetch(
      "/api/wallet?playerId=" +
      encodeURIComponent(playerId) +
      "&playerSecret=" +
      encodeURIComponent(playerSecret),
      {
        method: "GET",
        cache: "no-store"
      }
    );

    const data =
      await response.json();

    if (!data.ok) {
      walletBalance = 0;

      setText(
        walletBalanceEl,
        "0"
      );

      setMessage(
        data.error ||
          "Wallet could not be loaded.",
        "bad"
      );

      updateControls();

      return;
    }

    const player =
      data.player || {};

    const balance =
      data.chips ??
      data.balance ??
      player.chips ??
      player.balance ??
      0;

    walletBalance =
      Number(balance || 0);

    setText(
      walletBalanceEl,
      money(walletBalance)
    );

    if (!pokerSession) {
      setMessage(
        "Select an open seat and buy-in.",
        ""
      );
    }

    updateControls();

  } catch (error) {
    console.error(
      "Poker wallet load failed:",
      error
    );

    walletBalance = 0;

    setText(
      walletBalanceEl,
      "0"
    );

    setMessage(
      "Wallet connection error.",
      "bad"
    );

    updateControls();
  }
}


/* ============================================================
   SEAT SELECTION
   ============================================================ */

function clearSeatHighlights() {
  document
    .querySelectorAll(".poker-seat")
    .forEach((seat) => {
      seat.classList.remove(
        "selected"
      );
    });
}


function selectSeat(seatNumber) {
  if (pokerSession) {
    setMessage(
      "You are already seated at this table.",
      "warn"
    );

    return;
  }

  const seat =
    document.querySelector(
      `.poker-seat[data-seat="${seatNumber}"]`
    );

  if (!seat) return;

  if (
    seat.classList.contains(
      "occupied"
    )
  ) {
    setMessage(
      "That seat is occupied.",
      "bad"
    );

    return;
  }

  selectedSeat =
    Number(seatNumber);

  clearSeatHighlights();

  seat.classList.add(
    "selected"
  );

  setText(
    selectedSeatText,
    `Seat ${selectedSeat}`
  );

  updateControls();

  if (selectedBuyin) {
    setMessage(
      `Seat ${selectedSeat} selected. Ready to sit down.`,
      "good"
    );
  } else {
    setMessage(
      `Seat ${selectedSeat} selected. Choose your buy-in.`,
      ""
    );
  }
}


/* ============================================================
   BUY-IN SELECTION
   ============================================================ */

function clearBuyinHighlights() {
  document
    .querySelectorAll(
      ".poker-buyin"
    )
    .forEach((button) => {
      button.classList.remove(
        "selected"
      );
    });
}


function selectBuyin(amount) {
  if (pokerSession) {
    setMessage(
      "You are already seated at this table.",
      "warn"
    );

    return;
  }

  const buyin =
    Number(amount);

  if (
    !APPROVED_BUYINS.includes(
      buyin
    )
  ) {
    setMessage(
      "Invalid poker buy-in.",
      "bad"
    );

    return;
  }

  if (
    walletBalance !== null &&
    walletBalance < buyin
  ) {
    setMessage(
      `You need ${money(buyin)} chips for that buy-in.`,
      "bad"
    );

    return;
  }

  selectedBuyin =
    buyin;

  clearBuyinHighlights();

  const button =
    document.querySelector(
      `.poker-buyin[data-buyin="${buyin}"]`
    );

  button?.classList.add(
    "selected"
  );

  setText(
    selectedBuyinText,
    money(buyin)
  );

  updateControls();

  if (selectedSeat) {
    setMessage(
      `${money(buyin)} buy-in selected. Ready to sit down.`,
      "good"
    );
  } else {
    setMessage(
      `${money(buyin)} buy-in selected. Choose a seat.`,
      ""
    );
  }
}


/* ============================================================
   CONTROLS
   ============================================================ */

function updateControls() {
  if (!sitDownBtn) return;

  if (pokerSession) {
    sitDownBtn.disabled = true;

    sitDownBtn.textContent =
      "SEATED";

    if (leaveTableBtn) {
      leaveTableBtn.hidden = false;
    }

    return;
  }

  if (leaveTableBtn) {
    leaveTableBtn.hidden = true;
  }

  sitDownBtn.textContent =
    submittingSit
      ? "SITTING..."
      : "SIT DOWN";

  if (submittingSit) {
    sitDownBtn.disabled = true;
    return;
  }

  const hasSelection =
    Number.isInteger(
      selectedSeat
    ) &&
    APPROVED_BUYINS.includes(
      selectedBuyin
    );

  const canAfford =
    walletBalance !== null &&
    walletBalance >=
      Number(
        selectedBuyin || 0
      );

  sitDownBtn.disabled =
    !hasSelection ||
    !canAfford;
}


/* ============================================================
   RESTORE VISUAL SESSION
   ============================================================ */

function renderSavedSession() {
  if (!pokerSession) {
    setText(
      pokerStackEl,
      "0"
    );

    setText(
      pokerStatusEl,
      "Not Seated"
    );

    return;
  }

  const seatNumber =
    Number(
      pokerSession.seatNumber
    );

  const stack =
    Number(
      pokerSession.pokerStack || 0
    );

  setText(
    pokerStackEl,
    money(stack)
  );

  setText(
    pokerStatusEl,
    "Seated"
  );

  setText(
    selectedSeatText,
    `Seat ${seatNumber}`
  );

  setText(
    selectedBuyinText,
    money(
      pokerSession.buyIn || stack
    )
  );

  const seat =
    document.querySelector(
      `.poker-seat[data-seat="${seatNumber}"]`
    );

  if (seat) {
    seat.classList.add(
      "occupied",
      "my-seat"
    );

    const playerEl =
      seat.querySelector(
        ".seat-player"
      );

    const stackEl =
      seat.querySelector(
        ".seat-stack"
      );

    if (playerEl) {
      playerEl.textContent =
        "You";
    }

    if (stackEl) {
      stackEl.textContent =
        `${money(stack)} chips`;
    }
  }

  setMessage(
    `You are seated at Poker Room 1 — Seat ${seatNumber}.`,
    "good"
  );

  updateControls();
}

/* ============================================================
  LIVE TABLE STATE
  ============================================================= */

function resetLiveSeats() {
  document
    .querySelectorAll(".poker-seat")
    .forEach((seat) => {

      seat.classList.remove(
        "occupied",
        "my-seat"
      );

      const playerEl =
        seat.querySelector(
          ".seat-player"
        );

      const stackEl =
        seat.querySelector(
          ".seat-stack"
        );

      if (playerEl) {
        playerEl.textContent =
          "Open";
      }

      if (stackEl) {
        stackEl.textContent =
          "";
      }
    });
}

/* ============================================================
   LIVE POKER HAND DISPLAY
   ============================================================ */

function renderHandState(data) {
  renderHandState(data);

  const hadLocalSession =
    Boolean(pokerSession);
    
  const hud =
    document.getElementById(
      "pokerHandHud"
    );

  const hand =
    data.hand || null;

  /* Clear old seat decorations */

  document
    .querySelectorAll(".poker-seat")
    .forEach((seat) => {
      seat.classList.remove(
        "current-turn",
        "folded",
        "all-in"
      );

      seat
        .querySelectorAll(
          ".poker-seat-marker, .poker-seat-status"
        )
        .forEach(
          (el) => el.remove()
        );
    });


  /* No active hand */

  if (!hand) {
    if (hud) {
      hud.hidden = true;
    }

    return;
  }


  /* Show HUD */

  if (hud) {
    hud.hidden = false;
  }


  /* Basic hand info */

  setText(
    document.getElementById(
      "pokerHandNumber"
    ),
    `#${hand.handNumber}`
  );

  setText(
    document.getElementById(
      "pokerStreet"
    ),
    String(
      hand.street || "preflop"
    ).toUpperCase()
  );

  setText(
    document.getElementById(
      "pokerPot"
    ),
    money(hand.pot || 0)
  );

  setText(
    document.getElementById(
      "pokerCurrentBet"
    ),
    money(
      hand.currentBet || 0
    )
  );

  setText(
    document.getElementById(
      "pokerMinRaise"
    ),
    money(
      hand.minRaise || 0
    )
  );


  /* ----------------------------------------
     CARD RENDERER
     ---------------------------------------- */

  function renderCards(
    elementId,
    cards
  ) {
    const el =
      document.getElementById(
        elementId
      );

    if (!el) return;

    const list =
      Array.isArray(cards)
        ? cards
        : [];

    const suitMap = {
      S: "♠",
      H: "♥",
      D: "♦",
      C: "♣"
    };

    el.innerHTML =
      list.map((card) => {
        const value =
          String(card)
            .trim()
            .toUpperCase();

        const suitCode =
          value.slice(-1);

        const rank =
          value.slice(0, -1);

        const suit =
          suitMap[suitCode] ||
          suitCode;

        const red =
          suitCode === "H" ||
          suitCode === "D";

        return `
          <div
            class="poker-card ${
              red
                ? "red"
                : "black"
            }"
          >
            <div class="poker-card-rank">
              ${rank}
            </div>

            <div class="poker-card-suit">
              ${suit}
            </div>

            <div class="poker-card-center">
              ${suit}
            </div>
          </div>
        `;
      }).join("");
  }


  renderCards(
    "pokerBoard",
    hand.board || []
  );

  renderCards(
    "pokerHoleCards",
    data.yourCards || []
  );


  /* ----------------------------------------
     POSITION MARKERS
     ---------------------------------------- */

  function marker(
    seatNumber,
    label,
    className
  ) {
    const seat =
      document.querySelector(
        `.poker-seat[data-seat="${seatNumber}"]`
      );

    if (!seat) return;

    const badge =
      document.createElement(
        "span"
      );

    badge.className =
      `poker-seat-marker ${className}`;

    badge.textContent =
      label;

    seat.appendChild(
      badge
    );
  }


  marker(
    hand.dealerSeat,
    "D",
    "dealer"
  );

  marker(
    hand.smallBlindSeat,
    "SB",
    "small-blind"
  );

  marker(
    hand.bigBlindSeat,
    "BB",
    "big-blind"
  );


  /* ----------------------------------------
     HAND PLAYER STATES
     ---------------------------------------- */

  const handPlayers =
    data.handPlayers || [];

  handPlayers.forEach(
    (player) => {
      const seat =
        document.querySelector(
          `.poker-seat[data-seat="${player.seatNumber}"]`
        );

      if (!seat) return;


      if (player.folded) {
        seat.classList.add(
          "folded"
        );
      }


      if (player.allIn) {
        seat.classList.add(
          "all-in"
        );
      }


      let statusText = "";


      if (player.folded) {
        statusText =
          "FOLDED";

      } else if (player.allIn) {
        statusText =
          "ALL IN";

      } else if (
        player.lastAction ===
        "post_small_blind"
      ) {
        statusText =
          `SB ${money(
            player.streetContributed
          )}`;

      } else if (
        player.lastAction ===
        "post_big_blind"
      ) {
        statusText =
          `BB ${money(
            player.streetContributed
          )}`;

      } else if (
        player.lastAction
      ) {
        statusText =
          String(
            player.lastAction
          )
            .replaceAll(
              "_",
              " "
            )
            .toUpperCase();
      }


      if (statusText) {
        const status =
          document.createElement(
            "div"
          );

        status.className =
          "poker-seat-status";

        status.textContent =
          statusText;

        seat.appendChild(
          status
        );
      }
    }
  );


  /* ----------------------------------------
     CURRENT TURN
     ---------------------------------------- */

  const currentTurnSeat =
    Number(
      hand.currentTurnSeat
    );

  const currentSeat =
    document.querySelector(
      `.poker-seat[data-seat="${currentTurnSeat}"]`
    );

  if (currentSeat) {
    currentSeat.classList.add(
      "current-turn"
    );
  }


  const yourSeat =
    data.yourSession
      ? Number(
          data.yourSession
            .seatNumber
        )
      : null;


  const isYourTurn =
    yourSeat !== null &&
    yourSeat ===
      currentTurnSeat;


  const turnBox =
    document.getElementById(
      "pokerTurnBox"
    );

  if (turnBox) {
    turnBox.classList.toggle(
      "your-turn",
      isYourTurn
    );
  }


  const turnPlayer =
    handPlayers.find(
      (player) =>
        Number(
          player.seatNumber
        ) ===
        currentTurnSeat
    );


  setText(
    document.getElementById(
      "pokerTurnText"
    ),

    isYourTurn
      ? "YOUR TURN"
      : turnPlayer
        ? `${turnPlayer.characterName}'s Turn`
        : "Waiting..."
  );


  /* ----------------------------------------
     TIMER
     ---------------------------------------- */

  const timer =
    document.getElementById(
      "pokerTurnTimer"
    );

  if (
    timer &&
    hand.actionDeadline
  ) {
    const deadline =
      new Date(
        hand.actionDeadline
      ).getTime();

    const serverTime =
      data.serverTime
        ? new Date(
            data.serverTime
          ).getTime()
        : Date.now();

    const seconds =
      Math.max(
        0,
        Math.ceil(
          (
            deadline -
            serverTime
          ) / 1000
        )
      );

    timer.textContent =
      `${seconds} sec`;
  }
}

/* ============================================================
   RENDER SERVER TABLE STATE
   ============================================================ */

   function renderTableState(data) {
    const hadLocalSession =
    Boolean(pokerSession)

    const seats = 
      Array.isArray(data.seats)
        ? data.seats
        : [];
    
    const yourSession = 
      data.yourSession ||
      null;

    const hadLocalSessions =
      Boolean(
        pokerSession?.sessionId
      );

/* ------------------------------------------------------------
   RESET LIVE OCCUPANCY
   ------------------------------------------------------------ */

resetLiveSeats();

/* ------------------------------------------------------------
   PAINT OCCUPIED SEATS
   ------------------------------------------------------------ */

seats.forEach(
  (player) => {

    const seatNumber = 
      Number(
        player.seatNumber
      );

    const seat = 
      document.querySelector(
        `.poker-seat[data-seat="${seatNumber}"]`
      );

    if (!seat) return;

    seat.classList.add(
      "occupied"
    );

    /*
        If a seat became occupied while this player
        had it selected, remove the selection.
      */

      if (
        !player.isYou &&
        selectedSeat === seatNumber
      ) {
        selectedSeat = null;

        seat.classList.remove(
          "selected"
        );

        setText(
          selectedSeatText,
          "None"
        );
      }


      if (player.isYou) {
        seat.classList.add(
          "my-seat"
        );

        seat.classList.remove(
          "selected"
        );
      }


      const playerEl =
        seat.querySelector(
          ".seat-player"
        );


      const stackEl =
        seat.querySelector(
          ".seat-stack"
        );


      /* ----------------------------------------
         PLAYER NAME
         ---------------------------------------- */

      let displayName =
        player.characterName ||
        "Player";


      if (
        player.status ===
        "sitting_out"
      ) {
        displayName +=
          " • Sitting Out";
      }


      if (
        player.status ===
        "disconnected"
      ) {
        displayName +=
          " • Disconnected";
      }


      if (
        player.status ===
        "leaving"
      ) {
        displayName +=
          " • Leaving";
      }


      if (playerEl) {
        playerEl.textContent =
          player.isYou
            ? `${displayName} • You`
            : displayName;
      }


      if (stackEl) {
        stackEl.textContent =
          `${money(player.stack)} chips`;
      }
    }
  );


  /* ==========================================================
     OUR SERVER SESSION EXISTS
     ========================================================== */

  if (yourSession) {

    const previousSession =
      pokerSession;


    const restoredSession = {
      tableId:
        data.table?.id ||
        TABLE_ID,

      tableName:
        data.table?.name ||
        "Poker Room 1",

      sessionId:
        yourSession.id,

      seatNumber:
        Number(
          yourSession.seatNumber
        ),

      buyIn:
        Number(
          yourSession.buyIn ||
          0
        ),

      pokerStack:
        Number(
          yourSession.pokerStack ||
          0
        ),

      status:
        yourSession.status ||
        "seated",

      transferId:
        previousSession?.transferId ||
        null,

      idempotencyKey:
        previousSession?.idempotencyKey ||
        null
    };


    savePokerSession(
      restoredSession
    );


    /*
      If the server has our seat, any pending sit request
      has already succeeded.
    */

    clearPendingSit();


    setText(
      pokerStackEl,
      money(
        restoredSession.pokerStack
      )
    );


    let statusText =
      "Seated";


    if (
      restoredSession.status ===
      "sitting_out"
    ) {
      statusText =
        "Sitting Out";
    }


    if (
      restoredSession.status ===
      "disconnected"
    ) {
      statusText =
        "Disconnected";
    }


    if (
      restoredSession.status ===
      "leaving"
    ) {
      statusText =
        "Leaving";
    }


    setText(
      pokerStatusEl,
      statusText
    );


    setText(
      selectedSeatText,
      `Seat ${restoredSession.seatNumber}`
    );


    setText(
      selectedBuyinText,
      money(
        restoredSession.buyIn
      )
    );


    if (
      !hadLocalSession
    ) {
      setMessage(
        `Poker session restored — Seat ${restoredSession.seatNumber}, ${money(restoredSession.pokerStack)} chips.`,
        "good"
      );
    }


    updateControls();

    return;
  }


  /* ==========================================================
     SERVER SAYS WE ARE NOT SEATED

     If localStorage still thinks we are seated, the local
     record is stale and should be removed.
     ========================================================== */

  if (hadLocalSession) {

    clearPokerSession();


    setText(
      pokerStackEl,
      "0"
    );


    setText(
      pokerStatusEl,
      "Not Seated"
    );


    setText(
      selectedSeatText,
      "None"
    );


    setText(
      selectedBuyinText,
      "None"
    );


    selectedSeat = null;
    selectedBuyin = null;


    clearSeatHighlights();
    clearBuyinHighlights();


    setMessage(
      "Your previous poker session is no longer active.",
      "warn"
    );
  }


  updateControls();

  renderHandState(data);
}


/* ============================================================
   LOAD TABLE STATE
   ============================================================ */

async function loadTableState() {
  if (loadingTableState) {
    return;
  }


  const {
    playerId,
    playerSecret
  } = getPlayerCredentials();


  if (
    !playerId ||
    !playerSecret
  ) {
    return;
  }


  loadingTableState = true;


  try {

    const response =
      await fetch(
        "/api/poker-table-state",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          cache:
            "no-store",

          body:
            JSON.stringify({
              playerId,
              playerSecret,

              tableId:
                TABLE_ID
            })
        }
      );


    const rawResponse =
      await response.text();


    let data;


    try {
      data =
        JSON.parse(
          rawResponse
        );

    } catch {
      throw new Error(
        `Table state returned HTTP ${response.status} with invalid JSON.`
      );
    }


   if (!data.ok) {
  tableStateFailures++;

  console.error(
    "Poker table state:",
    data.error,
    data.debug || ""
  );

  if (
    response.status >= 500 &&
    tableStateFailures >= TABLE_STATE_MAX_FAILURES
  ) {
    stopTableStatePolling();

    setMessage(
      "Live poker updates are temporarily unavailable.",
      "bad"
    );

    return;
  }

  return;
}

    tableStateFailures = 0;

    renderTableState(data);


} catch (error) {

  tableStateFailures++;

  console.error(
    "Poker table state failed:",
    error
  );

  if (
    tableStateFailures >=
      TABLE_STATE_MAX_FAILURES
  ) {
    stopTableStatePolling();

    setMessage(
      "Live poker updates are temporarily unavailable.",
      "bad"
    );
  }

} finally {
  loadingTableState = false;
}
}


/* ============================================================
   TABLE POLLING
   ============================================================ */

function scheduleTableStatePoll(
  delay = TABLE_STATE_POLL_MS
) {
  if (!tableStatePollingEnabled) {
    return;
  }

  if (tableStateTimer) {
    clearTimeout(tableStateTimer);
  }

  tableStateTimer =
    setTimeout(
      async () => {

        if (!tableStatePollingEnabled) {
          return;
        }

        if (
          document.visibilityState ===
          "visible"
        ) {
          await loadTableState();
        }

        if (tableStatePollingEnabled) {
          scheduleTableStatePoll(
            TABLE_STATE_POLL_MS
          );
        }

      },
      delay
    );
}


function startTableStatePolling() {
  tableStateFailures = 0;
  tableStatePollingEnabled = true;

  scheduleTableStatePoll();
}


function stopTableStatePolling() {
  tableStatePollingEnabled = false;

  if (tableStateTimer) {
    clearTimeout(tableStateTimer);
    tableStateTimer = null;
  }
}


/* ============================================================
   REFRESH IMMEDIATELY WHEN PLAYER RETURNS TO TAB
   ============================================================ */

document.addEventListener(
  "visibilitychange",
  () => {

    if (
      document.visibilityState ===
      "visible"
    ) {
      loadTableState();
    }
  }
);

/* ============================================================
   SIT DOWN
   ============================================================ */

async function sitDown() {
  if (submittingSit) return;

  if (pokerSession) {
    setMessage(
      "You are already seated.",
      "warn"
    );

    return;
  }

  const {
    playerId,
    playerSecret
  } = getPlayerCredentials();

  if (!playerId || !playerSecret) {
    setMessage(
      "Player login is missing. Return to the lobby and save your profile.",
      "bad"
    );

    return;
  }

  if (!selectedSeat) {
    setMessage(
      "Choose a seat first.",
      "bad"
    );

    return;
  }

  if (!selectedBuyin) {
    setMessage(
      "Choose a buy-in first.",
      "bad"
    );

    return;
  }

  if (
    !APPROVED_BUYINS.includes(
      selectedBuyin
    )
  ) {
    setMessage(
      "Invalid buy-in.",
      "bad"
    );

    return;
  }

  if (
    walletBalance === null
  ) {
    await loadWallet();
  }

  if (
    Number(walletBalance || 0) <
    selectedBuyin
  ) {
    setMessage(
      "Not enough chips for this buy-in.",
      "bad"
    );

    return;
  }

  submittingSit = true;

  updateControls();

  setMessage(
    `Moving ${money(selectedBuyin)} chips to Poker Room 1...`,
    "warn"
  );


  /* ==========================================================
     IDEMPOTENCY

     Reuse pending request if it matches the exact same
     seat + buy-in.

     Otherwise generate a brand new request key.
     ========================================================== */

  let pending =
    getPendingSit();

  if (
    !pending ||
    pending.tableId !== TABLE_ID ||
    Number(pending.seatNumber) !==
      selectedSeat ||
    Number(pending.buyIn) !==
      selectedBuyin
  ) {
    pending = {
      tableId: TABLE_ID,
      seatNumber:
        selectedSeat,

      buyIn:
        selectedBuyin,

      idempotencyKey:
        makeIdempotencyKey()
    };

    savePendingSit(
      pending
    );
  }


  try {
    const response =
      await fetch(
        "/api/poker-sit",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              playerId,
              playerSecret,

              tableId:
                TABLE_ID,

              seatNumber:
                selectedSeat,

              buyIn:
                selectedBuyin,

              idempotencyKey:
                pending.idempotencyKey
            })
        }
      );

    const rawResponse = 
      await response.text();

    let data;

    try {
        data = JSON.parse(rawResponse);
    } catch {
        throw new Error(
            `HTTP ${response.status} returned non-JSON` +
            rawResponse.slice(0, 250)
        );
    }

    if (!data.ok) {
     
      if (
        response.status !== 500
      ) {
        clearPendingSit();
      }

      setMessage(
        data.debug
            ? `${data.error} - ${data.debug}`
            : data.error ||
                "Could not sit at the poker table.",
        "bad"
      );

      submittingSit = false;

      updateControls();

      await loadWallet();

      return;
    }


    /* ========================================================
       SUCCESS
       ======================================================== */

    const sessionData =
      data.session || {};

    const walletData =
      data.wallet || {};

    const savedSession = {
      tableId:
        data.table?.id ||
        TABLE_ID,

      tableName:
        data.table?.name ||
        "Poker Room 1",

      sessionId:
        sessionData.id ||
        data.sessionId,

      seatNumber:
        Number(
          sessionData.seatNumber ??
          data.seatNumber
        ),

      buyIn:
        Number(
          sessionData.buyIn ??
          data.buyIn ??
          selectedBuyin
        ),

      pokerStack:
        Number(
          sessionData.pokerStack ??
          data.pokerStack ??
          selectedBuyin
        ),

      status:
        sessionData.status ||
        data.status ||
        "seated",

      transferId:
        data.transferId ||
        null,

      idempotencyKey:
        data.idempotencyKey ||
        pending.idempotencyKey
    };


    savePokerSession(
      savedSession
    );

    clearPendingSit();

    walletBalance =
      Number(
        walletData.balanceAfter ??
        data.walletBalance ??
        (
          walletBalance -
          selectedBuyin
        )
      );

    setText(
      walletBalanceEl,
      money(walletBalance)
    );

    submittingSit = false;

    clearSeatHighlights();
    clearBuyinHighlights();

    renderSavedSession();

    await loadTableState();

    setMessage(
      `Seated with ${money(savedSession.pokerStack)} chips. Wallet balance: ${money(walletBalance)}.`,
      "good"
    );

  } catch (error) {
    console.error(
      "Poker sit request failed:",
      error
    );

    /*
      IMPORTANT:
      DO NOT clear the pending idempotency key here.

      We don't know whether the server processed the request
      before the connection failed.

      Retrying will send the same key.
    */

    submittingSit = false;

    setMessage(
        error?.message ||    
      "Poker sit request failed.",
      "bad"
    );

    updateControls();
  }
}


/* ============================================================
   LEAVE TABLE PLACEHOLDER

   We intentionally DO NOT manipulate wallet/table chips from
   the browser.

   The next backend endpoint will be:
     POST /api/poker-leave

   That endpoint will return the poker stack to the wallet.
   ============================================================ */
function getPendingLeave() {
  const raw = sessionStorage.getItem(POKER_PENDING_LEAVE_KEY);
  if (!raw) return null;
  try {return JSON.parse(raw);
  } catch {sessionStorage.removeItem(POKER_PENDING_LEAVE_KEY); 
  } 
}

function savePendingLeave(data) {
  sessionStorage.setItem(POKER_PENDING_LEAVE_KEY , JSON.stringify(data)
);
}

function clearPendingLeave() {
  sessionStorage.removeItem(
    POKER_PENDING_LEAVE_KEY
  )
}

async function leaveTable() {
  if (!pokerSession) {
    setMessage(
      "You are not seated at a poker table.",
      "warn"
    );
    return;
  }

  const {
    playerId,
    playerSecret
  } = getPlayerCredentials();

  if (!playerId || !playerSecret) {
    setMessage(
      "Player login is missing.",
      "bad"
    );
    return;
  }

  const sessionId = pokerSession.sessionId;
  const seatNumber = Number(
    pokerSession.seatNumber
  );

  const stackBefore = Number(
    pokerSession.pokerStack || 0
  );

  if (!sessionId) {
    setMessage(
      "Poker session is missing. Refresh the page.",
      "bad"
    );

    return;
  }

  if (leaveTableBtn) {
    leaveTableBtn.disabled = true;

    leaveTableBtn.textContent = "LEAVING...";
  }

  setMessage(
    "Returning your poker stack to your wallet...",
    "warn"
  );


/* ============================================================
  IDEMPOTENCY

  If the network fails after the server processed the leave,
  the next attempt reuses this exact request key,
  ============================================================= */

  let pending =
    getPendingLeave();


  if (
    !pending ||
    pending.sessionId !== sessionId ||
    pending.tableId !== TABLE_ID
  ) {
    pending = {
      tableId:
        TABLE_ID,

      sessionId,

      idempotencyKey:
        "poker-leave-" +
        crypto.randomUUID()
    };


    savePendingLeave(
      pending
    );
  }


  try {

    const response =
      await fetch(
        "/api/poker-leave",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              playerId,
              playerSecret,

              tableId:
                TABLE_ID,

              sessionId,

              idempotencyKey:
                pending.idempotencyKey
            })
        }
      );


    const rawResponse =
      await response.text();


    let data;


    try {
      data =
        JSON.parse(
          rawResponse
        );

    } catch {
      throw new Error(
        `HTTP ${response.status} returned non-JSON: ` +
        rawResponse.slice(
          0,
          250
        )
      );
    }


    if (!data.ok) {

      if (
        response.status !== 500
      ) {
        clearPendingLeave();
      }


      setMessage(
        data.debug
          ? `${data.error} - ${data.debug}`
          : data.error ||
            "Could not leave the poker table.",
        "bad"
      );


      if (leaveTableBtn) {
        leaveTableBtn.disabled =
          false;

        leaveTableBtn.textContent =
          "LEAVE TABLE";
      }


      return;
    }


    /* ========================================================
       SUCCESS
       ======================================================== */

    const amountReturned =
      Number(
        data.amountReturned || 0
      );


    walletBalance =
      Number(
        data.walletBalance ??
        walletBalance ??
        0
      );


    clearPendingLeave();

    clearPokerSession();


    /* --------------------------------------------------------
       RESET YOUR OLD SEAT
       -------------------------------------------------------- */

    const oldSeat =
      document.querySelector(
        `.poker-seat[data-seat="${seatNumber}"]`
      );


    if (oldSeat) {

      oldSeat.classList.remove(
        "selected",
        "occupied",
        "my-seat"
      );


      const playerEl =
        oldSeat.querySelector(
          ".seat-player"
        );


      const stackEl =
        oldSeat.querySelector(
          ".seat-stack"
        );


      if (playerEl) {
        playerEl.textContent =
          "Open";
      }


      if (stackEl) {
        stackEl.textContent =
          "";
      }
    }


    /* --------------------------------------------------------
       RESET LOCAL UI
       -------------------------------------------------------- */

    selectedSeat = null;
    selectedBuyin = null;


    clearSeatHighlights();
    clearBuyinHighlights();


    setText(
      walletBalanceEl,
      money(walletBalance)
    );


    setText(
      pokerStackEl,
      "0"
    );


    setText(
      pokerStatusEl,
      "Not Seated"
    );


    setText(
      selectedSeatText,
      "None"
    );


    setText(
      selectedBuyinText,
      "None"
    );


    if (sitDownBtn) {
      sitDownBtn.textContent =
        "SIT DOWN";
    }


    if (leaveTableBtn) {
      leaveTableBtn.disabled =
        false;

      leaveTableBtn.hidden =
        true;

      leaveTableBtn.textContent =
        "LEAVE TABLE";
    }


    updateControls();


    setMessage(
      `${money(amountReturned)} chips returned to your wallet. New wallet balance: ${money(walletBalance)}.`,
      "good"
    );

    await loadTableState();


  } catch (error) {

    console.error(
      "Poker leave request failed:",
      error
    );


    /*
      Do NOT clear pending leave here.

      The server may have completed the transaction before
      the connection failed. Reusing the same key prevents
      a duplicate payout.
    */


    if (leaveTableBtn) {
      leaveTableBtn.disabled =
        false;

      leaveTableBtn.textContent =
        "LEAVE TABLE";
    }


    setMessage(
      error?.message ||
      "Leave-table request failed.",
      "bad"
    );
  }
}


/* ============================================================
   EVENTS
   ============================================================ */

function bindSeatEvents() {
  document
    .querySelectorAll(
      ".poker-seat"
    )
    .forEach((seat) => {

      seat.addEventListener(
        "click",
        () => {

          const seatNumber =
            Number(
              seat.dataset.seat
            );

          selectSeat(
            seatNumber
          );
        }
      );

    });
}


function bindBuyinEvents() {
  document
    .querySelectorAll(
      ".poker-buyin"
    )
    .forEach((button) => {

      button.addEventListener(
        "click",
        () => {

          const amount =
            Number(
              button.dataset.buyin
            );

          selectBuyin(
            amount
          );
        }
      );

    });
}


/* ============================================================
   INITIALIZE
   ============================================================ */

document.addEventListener(
  "DOMContentLoaded",
  async () => {

    bindSeatEvents();
    bindBuyinEvents();

    sitDownBtn?.addEventListener(
      "click",
      sitDown
    );

    leaveTableBtn?.addEventListener(
      "click",
      leaveTable
    );


    /* ----------------------------------------
       Restore any successful local session
       ---------------------------------------- */

    loadSavedPokerSession();

    renderSavedSession();


    /* ----------------------------------------
       Load live main casino wallet
       ---------------------------------------- */

    await loadWallet();

    /* ----------------------------------------
       Load Live poker table
       ---------------------------------------- */

    await loadTableState();

    startTableStatePolling();


    /* ----------------------------------------
       Default message
       ---------------------------------------- */

    if (!pokerSession) {

      setText(
        pokerStackEl,
        "0"
      );

      setText(
        pokerStatusEl,
        "Not Seated"
      );

      setText(
        selectedSeatText,
        "None"
      );

      setText(
        selectedBuyinText,
        "None"
      );

      setMessage(
        "Select an open seat and buy-in."
      );
    }


    updateControls();
  }
);