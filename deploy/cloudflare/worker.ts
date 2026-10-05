/** Attach as a Worker route, so fetch(request) continues to the existing Tunnel origin. */
const UNAVAILABLE = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

const page = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Back shortly · Conveyor</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#e8ebe8;color:#1c2328}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
main{width:min(100%,520px);padding:36px;background:#f8f9f7;border:1px solid #c9ceca;border-radius:12px}
.brand{font-weight:600;letter-spacing:.08em;font-size:13px;text-transform:uppercase;color:#5d6970}
.signal{display:inline-block;width:10px;height:10px;background:#b8720e;border-radius:50%;margin-right:8px}
h1{font-size:clamp(26px,5vw,34px);line-height:1.15;margin:24px 0 16px}p{line-height:1.6;color:#5d6970}
#status{font-size:14px;margin-top:24px}a{color:#2a5bd7}a:focus-visible{outline:2px solid currentColor;outline-offset:4px}
@media(prefers-color-scheme:dark){:root{background:#151a1d;color:#f2f5f3}main{background:#20272b;border-color:#465157}p,.brand{color:#aeb9bd}.signal{background:#f0b35b}a{color:#83a7ff}}
</style></head><body><main>
<div class="brand"><span class="signal" aria-hidden="true"></span>Conveyor</div>
<h1>We’ll be back shortly.</h1>
<p>The board is temporarily unavailable. This can happen during a deployment or restart.</p>
<p>This page will return you to the board as soon as it’s ready.</p>
<p id="status" role="status">Checking for recovery…</p>
<a href="/board">Try the board now</a>
</main><script nonce="__NONCE__">
async function check(){
  try{
    const response=await fetch('/health/live',{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(4000)});
    if(response.ok && (await response.json()).status==='live'){location.reload();return}
  }catch{}
  document.getElementById('status').textContent='Still waiting. Checking again in a few seconds…';
  setTimeout(check,5000);
}
setTimeout(check,3000);
</script></body></html>`;

function unavailable(request: Request): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "retry-after": "5",
    "x-content-type-options": "nosniff",
  });
  const isPage = ["GET", "HEAD"].includes(request.method) &&
    request.headers.get("accept")?.includes("text/html") &&
    !request.headers.has("upgrade");
  if (!isPage) {
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: "temporarily_unavailable" }), { status: 503, headers });
  }
  const nonce = crypto.randomUUID();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("content-security-policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  headers.set("referrer-policy", "no-referrer");
  return new Response(request.method === "HEAD" ? null : page.replace("__NONCE__", nonce), { status: 503, headers });
}

export async function handleRequest(request: Request, fetchOrigin: (request: Request) => Promise<Response> = fetch): Promise<Response> {
  let response: Response;
  try {
    response = await fetchOrigin(request);
  } catch {
    return unavailable(request);
  }
  // Preserve API, asset, mutation and streaming responses, including their original errors.
  if (!UNAVAILABLE.has(response.status) || !["GET", "HEAD"].includes(request.method) ||
    !request.headers.get("accept")?.includes("text/html") || request.headers.has("upgrade")) return response;
  await response.body?.cancel();
  return unavailable(request);
}

export default { fetch: (request: Request) => handleRequest(request) };
