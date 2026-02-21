/**
 * katulong ca - DEPRECATED
 *
 * TLS certificate auto-generation has been removed. Katulong now runs
 * HTTP-only and relies on tunnel services (cloudflared, ngrok) for HTTPS.
 */

export default async function ca() {
  console.error("katulong ca: This command has been deprecated.");
  console.error("");
  console.error("TLS certificate auto-generation has been removed from Katulong.");
  console.error("Katulong now runs HTTP-only on localhost.");
  console.error("");
  console.error("For HTTPS access, use a tunnel service:");
  console.error("  cloudflared tunnel --url http://localhost:3001");
  console.error("  ngrok http 3001");
  process.exit(1);
}
