/**
 * CLI: katulong fleet <subcommand>
 *
 * Operator tooling for fleet federation. Initial subcommand:
 *   test-mint <instance-url>   Verify a mint-session API key works against
 *                              a remote katulong instance (does a mint,
 *                              does a consume, reports the session cookie).
 *
 * The hub itself is not yet part of katulong; this command exists so an
 * operator (or Claude-over-SSH) can sanity-check the federation primitives
 * on each instance before wiring up a hub.
 */

function usage() {
  console.log(`
Usage: katulong fleet <subcommand> [options]

Subcommands:
  test-mint <instance-url>   Verify a mint-session API key by minting
                             and consuming a session on a remote instance.

Options:
  --key <api-key>     Bearer key with mint-session scope. May also be
                      provided via KATULONG_FLEET_KEY env var.
  --json              Output as JSON
`);
}

function parseFlags(args) {
  const opts = { key: null, json: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") opts.json = true;
    else if (a === "--key") opts.key = args[++i];
    else if (a.startsWith("--key=")) opts.key = a.slice("--key=".length);
    else if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else opts.positional.push(a);
  }
  return opts;
}

async function testMint(args) {
  const opts = parseFlags(args);
  const instanceUrl = opts.positional[0];
  if (!instanceUrl) {
    console.error("Usage: katulong fleet test-mint <instance-url> [--key <key>] [--json]");
    process.exit(1);
  }
  const apiKey = opts.key || process.env.KATULONG_FLEET_KEY;
  if (!apiKey) {
    console.error("Error: mint-session API key required (--key or KATULONG_FLEET_KEY)");
    process.exit(1);
  }

  // Normalize the URL (drop trailing slash, validate it parses).
  let base;
  try {
    base = new URL(instanceUrl);
  } catch {
    console.error(`Error: invalid instance URL: ${instanceUrl}`);
    process.exit(1);
  }
  const origin = base.origin;

  // Step 1: mint. Expect 201 with { consumeUrl, consumeToken, expiresAt }.
  let mintResp;
  try {
    mintResp = await fetch(`${origin}/api/sessions/mint`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
  } catch (err) {
    console.error(`Error: mint request failed: ${err.message}`);
    process.exit(1);
  }
  const mintBody = await mintResp.json().catch(() => null);
  if (!mintResp.ok) {
    const summary = { step: "mint", instance: origin, status: mintResp.status, body: mintBody };
    if (opts.json) console.log(JSON.stringify(summary, null, 2));
    else console.error(`Mint failed (${mintResp.status}): ${JSON.stringify(mintBody)}`);
    process.exit(1);
  }

  // Step 2: consume — follow manually so we can observe Set-Cookie and the
  // redirect target. fetch auto-follows by default; disable with redirect: "manual".
  const consumeUrl = mintBody.consumeUrl;
  let consumeResp;
  try {
    consumeResp = await fetch(consumeUrl, { redirect: "manual" });
  } catch (err) {
    console.error(`Error: consume request failed: ${err.message}`);
    process.exit(1);
  }

  const setCookie = consumeResp.headers.get("set-cookie");
  const location = consumeResp.headers.get("location");
  const cookieOk = typeof setCookie === "string" && setCookie.includes("katulong_session=");
  const redirectOk = consumeResp.status === 302;

  const result = {
    instance: origin,
    mint: { status: mintResp.status, expiresAt: mintBody.expiresAt },
    consume: {
      status: consumeResp.status,
      location,
      hasSessionCookie: cookieOk,
    },
    ok: redirectOk && cookieOk,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`OK  ${origin} — mint + consume succeeded (redirect to ${location})`);
  } else {
    console.log(`FAIL ${origin} — mint=${mintResp.status} consume=${consumeResp.status} cookie=${cookieOk}`);
  }
  process.exit(result.ok ? 0 : 1);
}

const subcommands = { "test-mint": testMint };

export default async function fleet(args) {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    usage();
    process.exit(sub ? 0 : 1);
  }
  if (!subcommands[sub]) {
    console.error(`Unknown subcommand: ${sub}`);
    usage();
    process.exit(1);
  }
  try {
    await subcommands[sub](args.slice(1));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
