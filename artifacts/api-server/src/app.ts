import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// In dev mode, proxy everything else to the Vite dev server so that Express
// is the single external port (no Replit CDN confusion with the proxy chain).
if (process.env.NODE_ENV === "development") {
  const { createProxyMiddleware } = await import("http-proxy-middleware");
  const vitePort = process.env.VITE_PORT ?? "5173";
  const viteProxy = createProxyMiddleware({
    target: `http://localhost:${vitePort}`,
    changeOrigin: true,
    ws: true,
    on: {
      error: (err, _req, res) => {
        logger.warn({ err }, "Vite proxy error — is Vite running?");
        if (!("headersSent" in res && res.headersSent)) {
          (res as any).writeHead?.(503, { "Content-Type": "text/plain" });
          res.end("Vite dev server is starting up — please refresh in a moment.");
        }
      },
    },
  });
  app.use(viteProxy);
}

export default app;
