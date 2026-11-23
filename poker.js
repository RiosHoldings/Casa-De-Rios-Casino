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

let submittingPokerAction = false;
let latestPokerState = null;
let processingPokerTimeout = false;
let processingPokerSettlement = false;

let startingNextPokerHand = false;
let nextPokerHandTimer = null;
let nextPokerHandForId = null;
let lastSettledPokerResult = null;

let lastDisplayedCompletedHandId = null;

let submittingPokerSessionAction = false;

let submittingPokerRebuy = false;

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

const pokerActionPanel = 
  document.getElementById("pokerActionPanel");

const pokerFoldBtn = 
  document.getElementById("pokerFoldBtn");

const pokerCheckBtn =
  document.getElementById("pokerCheckBtn");
  
const pokerCallBtn =
  document.getElementById("pokerCallBtn");
  
const pokerRaiseBtn = 
  document.getElementById("pokerRaiseBtn");

const pokerAllInBtn =
  document.getElementById("pokerAllInBtn");

const pokerRaiseSlider =
  document.getElementById("pokerRaiseSlider");


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
   POKER ACTION CONTROLS
   ============================================================ */

function getYourHandPlayer(data) {
  if (
    !data?.yourSession ||
    !Array.isArray(
      data.handPlayers
    )
  ) {
    return null;
  }

  const yourSeat =
    Number(
      data.yourSession
        .seatNumber
    );

  return (
    data.handPlayers.find(
      (player) =>
        Number(
          player.seatNumber
        ) ===
        yourSeat
    ) || null
  );
}


function syncRaiseAmountText() {
  const slider =
    document.getElementById(
      "pokerRaiseSlider"
    );

  const amountText =
    document.getElementById(
      "pokerRaiseAmount"
    );

  if (
    !slider ||
    !amountText
  ) {
    return;
  }

  amountText.textContent =
    money(
      Number(slider.value || 0)
    );
}


function hidePokerActions() {
  if (pokerActionPanel) {
    pokerActionPanel.hidden =
      true;

    pokerActionPanel
      .classList
      .remove(
        "your-turn"
      );
  }
}


