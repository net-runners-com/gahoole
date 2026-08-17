import http from "node:http";
import { randomUUID } from "node:crypto";
import type { Session } from "./session.js";

/**
 * gahoole behind an OpenAI-shaped HTTP API.
 *
 * The point is not to pretend to be OpenAI. It is that everything already
 * speaks that shape — editors, scripts, other agents — and none of them will
 * learn a new one for this. So the endpoint is `/v1/chat/completions`, the
 * body is what those clients already send, and what comes back is an agent
 * turn: tools ran, files were written, the answer is what it ended with.
 *
 * Three things it does differently from a model API, because it is not one.
 *
 * It binds to 127.0.0.1 unless told otherwise. This serves something that
 * writes files and runs commands, and a default of "anyone on the network"
 * would be a decision made on the user's behalf that they never made.
 *
 * There is nobody to ask for approval over HTTP, so mutating tools are refused
 * unless the process was started with --allow. A request cannot grant itself
 * permission.
 *
 * And requests are answered one at a time. There is one browser and one
 * conversation behind this; two requests at once would interleave into it.
 */

export interface ServeDeps {
  /** Runs one turn through the whole stack. */
  run: (prompt: string) => Promise<string>;
  /** Shown in `/v1/models` and echoed back in responses. */
  model: string;
  session: () => Pick<Session, "id">;
  /** New conversation, for a request that asks for one. */
  reset?: () => Promise<void>;
}

export interface ServeOptions {
  port?: number;
  host?: string;
  deps: ServeDeps;
  /** Called for each request so the CLI can show it. */
  onRequest?: (line: string) => void;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
}

/** OpenAI sends content as a string, or as an array of typed parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const part = p as { type?: string; text?: string };
        return part?.type === "text" || part?.text ? (part.text ?? "") : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * The prompt for a turn, out of a conversation the client is holding.
 *
 * Only the last user message. The client sends its whole history every time,
 * and this has a history of its own on the other side — replaying the client's
 * would say everything twice. A system message rides along when there is one,
 * since that is where a caller puts instructions that hold for the session.
 */
export function promptFrom(messages: ChatMessage[]): string {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join("\n");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const question = textOf(lastUser?.content);
  // A conversation with instructions and no question is not a turn. Answering
  // the system message on its own would spend a query on nobody's question.
  if (!question) return "";
  return [system, question].filter(Boolean).join("\n\n");
}

const json = (res: http.ServerResponse, code: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
};

const fail = (res: http.ServerResponse, code: number, message: string): void =>
  json(res, code, { error: { message, type: "invalid_request_error" } });

export function createServer(opts: ServeOptions): http.Server {
  const { deps } = opts;

  // One at a time. There is a single browser conversation behind this, and two
  // requests at once would interleave into it.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/v1/models") {
      json(res, 200, {
        object: "list",
        data: [{ id: deps.model, object: "model", owned_by: "gahoole" }],
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, session: deps.session().id });
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      fail(res, 404, `no route for ${req.method} ${url.pathname}`);
      return;
    }

    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk;
      // A body this size is a mistake or an attack, and neither deserves memory.
      if (raw.length > 2_000_000) req.destroy();
    });
    req.on("end", () => {
      let body: { messages?: ChatMessage[]; stream?: boolean } = {};
      try {
        body = JSON.parse(raw || "{}") as typeof body;
      } catch {
        fail(res, 400, "the body is not JSON");
        return;
      }

      const prompt = promptFrom(body.messages ?? []);
      if (!prompt) {
        fail(res, 400, "no user message to answer");
        return;
      }

      opts.onRequest?.(prompt.replace(/\s+/g, " ").slice(0, 70));
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

      void serialize(async () => {
        try {
          const text = await deps.run(prompt);
          if (body.stream) {
            // The whole answer as one chunk. A turn here is not a stream of
            // tokens — tools run in the middle of it — and pretending
            // otherwise would mean holding the connection open through a file
            // write to no purpose.
            res.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
            const chunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model: deps.model,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: text },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            res.write(
              `data: ${JSON.stringify({
                ...chunk,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }

          json(res, 200, {
            id,
            object: "chat.completion",
            created,
            model: deps.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: text },
                finish_reason: "stop",
              },
            ],
            // Counted in what this actually spends. Tokens are not the unit
            // here — queries against a rate limit are — so the fields are
            // present for clients that read them and honest about being zero.
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        } catch (e) {
          fail(res, 500, e instanceof Error ? e.message : String(e));
        }
      });
    });
  });
}

export function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}
