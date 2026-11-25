import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const maxRequestBytes = 131_072;

export async function startPeerSocket(exchange) {
  // The private directory protects the socket before it begins accepting connections.
  const directory = await mkdtemp(join(tmpdir(), "via-peer-"));
  const path = join(directory, "peer.sock");
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const chunks = [];
    let bytes = 0;
    socket.on("error", () => {});
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxRequestBytes) socket.destroy();
      else chunks.push(chunk);
    });
    socket.on("end", async () => {
      let response;
      try {
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response = { ok: true, result: await exchange.request(request) };
      } catch (error) {
        response = { ok: false, error: error.message };
      }
      socket.end(JSON.stringify(response));
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
