CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  character_name TEXT,
  discord_name TEXT,
  status TEXT NOT NULL DEFAULT 'waiting_buyin',
  vip_tier TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallets (
  player_id TEXT PRIMARY KEY,
  chips INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER,
  game TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payout_tickets (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fulfilled_at TEXT,
  fulfilled_by TEXT
);

CREATE TABLE IF NOT EXISTS roulette_rounds (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  bet_type TEXT NOT NULL,
  bet_value TEXT,
  bet_amount INTEGER NOT NULL,
  result_number INTEGER,
  result_color TEXT,
  payout INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'settled',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admins (
  player_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