function renderPokerActionControls(
  data
) {
  latestPokerState =
    data;

  const hand =
    data?.hand;

  const session =
    data?.yourSession;

  const yourPlayer =
    getYourHandPlayer(
      data
    );


  if (
    !hand ||
    !session ||
    !yourPlayer ||
    hand.status !== "active"
  ) {
    hidePokerActions();
    return;
  }


  const yourSeat =
    Number(
      session.seatNumber
    );

  const currentTurnSeat =
    Number(
      hand.currentTurnSeat
    );


  const isYourTurn =
    yourSeat ===
      currentTurnSeat &&
    !yourPlayer.folded &&
    !yourPlayer.allIn;


  if (!isYourTurn) {
    hidePokerActions();
    return;
  }


  if (pokerActionPanel) {
    pokerActionPanel.hidden =
      false;

    pokerActionPanel
      .classList
      .add(
        "your-turn"
      );
  }


  const currentBet =
    Number(
      hand.currentBet ||
      0
    );

  const minRaise =
    Number(
      hand.minRaise ||
      data.table?.bigBlind ||
      200
    );

  const streetContributed =
    Number(
      yourPlayer
        .streetContributed ||
      0
    );

  const matchingSeat =
    Array.isArray(data.seats)
      ? data.seats.find(
        (seat) =>
          Number(seat.seatNumber) ===
        yourSeat
      )
    : null;

  const stack =
    Number(
      yourPlayer.currentStack ??
      yourPlayer.current_stack ??
      session.currentStack ??
      session.current_stack ??
      matchingSeat?.currentStack ??
      matchingSeat?.current_stack ??
      matchingSeat?.stack ??
      0
    );


  const callRequired =
    Math.max(
      0,
      currentBet -
        streetContributed
    );


  /* ----------------------------------------------------------
     FOLD
     ---------------------------------------------------------- */

  if (pokerFoldBtn) {
    pokerFoldBtn.disabled =
      submittingPokerAction;
  }


  /* ----------------------------------------------------------
     CHECK
     ---------------------------------------------------------- */

  if (pokerCheckBtn) {
    pokerCheckBtn.hidden =
      callRequired !== 0;

    pokerCheckBtn.disabled =
      submittingPokerAction ||
      callRequired !== 0;
  }


  /* ----------------------------------------------------------
     CALL
     ---------------------------------------------------------- */

  if (pokerCallBtn) {
    pokerCallBtn.hidden =
      callRequired <= 0;

    const actualCall =
      Math.min(
        callRequired,
        stack
      );

    pokerCallBtn.textContent =
      actualCall >= stack
        ? `CALL ${money(actualCall)} — ALL IN`
        : `CALL ${money(actualCall)}`;

    pokerCallBtn.disabled =
      submittingPokerAction ||
      callRequired <= 0 ||
      stack <= 0;
  }


  /* ----------------------------------------------------------
     BET / RAISE SLIDER
     ---------------------------------------------------------- */

  const maximumTarget =
    streetContributed +
    stack;


  let minimumTarget;

  let raiseAction;


  if (currentBet === 0) {
    minimumTarget =
      Number(
        data.table?.bigBlind ||
        200
      );

    raiseAction =
      "bet";

  } else {
    minimumTarget =
      currentBet +
      minRaise;

    raiseAction =
      "raise";
  }


  if (pokerRaiseBtn) {
    pokerRaiseBtn.dataset.action =
      raiseAction;

    pokerRaiseBtn.textContent =
      raiseAction === "bet"
        ? "BET"
        : "RAISE";
  }


  const canBetOrRaise =
    stack > 0 &&
    maximumTarget >
      currentBet &&
    maximumTarget >=
      minimumTarget;


  if (pokerRaiseSlider) {
    const sliderMin =
      canBetOrRaise
        ? minimumTarget
        : maximumTarget;

    pokerRaiseSlider.min =
      String(
        Math.max(
          0,
          sliderMin
        )
      );

    pokerRaiseSlider.max =
      String(
        Math.max(
          0,
          maximumTarget
        )
      );

    pokerRaiseSlider.step =
      "100";


    let currentSliderValue =
      Number(
        pokerRaiseSlider.value ||
        sliderMin
      );


    if (
      currentSliderValue <
        sliderMin ||
      currentSliderValue >
        maximumTarget
    ) {
      currentSliderValue =
        sliderMin;
    }


    pokerRaiseSlider.value =
      String(
        Math.max(
          0,
          currentSliderValue
        )
      );


    pokerRaiseSlider.disabled =
      submittingPokerAction ||
      !canBetOrRaise;
  }


  if (pokerRaiseBtn) {
    pokerRaiseBtn.disabled =
      submittingPokerAction ||
      !canBetOrRaise;
  }


  syncRaiseAmountText();


  /* ----------------------------------------------------------
     ALL IN
     ---------------------------------------------------------- */

  if (pokerAllInBtn) {
    pokerAllInBtn.textContent =
      stack > 0
        ? `ALL IN ${money(stack)}`
        : "ALL IN";

    pokerAllInBtn.disabled =
      submittingPokerAction ||
      stack <= 0;
  }
}


/* ============================================================
   SEND POKER ACTION
   ============================================================ */

async function submitPokerAction(
  action,
  amount = null
) {
  if (
    submittingPokerAction
  ) {
    return;
  }


  const state =
    latestPokerState;


  if (
    !state?.hand?.id
  ) {
    setMessage(
      "No active poker hand.",
      "bad"
    );

    return;
  }


  const {
    playerId,
    playerSecret
  } =
    getPlayerCredentials();


  if (
    !playerId ||
    !playerSecret
  ) {
    setMessage(
      "Player login is missing.",
      "bad"
    );

    return;
  }


  submittingPokerAction =
    true;


  renderPokerActionControls(
    state
  );


  setMessage(
    "Sending poker action...",
    "warn"
  );


  try {
    const payload = {
      playerId,
      playerSecret,

      tableId:
        TABLE_ID,

      handId:
        state.hand.id,

      action
    };


    if (
      amount !== null &&
      amount !== undefined
    ) {
      payload.amount =
        Number(amount);
    }


    const response =
      await fetch(
        "/api/poker-action",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify(
              payload
            )
        }
      );


    const data =
      await response.json();


    if (!data.ok) {
      if (
        data.timeoutProcessed
      ) {
        setMessage(
          data.error ||
            "Expired turn processed.",
          "warn"
        );

      } else {
        setMessage(
          data.error ||
            "Poker action denied.",
          "bad"
        );
      }


      await loadTableState();

      return;
    }


    setMessage(
      data.message ||
        "Poker action accepted.",
      "good"
    );


    await loadTableState();


  } catch (error) {
    console.error(
      "Poker action failed:",
      error
    );

    setMessage(
      "Poker action request failed.",
      "bad"
    );

  } finally {
    submittingPokerAction =
      false;

    if (
      latestPokerState
    ) {
      renderPokerActionControls(
        latestPokerState
      );
    }
  }
}

