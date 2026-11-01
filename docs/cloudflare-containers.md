# Cloudflare Containers

This deployment runs the existing Python application, Playwright browser, noVNC login workspace, and cron runner in one Cloudflare Container. A Worker forwards HTTP and WebSocket traffic to it. A Durable Object stores filesystem snapshot handles and restores the latest snapshot after a container restart.

This is not a plain Workers deployment. It requires Cloudflare Containers, Wrangler 4.136 or later, Node.js 22 or later, and a Docker-compatible engine for local container development and image builds.

## Deploy

From the repository root:

```bash
npm ci
npx wrangler secret put SPARKFLOW_CF_CHECKPOINT_TOKEN
npm run cf:deploy
```

Enter a long random value for the secret when prompted. The container uses it only when asking the Worker to save a filesystem snapshot during graceful shutdown.

After deployment, open the `workers.dev` address printed by Wrangler. The existing SparkFlow admin login remains enabled. HTTPS-only session cookies are enabled by this deployment.

## GitHub Actions deployment

The `Cloudflare Containers` workflow uses a GitHub-hosted Linux runner to build the image. Pull requests run a build-only dry run; publishing happens only when manually dispatched from `main`. The scheduled runner and browser continue running in Cloudflare, so GitHub Actions does not hold account state or execute scheduled sends.

Add these repository Actions secrets before dispatching the workflow:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`, with `Account Settings:Read`, `Workers Scripts:Edit`, and `Containers:Edit` permissions
- `SPARKFLOW_CF_CHECKPOINT_TOKEN`, a long random value used only for authenticated snapshot callbacks

The workflow deploys the Worker and container first, then installs the checkpoint secret on the Worker. A short interval may occur before the secret is installed, so do not open the deployed site until the workflow has completed. Dispatch only from `main`.

The workflow is a deployment path, not an image migration system. After the first deployment, the existing snapshot is tied to its container image. A later code deployment that changes the image can stop at the snapshot compatibility check; migrate the saved state or roll back to the matching Worker version before changing the image.

For local development, copy `.dev.vars.example` to `.dev.vars`, replace its placeholder with a long random value, and run:

```bash
npm run cf:dev
```

Local Containers development requires Docker Desktop or another Docker-compatible engine.

## Runtime behavior

- The Worker sends a heartbeat every five minutes so the existing in-container cron runner remains available for the configured sending window.
- The container starts the noVNC login workspace, the FastAPI panel, and the existing cron runner. Task runs execute inside this container.
- The container uses 1 vCPU, 6 GiB memory, and a 16 GB disk. Change the instance size in `cloudflare/worker.ts` only if the Cloudflare account's limits allow it.
- The browser profile, account data, application settings, and logs remain on the container filesystem. On graceful shutdown, the entrypoint stops the web and scheduler processes, waits up to 13 minutes for an active task, stops the login browser, then asks the Durable Object to snapshot the filesystem.
- Cloudflare Container snapshots are immutable and expire after 30 days. A forced termination, process crash, unavailable callback, or disk growth beyond the platform limit can leave data newer than the last snapshot unsaved. Snapshots are not portable across image versions. If a deployment changes the container image while a snapshot exists, the Worker refuses to start the new image and keeps the old snapshot; roll back to the compatible Worker version or migrate the data before updating. Automatic filesystem migration is not implemented.
- The five-minute heartbeat keeps the application container active for its scheduler. Review [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) before leaving it deployed.
- The Docker Compose Mihomo service is not started in this single-container deployment. QR login uses direct networking. Automated tasks still use the application's configured direct route and can attempt its configured proxy fallback, which must point to a reachable proxy if needed.
- Cloudflare runs in a cloud data center. The upstream project notes that scheduled Douyin activity from cloud data-center IPs may trigger platform checks; successful deployment does not guarantee account compatibility.

## Local checks

```bash
npm run cf:types
bash -n DouYinSparkFlow/scripts/cloudflare-entrypoint.sh
```

The Cloudflare deployment itself is not performed by these local checks.
