import { DurableObject } from "cloudflare:workers";

interface Env {
	RUNTIME: DurableObjectNamespace<SparkFlowRuntime>;
	SPARKFLOW_CF_CHECKPOINT_TOKEN: string;
}

interface SavedSnapshot {
	id: string;
	image: string;
	createdAt: number;
}

const APP_PORT = 8787;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const CONTAINER_INSTANCE = {
	vcpu: 1,
	memoryMib: 6144,
	diskMb: 16000,
};

export class SparkFlowRuntime extends DurableObject<Env> {
	private starting: Promise<void> | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const container = ctx.container;
		if (container?.running) {
			void ctx.blockConcurrencyWhile(() =>
				container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
			);
		}
	}

	async fetch(request: Request): Promise<Response> {
		const origin = request.headers.get("x-sparkflow-worker-origin");
		if (origin) {
			await this.ctx.storage.put("workerOrigin", origin);
		}

		this.starting ??= this.startAndWaitForPort().finally(() => {
			this.starting = undefined;
		});
		await this.starting;

		const url = new URL(request.url);
		url.protocol = "http:";
		url.host = "container";
		const forwarded = new Request(url, request);
		forwarded.headers.delete("host");
		return this.ctx.container!.getTcpPort(APP_PORT).fetch(forwarded);
	}

	async heartbeat(): Promise<void> {
		this.starting ??= this.startAndWaitForPort().finally(() => {
			this.starting = undefined;
		});
		await this.starting;
	}

	async checkpoint(): Promise<{ ok: boolean; error?: string }> {
		const container = this.ctx.container;
		if (!container?.running) {
			return { ok: false, error: "Container is not running" };
		}

		try {
			const snapshot = await container.snapshotContainer({ name: "sparkflow" });
			await this.ctx.storage.put<SavedSnapshot>("filesystemSnapshot", {
				id: snapshot.id,
				image: container.images.base,
				createdAt: Date.now(),
			});
			return { ok: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("Container checkpoint failed", message);
			return { ok: false, error: message };
		}
	}

	private async startAndWaitForPort(): Promise<void> {
		const container = this.ctx.container;
		if (!container) {
			throw new Error("Cloudflare Container binding is unavailable");
		}

		if (!container.running) {
			if (!this.env.SPARKFLOW_CF_CHECKPOINT_TOKEN) {
				throw new Error("Set the SPARKFLOW_CF_CHECKPOINT_TOKEN Worker secret");
			}

			const workerOrigin =
				(await this.ctx.storage.get<string>("workerOrigin")) || "";
			const saved = await this.ctx.storage.get<SavedSnapshot>("filesystemSnapshot");
			const options = {
				entrypoint: ["bash", "/app/scripts/cloudflare-entrypoint.sh"],
				enableInternet: true,
				instance: CONTAINER_INSTANCE,
				env: {
					TZ: "Asia/Shanghai",
					DISPLAY: ":99",
					PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
					LOGIN_DESKTOP_MODE: "novnc",
					SPARKFLOW_LOGIN_DESKTOP_MODE: "novnc",
					LOGIN_DESKTOP_API_PORT: "18090",
					LOGIN_DESKTOP_WEB_PORT: "6080",
					LOGIN_DESKTOP_API_TOKEN_FILE: "/run/login-api/token",
					LOGIN_PROFILE_DIR: "/app/state/login-profile",
					LOGIN_DESKTOP_PROXY_MODE: "direct",
					SPARKFLOW_BROWSER_PROFILE_ROOT: "/app/state/browser-profiles",
					SPARKFLOW_LOGIN_DESKTOP_API_URL: "http://127.0.0.1:18090",
					SPARKFLOW_LOGIN_DESKTOP_NOVNC_URL: "http://127.0.0.1:6080",
					SPARKFLOW_LOGIN_DESKTOP_NOVNC_WS_URL:
						"ws://127.0.0.1:6080/websockify",
					SPARKFLOW_SESSION_COOKIE_SECURE: "1",
					SPARKFLOW_CF_CHECKPOINT_URL: workerOrigin
						? `${workerOrigin}/__cf/checkpoint`
						: "",
					SPARKFLOW_CF_CHECKPOINT_TOKEN:
						this.env.SPARKFLOW_CF_CHECKPOINT_TOKEN,
				},
			};

			if (saved) {
				if (saved.image !== container.images.base) {
					throw new Error(
						"Saved SparkFlow data belongs to a different container image; refusing to discard the snapshot",
					);
				}
				container.start({ ...options, containerSnapshot: { id: saved.id } });
			} else {
				container.start({ ...options, image: container.images.base });
			}
		}

		await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
		const port = container.getTcpPort(APP_PORT);
		let lastError: unknown;
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				const response = await port.fetch("http://container/login", {
					signal: AbortSignal.timeout(1000),
				});
				await response.body?.cancel();
				if (!response.ok) {
					throw new Error(`SparkFlow returned HTTP ${response.status} during startup`);
				}
				return;
			} catch (error) {
				lastError = error;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		}
		throw new Error("SparkFlow did not become ready on port 8787", {
			cause: lastError,
		});
	}
}

function runtimeStub(env: Env): DurableObjectStub<SparkFlowRuntime> {
	return env.RUNTIME.get(env.RUNTIME.idFromName("primary"));
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/__cf/checkpoint") {
			if (request.method !== "POST") {
				return new Response("Method not allowed", {
					status: 405,
					headers: { Allow: "POST" },
				});
			}
			const token = request.headers.get("authorization") || "";
			const expected = `Bearer ${env.SPARKFLOW_CF_CHECKPOINT_TOKEN}`;
			if (!env.SPARKFLOW_CF_CHECKPOINT_TOKEN || token !== expected) {
				return new Response("Forbidden", { status: 403 });
			}

			const result = await runtimeStub(env).checkpoint();
			return Response.json(result, { status: result.ok ? 200 : 503 });
		}

		const runtime = runtimeStub(env);
		if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
			return runtime.fetch(request);
		}
		const forwarded = new Request(request);
		forwarded.headers.set("x-sparkflow-worker-origin", url.origin);
		return runtime.fetch(forwarded);
	},

	scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
		ctx.waitUntil(runtimeStub(env).heartbeat());
	},
} satisfies ExportedHandler<Env>;