/* ============================================================
   LIVE POKER HAND DISPLAY
   ============================================================ */

function renderHandState(data) {
  renderPokerActionControls(data);

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
    latestPokerState =
      data;

    renderHandState(
      data
    );

    renderPokerActionControls(
      data
    );

    const hadLocalSession =
      Boolean(
        pokerSession
      );

    const seats =
    Array.isArray(
      data.seats
    )
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
   AUTOMATIC TURN TIMEOUT PROCESSING
   ============================================================ */

async function processPokerTimeoutIfNeeded(data) {
  if (
    processingPokerTimeout ||
    !data?.hand ||
    data.hand.status !== "active" ||
    !data.hand.actionDeadline
  ) {
    return;
  }


  const deadline =
    Date.parse(
      data.hand.actionDeadline
    );


  const serverNow =
    Date.parse(
      data.serverTime ||
      new Date().toISOString()
    );


  if (
    !Number.isFinite(deadline) ||
    !Number.isFinite(serverNow) ||
    serverNow < deadline
  ) {
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


  processingPokerTimeout =
    true;


  try {

    const response =
      await fetch(
        "/api/poker-action",
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
                TABLE_ID,

              handId:
                data.hand.id,

              /*
                The requested action itself does not matter
                when the deadline has expired.

                poker-action.js processes the expired turn
                BEFORE checking whose turn the caller owns.
              */
              action:
                "check"
            })
        }
      );


    const result =
      await response.json();


    if (
      result.timeoutProcessed
    ) {
      console.log(
        "Poker timeout processed:",
        result.timeoutAction,
        "Seat",
        result.timedOutSeat
      );

      /*
        Immediately reload instead of waiting
        for the next 2-second poll.
      */

      setTimeout(
        () => {
          loadTableState();
        },
        150
      );
    }


  } catch (error) {

    console.error(
      "Automatic poker timeout failed:",
      error
    );


  } finally {

    processingPokerTimeout =
      false;
  }
}

/* ============================================================
   AUTOMATIC HAND SETTLEMENT
   ============================================================ */

async function processPokerSettlementIfNeeded(data) {
  if (
    processingPokerSettlement ||
    !data?.hand ||
    data.hand.status !== "settling"
  ) {
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


  processingPokerSettlement =
    true;


  try {

    const response =
      await fetch(
        "/api/poker-settle-hand",
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
                TABLE_ID,

              handId:
                data.hand.id
            })
        }
      );


    const result =
      await response.json();


    if (
      result.ok
    ) {

      console.log(
        "Poker hand settled:",
        result
      );

      showPokerHandResult(
        result
      );

      lastDisplayedCompleteHandId =
        result.hand?.id ||
        data.hand.id;

    /* ------------------------------------------------------
       SCHEDULE NEXT HAND
       ------------------------------------------------------ */

      const delaySeconds =
        Number(
          data.table
            ?.handDelaySeconds ||
            7
        );

      scheduleNextPokerHand(
        result.hand?.id ||
          data.hand.id,

        delaySeconds
      );

      /* ------------------------------------------------
         REFRESH PAID STACKS
         ------------------------------------------------ */
      
         setTimeout(
          () => {
            loadTableState();
          },
          150
         );


      return;
    }


    console.error(
      "Poker settlement denied:",
      result
    );


    /*
      A duplicate settlement attempt can happen
      when multiple players have the table open.

      Just refresh state.
    */

    if (
      response.status === 409
    ) {
      setTimeout(
        () => {
          loadTableState();
        },
        300
      );

      return;
    }


    setMessage(
      result.error ||
        "Poker settlement failed.",
      "bad"
    );


  } catch (error) {

    console.error(
      "Automatic poker settlement failed:",
      error
    );


    setMessage(
      "Poker settlement request failed.",
      "bad"
    );


  } finally {

    processingPokerSettlement =
      false;
  }
}

/* ============================================================
   HAND RESULT + NEXT HAND
   ============================================================ */

