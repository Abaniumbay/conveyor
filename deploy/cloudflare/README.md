# Conveyor deployment fallback

This Cloudflare Worker sits on `conveyor.example.com/*` ahead of the existing
Cloudflare Tunnel. Healthy requests go to the current origin unchanged. Browser
GET/HEAD requests receiving an unavailable-origin response get a standalone
recovery page instead of a gateway error. The page checks `/health/live` and
reloads the original URL when the service returns.

No service restart or deployment-script change is needed to activate the Worker.
It runs separately from Conveyor, so it remains available during a Conveyor
restart. The fallback also covers unplanned origin or tunnel outages; it does not
claim every outage is a deployment. It appears on navigation or refresh; an
already-open board is not automatically replaced when its event stream drops.

## Deploy

Authenticate with a Cloudflare account that can deploy Workers and manage Worker
routes for `example.com`, then deploy from the development checkout:

```sh
bunx wrangler login
bunx wrangler deploy --config deploy/cloudflare/wrangler.jsonc
```

For unattended deployment, supply `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` through the shell environment or a secret manager. The
token needs Workers Scripts Edit and Workers Routes Edit, with access to the
relevant account and zone. A Cloudflare Tunnel token cannot deploy this Worker.
Do not store credentials in the repository.

Use a **Worker route**, not a Worker Custom Domain. Keep the existing proxied DNS
and tunnel configuration. `fetch(request)` on a route continues to that origin.
Check existing overlapping routes before deploying; a more specific route can
bypass this Worker, and replacing an existing route can displace its Worker.

## Check behavior

```sh
bun test tests/cloudflare/worker.test.ts
bunx wrangler deploy --config deploy/cloudflare/wrangler.jsonc --dry-run --outdir /tmp/conveyor-worker-bundle
```

After deployment, verify normal navigation and login still work. During the next
scheduled Conveyor restart, opening `/board` should return this page with HTTP
503, `Retry-After: 5`, and `Cache-Control: no-store`; when Conveyor returns it
should reload automatically. The Worker does not retry mutations, replace API,
asset or SSE error responses with HTML, or cache authenticated responses.

To remove the fallback, detach only the `conveyor.example.com/*` route from the
`conveyor-deployment-page` Worker. Leave the tunnel and DNS record intact.
