-- Short-lived login challenges, separate from identity sessions and tenant grants.
CREATE TABLE oauth_login_states (
  state_digest TEXT PRIMARY KEY NOT NULL,
  browser_digest TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer')
) WITHOUT ROWID;

CREATE INDEX oauth_login_states_expiry ON oauth_login_states(expires_at);
