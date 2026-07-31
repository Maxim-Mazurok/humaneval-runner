import { defineConfig, devices } from "@playwright/test";
import { createServer } from "node:net";

async function allocateAvailablePort() {
  const reservationServer = createServer();
  await new Promise<void>((resolve, reject) => {
    reservationServer.once("error", reject);
    reservationServer.listen(0, "127.0.0.1", resolve);
  });
  const address = reservationServer.address();
  if (!address || typeof address === "string") throw new Error("Failed to allocate a Playwright port.");
  const allocatedPort = address.port;
  await new Promise<void>((resolve, reject) => reservationServer.close((error) => (
    error ? reject(error) : resolve()
  )));
  return allocatedPort;
}

const frontendPort = Number(process.env.PLAYWRIGHT_FRONTEND_PORT) || await allocateAvailablePort();
let benchmarkPort = Number(process.env.PLAYWRIGHT_BENCHMARK_PORT) || await allocateAvailablePort();
while (benchmarkPort === frontendPort) benchmarkPort = await allocateAvailablePort();
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const benchmarkApiUrl = `http://127.0.0.1:${benchmarkPort}`;
process.env.PLAYWRIGHT_FRONTEND_PORT = String(frontendPort);
process.env.PLAYWRIGHT_BENCHMARK_PORT = String(benchmarkPort);
process.env.PLAYWRIGHT_BENCH_API_URL = benchmarkApiUrl;

export default defineConfig({
  testDir: "./tests/e2e",
  webServer: {
    command: `HUMANEVAL_PORT=${benchmarkPort} HUMANEVAL_FRONTEND_PORT=${frontendPort} VITE_BENCH_API_URL=${benchmarkApiUrl} npm run dev`,
    url: frontendUrl,
    reuseExistingServer: false
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: frontendUrl
  }
});
