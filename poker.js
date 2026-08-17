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

    const data =
      await response.json();

    if (!data.ok) {
      /*
        A definite server rejection means this request did NOT
        leave us in an unknown network state.

        Clear the pending key so a corrected request gets a
        fresh idempotency key.
      */

      if (
        response.status !== 500
      ) {
        clearPendingSit();
      }

      setMessage(
        data.error ||
          "Could not sit at the poker table.",
        "bad"
      );

      /*
        Server may tell us we're already sitting there.
        We do not fake a local session from that yet because the
        next endpoint will be /api/poker-table-state.
      */

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
      "Connection interrupted. Tap Sit Down again to safely retry the same request.",
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

function leaveTable() {
  if (!pokerSession) return;

  setMessage(
    "Leave-table cashout is not active yet. Your poker stack remains reserved at the table.",
    "warn"
  );
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