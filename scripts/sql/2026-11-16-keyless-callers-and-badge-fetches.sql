-- Keyless caller weekly counts (H-1) and badge fetch tallies (D-R1). Not applied in prod by this change.

CREATE TABLE IF NOT EXISTS keyless_week_salts (
  week_start date PRIMARY KEY,
  salt text NOT NULL
);

CREATE TABLE IF NOT EXISTS keyless_caller_days (
  week_start date NOT NULL,
  caller_hash text NOT NULL,
  day date NOT NULL,
  is_returning boolean NOT NULL DEFAULT false,
  PRIMARY KEY (week_start, caller_hash, day)
);

CREATE TABLE IF NOT EXISTS keyless_carry_bits (
  week_start date NOT NULL,
  bit int NOT NULL,
  PRIMARY KEY (week_start, bit)
);

CREATE TABLE IF NOT EXISTS keyless_caller_weekly (
  week_start date PRIMARY KEY,
  callers int NOT NULL,
  callers_2plus_days int NOT NULL,
  returning_wow int NOT NULL,
  closed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS badge_fetch_daily (
  day date NOT NULL,
  referer_host text NOT NULL,
  badge_kind text NOT NULL,
  fetches int NOT NULL,
  PRIMARY KEY (day, referer_host, badge_kind)
);