function showPokerHandResult(result) {
  const hand =
    result?.hand;

  if (!hand) {
    return;
  }


  lastSettledPokerResult =
    result;


  const winners =
    Array.isArray(
      hand.winners
    )
      ? hand.winners
      : [];


  const paidWinners =
    winners.filter(
      (winner) =>
        Number(
          winner.payout || 0
        ) > 0
    );


  let winnerText =
    "Hand complete.";


  if (
    paidWinners.length
  ) {
    winnerText =
      paidWinners
        .map(
          (winner) =>
            `Seat ${winner.seatNumber} wins ${money(winner.payout)}`
        )
        .join(" • ");
  }


  const rake =
    Number(
      hand.rake || 0
    );


  const pot =
    Number(
      hand.potBeforeRake || 0
    );


  let message =
    winnerText;


  if (
    pot > 0
  ) {
    message +=
      ` • Pot ${money(pot)}`;
  }


  if (
    rake > 0
  ) {
    message +=
      ` • Rake ${money(rake)}`;
  }


  setMessage(
    message,
    "good"
  );


  /*
    Reuse the turn display for the
    seven-second result screen.
  */

  if (
    pokerTurnText
  ) {
    pokerTurnText.textContent =
      winnerText;
  }


  if (
    pokerTurnBox
  ) {
    pokerTurnBox.hidden =
      false;
  }


  hidePokerActions();
}


/* ============================================================
   START NEXT HAND
   ============================================================ */

