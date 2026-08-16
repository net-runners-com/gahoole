import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Lifecycle } from "./lifecycle.js";
import { createAgent, createMemory } from "./agent.js";
import { Session } from "./session.js";
import {
  registerConsoleTrace,
  registerJsonlLog,
  registerMcpPolicy,
  registerWriteGuard,
} from "./hooks/logging.js";
import { connectMcp } from "./mcp.js";
import { formatSessions, SessionStore } from "./sessions.js";
import { HandoffStore } from "./handoff.js";
import { MODEL } from "./agent.js";

const RESOURCE_ID = process.env.GAHOOLE_USER ?? "local-user";

const HELP = `
  session
    /sessions          list sessions, newest first
    /resume <prefix>   switch to another session (id prefix is enough)
    /continue          switch to the most recently used session
    /rename <title>    name the current session
    /delete <prefix>   delete a session and its messages
    /id                print the current session id
    /handoff           show the carry-over waiting for the next session

  new session from this one
    /clear             start empty
    /compact           carry a summary forward
    /fork              branch, keeping this session intact

  /help  /exit
`;

const USAGE = `usage: gahoole [--continue] [--resume <prefix>]`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const wantContinue = argv.includes("--continue") || argv.includes("-c");
  const resumeIdx = argv.indexOf("--resume");
  const wantResume = resumeIdx === -1 ? undefined : argv[resumeIdx + 1];

  const lifecycle = new Lifecycle();
  registerJsonlLog(lifecycle);
  registerConsoleTrace(lifecycle);
  registerWriteGuard(lifecycle);

  const opened: string[] = [];
  lifecycle.on("SessionStart", (e) => {
    opened.push(e.sessionId);
  });

  await lifecycle.emit("ProcessStart", {
    pid: process.pid,
    argv,
    cwd: process.cwd(),
  });

  const memory = createMemory();
  const sessions = new SessionStore(memory, RESOURCE_ID);
  sessions.register(lifecycle);

  const handoffs = new HandoffStore(memory, RESOURCE_ID, MODEL);
  let carriedOver = false;

  const mcp = await connectMcp(lifecycle);
  registerMcpPolicy(lifecycle, mcp.servers);
  const agent = createAgent(lifecycle, memory, mcp.tools);

  // Which session does this process open with?
  let startId: string | undefined;
  if (wantResume) {
    startId = await sessions.resolve(wantResume);
  } else if (wantContinue) {
    startId = (await sessions.latest())?.id;
    if (!startId) console.log("no previous session — starting a new one");
  }

  let session = await Session.start({
    agent,
    memory,
    lifecycle,
    resourceId: RESOURCE_ID,
    sessionId: startId,
  });

  // A rate limit ended the last session; pick up where it stopped. Resuming an
  // explicit session id means the user chose their own continuation, so the
  // handoff is left on disk for whenever they do start fresh.
  const pending = startId ? undefined : handoffs.read();
  if (pending) {
    handoffs.take();
    await session.seedContext(HandoffStore.seedText(pending));
    carriedOver = true;
    console.log(
      `\x1b[33mcarried over from ${pending.sessionId.slice(0, 8)} ` +
        `(${pending.reason}${pending.summary ? ", summarized" : ", transcript only"})\x1b[0m`,
    );
  }

  // Once a turn succeeds the limit has cleared, so a handoff still owing its
  // summary can be upgraded.
  lifecycle.on("Stop", async () => {
    const owed = handoffs.read();
    if (owed?.pending) await handoffs.summarize(owed).catch(() => {});
  });

  handoffs.register(lifecycle, {
    turnsOf: () => session.turns,
    onCaptured: async (h, f) => {
      const wait = f.retryAfterMs
        ? ` retry after ${Math.ceil(f.retryAfterMs / 1000)}s.`
        : "";
      console.error(
        `\x1b[33m${f.kind} — conversation saved to data/handoff.${wait}\n` +
          `  restart, or /clear, to continue from it.\x1b[0m`,
      );
    },
  });

  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log(`\x1b[1mgahoole\x1b[0m — /help for session commands\n`);

  let exitCode = 0;
  try {
    while (true) {
      let line: string;
      try {
        line = (await rl.question("› ")).trim();
      } catch {
        break; // Ctrl-D
      }
      if (!line) continue;

      if (line.startsWith("/")) {
        const [cmd = "", ...rest] = line.slice(1).split(/\s+/);
        const arg = rest.join(" ").trim();

        try {
          switch (cmd) {
            case "exit":
            case "quit":
              throw { done: true };

            case "help":
              console.log(HELP);
              break;

            case "id":
              console.log(session.id);
              break;

            case "handoff": {
              const h = handoffs.read();
              if (!h) {
                console.log(
                  carriedOver
                    ? "  (consumed by this session)"
                    : "  (none pending)",
                );
                break;
              }
              console.log(
                `  from ${h.sessionId.slice(0, 8)} · ${h.reason} · ${h.turns} turns · ` +
                  `${h.pending ? "transcript only" : "summarized"}\n` +
                  `  ${(h.summary ?? h.digest).slice(0, 400)}`,
              );
              break;
            }

            case "sessions":
              console.log(
                formatSessions(await sessions.list(), session.id) + "\n",
              );
              break;

            case "rename": {
              if (!arg) {
                console.log("usage: /rename <title>");
                break;
              }
              await sessions.rename(session.id, arg);
              console.log(`renamed to "${arg}"`);
              break;
            }

            case "delete": {
              if (!arg) {
                console.log("usage: /delete <prefix>");
                break;
              }
              const id = await sessions.resolve(arg);
              if (id === session.id) {
                console.log(
                  "that is the current session — /clear or /resume elsewhere first",
                );
                break;
              }
              await sessions.remove(id);
              console.log(`deleted ${id.slice(0, 8)}`);
              break;
            }

            case "resume": {
              if (!arg) {
                console.log("usage: /resume <prefix>");
                break;
              }
              session = await session.resume(await sessions.resolve(arg));
              break;
            }

            case "continue": {
              const latest = await sessions.latest();
              if (!latest || latest.id === session.id) {
                console.log("already on the most recent session");
                break;
              }
              session = await session.resume(latest.id);
              break;
            }

            case "clear": {
              session = await session.clear();
              // /clear is also how you pick up a handoff without restarting.
              const waiting = handoffs.take();
              if (waiting) {
                await session.seedContext(HandoffStore.seedText(waiting));
                carriedOver = true;
                console.log(
                  `\x1b[33mcarried over from ${waiting.sessionId.slice(0, 8)}\x1b[0m`,
                );
              }
              break;
            }

            case "fork":
              session = await session.fork();
              break;

            case "compact": {
              const { next, summary } = await session.compact();
              session = next;
              console.log(`\x1b[2m${summary}\x1b[0m\n`);
              break;
            }

            default:
              console.log(`unknown command: /${cmd}`);
          }
        } catch (e) {
          if ((e as { done?: boolean })?.done) break;
          console.error(
            `\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m`,
          );
        }
        continue;
      }

      try {
        const text = await session.run(line);
        console.log(`\n${text}\n`);
      } catch (e) {
        // StopFailure already fired; the loop survives a failed turn.
        console.error(`\x1b[31m${e instanceof Error ? e.message : e}\x1b[0m\n`);
        exitCode = 1;
      }
    }
  } finally {
    rl.close();
    await session.end("exit");
    await lifecycle.emit("ProcessExit", { code: exitCode, sessions: opened });
  }

  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
