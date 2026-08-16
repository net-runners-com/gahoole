import readline from "node:readline/promises";
import { readFileSync } from "node:fs";
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
import { registerFileGuard } from "./hooks/file-guard.js";
import {
  approvalMode,
  registerApproval,
  type ApprovalControl,
  type ApprovalMode,
} from "./hooks/approval.js";
import { connectMcp } from "./mcp.js";
import { onAiModeRateLimit } from "./backends/aimode.js";
import { Spinner } from "./spinner.js";
import { bindLineOwner } from "./output.js";
import { extractAttachments } from "./attachments.js";
import { createSpawnTool, SPAWN_TOOL } from "./subagent.js";
import { runAutonomously } from "./autonomous.js";
import { renderPlan } from "./plan.js";
import { formatSessions, SessionStore } from "./sessions.js";
import { HandoffStore } from "./handoff.js";
import { banner, readVersion, statusLine, type BannerInfo } from "./banner.js";
import { backendKind, createBackend, type Backend } from "./backends/index.js";
import { ToolLoop } from "./tool-loop.js";
import { tools as localTools } from "./tools.js";
import { ensureTrusted, trustedPaths, trustStorePath, untrust } from "./trust.js";
import {
  DEFAULT_PROFILE,
  findProfile,
  profileNames,
  renderProfiles,
  toolsFor,
  type Profile,
} from "./profiles.js";
import { MODEL } from "./agent.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

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
    /approve [mode]    ask (default), allow, or deny — show it with no argument
    /trust [revoke]    list the trusted folders, or stop trusting this one
    /profile [name]    switch how the model works — show them with no argument

  autonomous
    /auto <goal>       plan the work, then carry it out step by step
                       (up to the profile's step ceiling, or GAHOOLE_MAX_STEPS)

  new session from this one
    /clear             start empty
    /compact           carry a summary forward
    /fork              branch, keeping this session intact

  /help  /exit
`;

const USAGE = `gahoole — a local agent with a Claude Code-shaped lifecycle

usage
  gahoole                    start a new session
  gahoole --allow, -y        run writes and commands without asking
  gahoole --continue, -c     resume the most recent session
  gahoole --resume <prefix>  resume a session by id prefix
  gahoole --profile <name>   start in a profile (athena, pythia, daedalus, argus)
  gahoole --trust            trust this folder without asking
  gahoole --no-banner        skip the startup art
  gahoole --version, -v      print the version
  gahoole --help, -h         this text

environment
  ANTHROPIC_API_KEY   required
  GAHOOLE_DB_URL      default file:./data/gahoole.db
  GAHOOLE_USER        default local-user
  GAHOOLE_PROFILE     default athena
  MCP_CONFIG          default mcp.json
  MCP_ALLOW/MCP_DENY  comma-separated MCP tool policy
  NO_COLOR            disable colour`;

/** Set once the spinner exists, so a signal handler can silence it. */
let spinnerRef: { stop(): void } | undefined;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(readVersion());
    return;
  }
  // Before anything reads, writes or launches out of this folder — the memory
  // store creates data/ and connectMcp runs whatever mcp.json names, both of
  // which are actions on a directory we have not been told we may act on.
  if (!(await ensureTrusted(process.cwd(), { assume: argv.includes("--trust") }))) {
    process.exitCode = 1;
    return;
  }

  // The prompt profile, not the browser profiles the AI Mode backend rotates
  // through on a rate limit — those are Chromium data directories and are not
  // reachable from here.
  const profileIdx = argv.indexOf("--profile");
  const wantProfile =
    (profileIdx === -1 ? undefined : argv[profileIdx + 1]) ??
    process.env.GAHOOLE_PROFILE ??
    DEFAULT_PROFILE;
  const startProfile = findProfile(wantProfile);
  if (!startProfile) {
    console.error(
      `unknown profile "${wantProfile}" — try one of ${profileNames().join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }
  // Reassigned by /profile, so it is a binding rather than a constant — and
  // typed, because a `let` initialised from a guarded lookup widens back to
  // `| undefined` inside the closures below.
  let profile: Profile = startProfile;

  const wantContinue = argv.includes("--continue") || argv.includes("-c");
  const resumeIdx = argv.indexOf("--resume");
  const wantResume = resumeIdx === -1 ? undefined : argv[resumeIdx + 1];

  const lifecycle = new Lifecycle();
  registerJsonlLog(lifecycle);
  registerWriteGuard(lifecycle);
  registerFileGuard(lifecycle);

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

  const handoffs = new HandoffStore(memory, RESOURCE_ID);
  let carriedOver = false;

  const mcp = await connectMcp(lifecycle, { quiet: true });
  registerMcpPolicy(lifecycle, mcp.servers);
  const agent = createAgent(lifecycle, memory, mcp.tools);

  // The model backend. ai-mode drives a browser and needs no key; api uses
  // the Mastra agent and is the only one that can call tools.
  const kind = backendKind();
  const raw = createBackend(kind, agent, RESOURCE_ID, () => session.id);

  // The api backend calls tools natively; ai-mode gets the text protocol.
  const allTools: Record<string, unknown> = { ...localTools, ...mcp.tools };

  // Subagents are only offered when the backend can open a second
  // conversation. The tool is added to the same map it delegates, so a
  // subagent inherits every tool except the one that spawns more.
  if (raw.fork && process.env.GAHOOLE_SUBAGENTS !== "0") {
    allTools[SPAWN_TOOL] = createSpawnTool({
      fork: () => raw.fork!(),
      tools: allTools,
      lifecycle,
    });
  }
  const loop =
    kind === "ai-mode" && process.env.GAHOOLE_TOOLS !== "0"
      ? new ToolLoop(raw, allTools, lifecycle)
      : undefined;
  loop?.use(profile, toolsFor(profile, allTools));
  const backend: Backend = loop ?? raw;
  Session.backend = backend;
  lifecycle.on("ProcessExit", async () => {
    await backend.close?.();
  });

  // Ctrl-C is how a REPL is normally left, and it skips the finally below.
  // Without this the headless browser outlives the process and holds the
  // profile lock, so the next start fails with "profile is already in use".
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      if (closing) process.exit(130);
      closing = true;
      spinnerRef?.stop();
      void backend
        .close?.()
        .catch(() => {})
        .finally(() => process.exit(130));
      // Do not wait forever on a browser that will not close.
      setTimeout(() => process.exit(130), 3000).unref();
    });
  }
  // Each gahoole session gets its own model-side conversation.
  lifecycle.on("SessionStart", () => {
    backend.reset?.();
  });

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

  const info = (): BannerInfo => ({
    version: readVersion(),
    model: kind === "ai-mode" ? backend.name : MODEL,
    cwd: process.cwd(),
    sessionId: session.id,
    origin: startId ? "resumed" : carriedOver ? "carried over" : undefined,
    // What this profile can actually reach, not what exists.
    tools: Object.keys(loop?.tools ?? allTools).length,
    profile: profile.name,
    mcpServers: mcp.servers.length,
  });

  if (!argv.includes("--no-banner")) stdout.write(banner(info()));

  // Traced from here on: the opening session is already named in the panel,
  // and tracing it would print above the box.
  registerConsoleTrace(lifecycle);

  // The spinner is driven entirely by the lifecycle, so its label is whatever
  // is actually happening rather than a guess made at the call site.
  const spinner = new Spinner();
  spinnerRef = spinner;
  bindLineOwner(spinner);

  // A rotation takes seconds and a wait takes minutes; both look like a hang
  // unless they are announced.
  onAiModeRateLimit((rotation, rotating) => {
    spinner.label(
      rotating
        ? `rate limited — switching profile (${rotation})`
        : "rate limited — waiting",
    );
  });

  lifecycle
    .on("UserPromptSubmit", () => spinner.start("thinking"))
    .on("PreToolUse", (e) => spinner.label(`running ${e.toolName}`))
    .on("PostToolUse", () => spinner.label("thinking"))
    .on("Stop", () => spinner.stop())
    .on("StopFailure", () => spinner.stop());

  // Reprinted whenever the session changes, so the id under the cursor is
  // always the one the next question will go to.
  const showStatus = () => {
    if (!stdin.isTTY) return;
    const mode = approval?.mode ?? startMode;
    const suffix = mode === "ask" ? "" : ` · approval: ${mode}`;
    console.log(statusLine(info(), !process.env.NO_COLOR) + suffix);
  };

  const interactive = stdin.isTTY;
  const rl = interactive
    ? readline.createInterface({ input: stdin, output: stdout })
    : undefined;
  const batchInput = interactive ? "" : readFileSync(0, "utf8");

  // Approval runs mid-turn, so the spinner has to get out of the way for the
  // question and come back after. Without a terminal there is no one to ask,
  // and the hook declines rather than guessing.
  // --allow / -y starts in allow mode; without a terminal there is nobody to
  // ask, so the hook declines rather than guessing.
  const startMode: ApprovalMode =
    argv.includes("--allow") || argv.includes("-y") ? "allow" : approvalMode();
  let approval: ApprovalControl | undefined;
  if (rl) {
    const ask = rl.question.bind(rl);
    approval = registerApproval(lifecycle, ask, {
      mode: startMode,
      pause: () => spinner.stop(),
      resume: () => spinner.start("thinking"),
    });
  }
  if (interactive) {
    console.log(`\n${DIM}/help for commands, /exit to leave${RESET}\n`);
  }

  let exitCode = 0;

  /** Handle one line of input. Returns false when the session should end. */
  const handleLine = async (raw: string): Promise<boolean> => {
    const line = raw.trim();
    {
      if (!line) return true;

      if (line.startsWith("/")) {
        const [cmd = "", ...rest] = line.slice(1).split(/\s+/);
        const arg = rest.join(" ").trim();

        try {
          switch (cmd) {
            case "exit":
            case "quit":
              return false;

            case "help":
              console.log(HELP);
              break;

            case "id":
              console.log(session.id);
              break;

            case "approve": {
              if (!approval) {
                console.log("approval is only available in a terminal");
                break;
              }
              const next = arg.toLowerCase();
              if (!next) {
                console.log(
                  `  ${approval.mode}${approval.always.size ? ` · always: ${[...approval.always].join(", ")}` : ""}`,
                );
                break;
              }
              if (next !== "ask" && next !== "allow" && next !== "deny") {
                console.log("usage: /approve [ask|allow|deny]");
                break;
              }
              approval.set(next);
              console.log(
                next === "allow"
                  ? "  \x1b[33mallow — writes, deletes and commands run without asking\x1b[0m"
                  : `  ${next}`,
              );
              break;
            }

            case "profile": {
              if (!arg) {
                console.log(renderProfiles(profile.name, !process.env.NO_COLOR));
                break;
              }
              const next = findProfile(arg);
              if (!next) {
                console.log(`  unknown profile — ${profileNames().join(", ")}`);
                break;
              }
              if (!loop) {
                console.log("  profiles only apply to the ai-mode backend");
                break;
              }
              profile = next;
              const active = toolsFor(profile, allTools);
              loop.use(profile, active);
              console.log(
                `  ${profile.name} · ${profile.summary}\n` +
                  `  ${DIM}${Object.keys(active).length} tools · ${profile.rounds} rounds${RESET}`,
              );
              // The brief rides on the next question, so the switch costs no
              // query of its own.
              showStatus();
              break;
            }

            case "trust": {
              if (arg.toLowerCase() === "revoke") {
                const dropped = untrust(process.cwd());
                console.log(
                  dropped
                    ? `  ${process.cwd()} is no longer trusted — it will ask again next time`
                    : "  this folder was trusted through a parent directory, not on its own",
                );
                break;
              }
              const paths = trustedPaths();
              console.log(
                `  ${paths.length} trusted folder${paths.length === 1 ? "" : "s"} ${DIM}(${trustStorePath})${RESET}`,
              );
              for (const p of paths) {
                console.log(`  ${p === process.cwd() ? "›" : " "} ${p}`);
              }
              break;
            }

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

            case "auto": {
              if (!arg) {
                console.log("usage: /auto <goal>");
                break;
              }
              const result = await runAutonomously(arg, {
                // The profile sets the ceiling; the environment still wins,
                // because someone who set it meant it.
                maxSteps: Number(process.env.GAHOOLE_MAX_STEPS ?? profile.steps),
                run: (p) => session.run(p),
                onPlan: (tasks) =>
                  console.log(`\n${renderPlan(tasks, !process.env.NO_COLOR)}\n`),
              });
              const done = result.tasks.filter((t) => t.status === "done").length;
              console.log(
                `\x1b[2m  ${result.stopped} · ${done}/${result.tasks.length} done · ${result.steps} steps\x1b[0m\n`,
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
              showStatus();
              break;
            }

            case "continue": {
              const latest = await sessions.latest();
              if (!latest || latest.id === session.id) {
                console.log("already on the most recent session");
                break;
              }
              session = await session.resume(latest.id);
              showStatus();
              break;
            }

            case "clear": {
              session = await session.clear();
              showStatus();
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
              showStatus();
              break;

            case "compact": {
              const { next, summary } = await session.compact();
              session = next;
              showStatus();
              console.log(`\x1b[2m${summary}\x1b[0m\n`);
              break;
            }

            default:
              console.log(`unknown command: /${cmd}`);
          }
        } catch (e) {
          console.error(
            `\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m`,
          );
        }
        return true;
      }

      try {
        // A dragged-in image arrives as a path in the prompt; send it as an
        // attachment and let the rest of the line be the question.
        const { paths, prompt } = extractAttachments(line);
        if (paths.length) {
          console.log(
            `\x1b[2m  attaching ${paths.length} image${paths.length > 1 ? "s" : ""}\x1b[0m`,
          );
        }
        const text = await session.run(
          prompt || "この画像について説明してください。",
          undefined,
          paths,
        );
        console.log(`\n${text}\n`);
      } catch (e) {
        // StopFailure already fired; a failed turn does not end the session.
        console.error(`\x1b[31m${e instanceof Error ? e.message : e}\x1b[0m\n`);
        exitCode = 1;
      }
      return true;
    }
  };

  try {
    if (interactive) {
      while (true) {
        let line: string;
        try {
          line = await rl!.question("› ");
        } catch {
          break; // Ctrl-D
        }
        if (!(await handleLine(line))) break;
      }
    } else {
      // Piped input runs as a script: every line in order, then exit. Reading
      // it up front rather than through readline keeps this path independent
      // of whatever else in the process is attached to stdin.
      for (const line of batchInput.split("\n")) {
        if (!(await handleLine(line))) break;
      }
    }
  } finally {
    rl?.close();
    await session.end("exit");
    await lifecycle.emit("ProcessExit", { code: exitCode, sessions: opened });
  }

  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