async function startNextPokerHand() {
  if (
    startingNextPokerHand
  ) {
    return;
  }


  const {
    playerId,
    playerSecret
  } =
    getPlayerCredentials();


  if (
    !playerId ||
    !playerSecret
  ) {
    return;
  }


  startingNextPokerHand =
    true;


  try {

    const response =
      await fetch(
        "/api/poker-start-hand",
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


    const result =
      await response.json();


    if (
      result.ok
    ) {

      console.log(
        "Next poker hand started:",
        result
      );


      setMessage(
        result.hand?.handNumber
          ? `Hand #${result.hand.handNumber} started.`
          : "Next hand started.",
        "good"
      );


      nextPokerHandForId =
        null;


      await loadTableState();

      return;
    }


    /*
      Another player's browser may have
      already started the next hand.

      A 409 here is therefore not
      automatically an error.
    */

    if (
      response.status === 409
    ) {

      console.log(
        "Next poker hand start:",
        result.error ||
        "Another client may have started the hand."
      );


      nextPokerHandForId =
        null;


      await loadTableState();

      return;
    }


    console.error(
      "Could not start next poker hand:",
      result
    );


    setMessage(
      result.error ||
        "Could not start the next poker hand.",
      "bad"
    );


  } catch (error) {

    console.error(
      "Next poker hand request failed:",
      error
    );


    setMessage(
      "Next poker hand request failed.",
      "bad"
    );


  } finally {

    startingNextPokerHand =
      false;
  }
}


/* ============================================================
   SEVEN-SECOND RESULT DELAY
   ============================================================ */

function scheduleNextPokerHand(
  settledHandId,
  delaySeconds = 7
) {
  if (
    !settledHandId
  ) {
    return;
  }


  /*
    Don't schedule the same completed
    hand more than once.
  */

  if (
    nextPokerHandForId ===
    settledHandId
  ) {
    return;
  }


  nextPokerHandForId =
    settledHandId;


  if (
    nextPokerHandTimer
  ) {
    clearTimeout(
      nextPokerHandTimer
    );
  }


  const delayMs =
    Math.max(
      0,
      Number(
        delaySeconds || 7
      ) * 1000
    );


  nextPokerHandTimer =
    setTimeout(
      () => {

        nextPokerHandTimer =
          null;

        startNextPokerHand();

      },
      delayMs
    );
}

/* ============================================================
   ENSURE TABLE DOES NOT GET STUCK BETWEEN HANDS
   ============================================================ */

function ensureNextPokerHandScheduled(data) {
  if (
    data?.hand ||
    startingNextPokerHand
  ) {
    return;
  }


  const seats =
    Array.isArray(data?.seats)
      ? data.seats
      : [];


  const activePlayers =
    seats.filter(
      (seat) => {

        const status =
          String(
            seat.status ||
            seat.sessionStatus ||
            ""
          ).toLowerCase();


        const stack =
          Number(
            seat.currentStack ??
            seat.current_stack ??
            seat.stack ??
            0
          );


        return (
          status === "seated" &&
          stack > 0
        );
      }
    );


  /*
    Do not attempt to start a hand
    unless at least two connected,
    seated players have chips.
  */

  if (
    activePlayers.length < 2
  ) {
    return;
  }


  const delaySeconds =
    Number(
      data.table
        ?.handDelaySeconds ||
      7
    );


  const idleKey =
    `idle-${
      data.table?.handCounter ??
      "table"
    }`;


  scheduleNextPokerHand(
    idleKey,
    delaySeconds
  );
}

/* ============================================================
   SYNC COMPLETED HAND RESULT FROM TABLE STATE
   ============================================================ */

function syncCompletedPokerHandResult(data) {
  const completed =
    data?.lastCompletedHand;


  if (!completed) {
    return;
  }


  /*
    Do not interrupt a new active hand
    with the previous hand's result.
  */

  if (
    data?.hand?.status ===
    "active"
  ) {
    return;
  }


  if (
    lastDisplayedCompletedHandId ===
    completed.id
  ) {
    return;
  }


  lastDisplayedCompletedHandId =
    completed.id;


  showPokerHandResult({
    hand: completed
  });
}

/* ============================================================
   POKER SESSION CONTROLS
   ============================================================ */

function renderPokerSessionControls(data) {
  const controls =
    document.getElementById(
      "pokerSessionControls"
    );

  const sitOutBtn =
    document.getElementById(
      "pokerSitOutBtn"
    );

  const returnBtn =
    document.getElementById(
      "pokerReturnBtn"
    );

  const statusEl =
    document.getElementById(
      "pokerSitOutStatus"
    );


  if (
    !controls ||
    !sitOutBtn ||
    !returnBtn ||
    !statusEl
  ) {
    return;
  }


  const session =
    data?.yourSession ||
    null;


  if (!session) {
    controls.hidden =
      true;

    return;
  }


  controls.hidden =
    false;


  const status =
    String(
      session.status ||
      ""
    ).toLowerCase();


  /* ----------------------------------------------------------
     SITTING OUT
     ---------------------------------------------------------- */

  if (
    status ===
    "sitting_out"
  ) {
    sitOutBtn.hidden =
      true;

    returnBtn.hidden =
      false;

    returnBtn.disabled =
      submittingPokerSessionAction;


    statusEl.hidden =
      false;

    statusEl.textContent =
      "Sitting Out";


    /*
      A sitting-out player should never
      have action controls showing.
    */

    hidePokerActions();

    return;
  }


  /* ----------------------------------------------------------
     SEATED
     ---------------------------------------------------------- */

  sitOutBtn.hidden =
    false;

  returnBtn.hidden =
    true;

  statusEl.hidden =
    true;


  const hand =
    data?.hand;


  const handPlayers =
    Array.isArray(
      data?.handPlayers
    )
      ? data.handPlayers
      : [];


  const yourSeat =
    Number(
      session.seatNumber
    );


  const participatingInHand =
    Boolean(
      hand &&
      (
        hand.status ===
          "active" ||
        hand.status ===
          "settling"
      ) &&
      handPlayers.some(
        (player) =>
          Number(
            player.seatNumber
          ) ===
          yourSeat
      )
    );


  /*
    You cannot sit out halfway through
    a hand you are currently playing.
  */

  sitOutBtn.disabled =
    submittingPokerSessionAction ||
    participatingInHand;


  if (
    participatingInHand
  ) {
    sitOutBtn.title =
      "Finish the current hand before sitting out.";

  } else {
    sitOutBtn.title =
      "";
  }
}


/* ============================================================
   SEND SIT OUT / RETURN REQUEST
   ============================================================ */

async function submitPokerSessionAction(
  action
) {
  if (
    submittingPokerSessionAction
  ) {
    return;
  }


  const {
    playerId,
    playerSecret
  } =
    getPlayerCredentials();


  if (
    !playerId ||
    !playerSecret
  ) {
    setMessage(
      "Player login is missing.",
      "bad"
    );

    return;
  }


  submittingPokerSessionAction =
    true;


  if (
    latestPokerState
  ) {
    renderPokerSessionControls(
      latestPokerState
    );
  }


  try {

    const response =
      await fetch(
        "/api/poker-sit-out",
        {
          method:
            "POST",

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
                TABLE_ID,

              action
            })
        }
      );


    const rawResponse =
      await response.text();


    let result;


    try {

      result =
        rawResponse
          ? JSON.parse(
              rawResponse
            )
          : {
              ok: false,

              error:
                `Poker session endpoint returned HTTP ${response.status}.`
            };

    } catch {

      result = {
        ok: false,

        error:
          `Poker session endpoint returned invalid JSON (${response.status}).`
      };
    }


    if (
      !result.ok
    ) {
      setMessage(
        result.error ||
          "Poker session action failed.",
        "bad"
      );

      return;
    }


    setMessage(
      result.message ||
        (
          action ===
          "sit_out"
            ? "You are now sitting out."
            : "You have returned to the table."
        ),
      "good"
    );


    await loadTableState();


  } catch (error) {

    console.error(
      "Poker session action failed:",
      error
    );


    setMessage(
      "Poker session request failed.",
      "bad"
    );


  } finally {

    submittingPokerSessionAction =
      false;


    if (
      latestPokerState
    ) {
      renderPokerSessionControls(
        latestPokerState
      );
    }
  }
}

