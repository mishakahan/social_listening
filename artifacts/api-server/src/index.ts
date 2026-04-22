import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

logger.info({ port, env: { PORT: process.env["PORT"], NODE_ENV: process.env["NODE_ENV"] } }, "Starting server");

const server = app.listen(port, () => {
  const addr = server.address();
  logger.info({ port, addr }, "Server listening");
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
