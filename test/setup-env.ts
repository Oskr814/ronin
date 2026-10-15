// config.ts throws on load when a required env var is missing. Importing a
// feature through its barrel (src/<feature>/index.ts) loads every module of
// that feature, so a test can end up loading config.ts even when the module
// under test never reads it. Placeholder values, only where a test hasn't set
// its own.
for (const name of ['RONIN_GITHUB_TOKEN', 'RONIN_GITHUB_LOGIN', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'NOTIFY_TO', 'RUNNER_ID']) {
  process.env[name] ??= `test-${name.toLowerCase()}`;
}