/* ============================================================
   POKER REBUY PANEL
   ============================================================ */

function renderPokerRebuyPanel(data) {
  const panel =
    document.getElementById(
      "pokerRebuyPanel"
    );

  const statusEl =
    document.getElementById(
      "pokerRebuyStatus"
    );

  if (!panel) return;


  const session =
    data?.yourSession ||
    null;


  if (!session) {
    panel.hidden = true;
    return;
  }


  const yourSeat =
    Number(
      session.seatNumber ??
      session.seat_number ??
      0
    );


  const matchingSeat =
    Array.isArray(data?.seats)
      ? data.seats.find(
          (seat) =>
            Number(
              seat.seatNumber ??
              seat.seat_number
            ) === yourSeat
        )
      : null;


  const stack =
    Number(
      session.currentStack ??
      session.current_stack ??
      matchingSeat?.currentStack ??
      matchingSeat?.current_stack ??
      matchingSeat?.stack ??
      0
    );


  /*
    Only show rebuy when the player's
    poker stack is actually zero.
  */

  if (stack > 0) {
    panel.hidden = true;
    return;
  }


  const hand =
    data?.hand ||
    null;


  const handPlayers =
    Array.isArray(
      data?.handPlayers
    )
      ? data.handPlayers
      : [];


  const stillInUnfinishedHand =
    Boolean(
      hand &&
      (
        hand.status === "active" ||
        hand.status === "settling"
      ) &&
      handPlayers.some(
        (player) =>
          Number(
            player.seatNumber ??
            player.seat_number
          ) === yourSeat
      )
    );


  /*
    If the player busted during the current hand,
    wait until settlement finishes before offering rebuy.
  */

  if (stillInUnfinishedHand) {
    panel.hidden = true;
    return;
  }


  panel.hidden = false;


  const buttons =
    panel.querySelectorAll(
      ".poker-rebuy-btn"
    );


  buttons.forEach(
    (button) => {
      const amount =
        Number(
          button.dataset.rebuy ||
          0
        );

      button.disabled =
        submittingPokerRebuy ||
        (
          walletBalance !== null &&
          Number(walletBalance) < amount
        );
    }
  );


  if (statusEl) {
    statusEl.textContent =
      submittingPokerRebuy
        ? "Processing rebuy..."
        : "Your seat is being held.";
  }


  /*
    A busted player should not have normal
    betting controls visible.
  */

  hidePokerActions();
}

/* ============================================================
   SUBMIT POKER REBUY
   ============================================================ */

async function submitPokerRebuy(
  buyIn
) {
  if (submittingPokerRebuy) {
    return;
  }


  buyIn =
    Number(
      buyIn || 0
    );


  if (
    !APPROVED_BUYINS.includes(
      buyIn
    )
  ) {
    setMessage(
      "Invalid poker rebuy amount.",
      "bad"
    );

    return;
  }


  const {
    playerId,
    playerSecret
  } =
    getPlayerCredentials();


  if (
    !playerId ||
    !playerSecret
  ) {
    setMessage(
      "Player login is missing.",
      "bad"
    );

    return;
  }


  const session =
    latestPokerState?.yourSession;


  const sessionId =
    session?.id ||
    pokerSession?.id;


  if (!sessionId) {
    setMessage(
      "Poker session could not be found.",
      "bad"
    );

    return;
  }


  const idempotencyKey =
    "poker-rebuy-" +
    (
      crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now()
    );


  submittingPokerRebuy =
    true;


  if (latestPokerState) {
    renderPokerRebuyPanel(
      latestPokerState
    );
  }


  try {

    const response =
      await fetch(
        "/api/poker-rebuy",
        {
          method:
            "POST",

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
                TABLE_ID,

              sessionId,

              buyIn,

              idempotencyKey
            })
        }
      );


    const raw =
      await response.text();


    let result;


    try {

      result =
        raw
          ? JSON.parse(raw)
          : {
              ok: false,
              error:
                `Poker rebuy returned HTTP ${response.status}.`
            };

    } catch {

      result = {
        ok: false,
        error:
          `Poker rebuy returned invalid JSON (${response.status}).`
      };
    }


    if (!result.ok) {
      setMessage(
        result.error ||
          "Poker rebuy failed.",
        "bad"
      );

      return;
    }


    walletBalance =
      Number(
        result.walletBalance ??
        walletBalance ??
        0
      );


    setMessage(
      result.message ||
        `Rebuy complete — ${money(
          buyIn
        )} chips.`,
      "good"
    );


    await loadTableState();


  } catch (error) {

    console.error(
      "Poker rebuy failed:",
      error
    );


    setMessage(
      "Poker rebuy request failed.",
      "bad"
    );


  } finally {

    submittingPokerRebuy =
      false;


    if (latestPokerState) {
      renderPokerRebuyPanel(
        latestPokerState
      );
    }
  }
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
        tableStateFailures >=
          TABLE_STATE_MAX_FAILURES
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


    /* ========================================================
       SAVE LATEST LIVE STATE
       ======================================================== */

    latestPokerState =
      data;


    /* ========================================================
       RENDER TABLE + ACTION CONTROLS
       ======================================================== */

    renderTableState(
      data
    );

    renderPokerActionControls(
      data
    );

    renderPokerSessionControls(
      data
    );

    renderPokerRebuyPanel(
      data
    );

    syncCompletedPokerHandResult(
      data
    );

    /* =========================================================
       SERVER AUTOMATION
       ========================================================= */

    if (
      data.hand?.status ===
      "settling"
    ) {
      processPokerSettlementIfNeeded(
        data
      );
    } else if (
      data.hand?.status ===
      "active"
    ) {

    processPokerTimeoutIfNeeded(
      data
    );
  } else {
    ensureNextPokerHandScheduled(
      data
    );
  }

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

    loadingTableState =
      false;
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
   POKER ACTION EVENTS
   ============================================================ */

pokerRaiseSlider?.addEventListener(
  "input",
  syncRaiseAmountText
);


pokerFoldBtn?.addEventListener(
  "click",
  () => {
    submitPokerAction(
      "fold"
    );
  }
);


pokerCheckBtn?.addEventListener(
  "click",
  () => {
    submitPokerAction(
      "check"
    );
  }
);


pokerCallBtn?.addEventListener(
  "click",
  () => {
    submitPokerAction(
      "call"
    );
  }
);


pokerRaiseBtn?.addEventListener(
  "click",
  () => {
    const action =
      pokerRaiseBtn
        .dataset
        .action ||
      "raise";

    const amount =
      Number(
        pokerRaiseSlider
          ?.value ||
        0
      );

    submitPokerAction(
      action,
      amount
    );
  }
);


pokerAllInBtn?.addEventListener(
  "click",
  () => {
    submitPokerAction(
      "all_in"
    );
  }
);


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

    document
      .getElementById(
        "pokerSitOutBtn"
      )
      ?.addEventListener(
        "click",
      () => {
        submitPokerSessionAction(
          "sit_out"
        );    
      }
    );

    document
      .getElementById(
        "pokerReturnBtn"
      )
      ?.addEventListener(
        "click",
        () => {
          submitPokerSessionAction(
            "return"
          );
        }
      );

    document
  .querySelectorAll(
    ".poker-rebuy-btn"
  )
  .forEach(
    (button) => {
      button.addEventListener(
        "click",
        () => {
          submitPokerRebuy(
            Number(
              button.dataset.rebuy
            )
          );
        }
      );
    }
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