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
import { allowReadOutsideRoot, registerFileGuard } from "./hooks/file-guard.js";
import {
  approvalMode,
  registerApproval,
  type ApprovalControl,
  type ApprovalMode,
} from "./hooks/approval.js";
import { connectMcp } from "./mcp.js";
import {
  onAiModeEmpty,
  onAiModePartial,
  onAiModeRateLimit,
  onAiModeRelaunch,
} from "./backends/aimode.js";
import { Spinner } from "./spinner.js";
import { bindLineOwner } from "./output.js";
import { LineStream, remainder } from "./stream.js";
import { createServer, listen } from "./serve.js";
import { beginTurn, cancelTurn, isInterrupted } from "./interrupt.js";
import { extractAttachments } from "./attachments.js";
import { createSpawnTool, SPAWN_TOOL } from "./subagent.js";
import { runAutonomously } from "./autonomous.js";
import { renderPlan } from "./plan.js";
import { formatSessions, SessionStore } from "./sessions.js";
import { HandoffStore } from "./handoff.js";
import { migrate, projectInstructions, settings } from "./paths.js";
import {
  allSkills,
  findSkill,
  createSkillTool,
  loadPlugins,
  renderPlugins,
  skillPrompt,
  skillsHint,
  type Skill,
} from "./plugins.js";
import {
  ObservationStore,
  renderObservations,
  seedFrom,
} from "./observations.js";
import { banner, readVersion, statusLine, type BannerInfo } from "./banner.js";
import { backendKind, createBackend, type Backend } from "./backends/index.js";
import { ToolLoop } from "./tool-loop.js";
import { allowReadRoot, tools as localTools } from "./tools.js";
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
    /memory [query]    what earlier sessions established; a word filters it
    /plugins           the skills that are installed, and how to call them
    /profile [name]    switch how the model works — show them with no argument

  autonomous
    /auto <goal>       plan the work, then carry it out step by step
                       (up to the profile's step ceiling, or GAHOOLE_MAX_STEPS)

  new session from this one
    /clear             start empty
    /compact           carry a summary forward
    /fork              branch, keeping this session intact

  /help  /exit          Esc stops a turn that is running
`;

const USAGE = `gahoole — a local agent with a Claude Code-shaped lifecycle

usage
  gahoole                    start a new session
  gahoole --allow, -y        run writes and commands without asking
  gahoole --continue, -c     resume the most recent session
  gahoole --resume <prefix>  resume a session by id prefix
  gahoole --profile <name>   start in a profile (athena, pythia, daedalus, argus)
  gahoole --serve [port]     answer on http://127.0.0.1:8765/v1/chat/completions
  gahoole --host <addr>      bind the server somewhere other than localhost
  gahoole --trust            trust this folder without asking
  gahoole --no-banner        skip the startup art
  gahoole --version, -v      print the version
  gahoole --help, -h         this text

environment
  ANTHROPIC_API_KEY   required
  GAHOOLE_RECORD      append every exchange to this file
  GAHOOLE_BACKEND     ai-mode (default), api, stub, replay
  GAHOOLE_REPLAY      the recording to answer from
  GAHOOLE_OLLAMA_MODEL  default qwen3:4b, used for summaries when running
  GAHOOLE_LOCAL_SUMMARY 0 to keep summaries on the main backend
  GAHOOLE_HOME        default ~/.gahoole
  GAHOOLE_DIR         default ~/.gahoole/projects/<this project>
  GAHOOLE_DB_URL      default <that directory>/gahoole.db
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

  // Everything gahoole keeps lives in .gahoole/. A project from before the
  // rename has it in data/, and a directory full of somebody's sessions is not
  // something to abandon in place.
  const moved = migrate();
  if (moved) console.log(`${DIM}${moved}${RESET}`);

  // Defaults from ~/.gahoole/settings.json, then this project's on top. A flag
  // beats both, because it was typed just now.
  const config = settings();

  // The prompt profile, not the browser profiles the AI Mode backend rotates
  // through on a rate limit — those are Chromium data directories and are not
  // reachable from here.
  const profileIdx = argv.indexOf("--profile");
  const wantProfile =
    (profileIdx === -1 ? undefined : argv[profileIdx + 1]) ??
    process.env.GAHOOLE_PROFILE ??
    config.profile ??
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
  const notes = new ObservationStore(RESOURCE_ID);
  const plugins = loadPlugins();
  // A skill has to be able to read the files its plugin ships with.
  for (const plugin of plugins) {
    allowReadRoot(plugin.root);
    allowReadOutsideRoot(plugin.root);
  }
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
  // Skills, reachable from a question rather than only from a typed command.
  // The tool records the choice; the run happens after the turn, below.
  // A box rather than a binding: the only assignment happens inside a
  // callback, and TypeScript narrows a plain `let` to `never` at the point it
  // is read because it cannot see that the callback ran.
  const picked: { current?: { skill: Skill; args: string } } = {};
  {
    const { createTool } = await import("@mastra/core/tools");
    const { z } = await import("zod");
    const skillTool = createSkillTool(plugins, createTool, z, (skill, args) => {
      // The first choice, not the last. A turn asked for four skills in a
      // row — doc-new twice, then doc-build, then doc — and taking the last
      // one ran the reference skill instead of the one that makes the file.
      picked.current ??= { skill, args };
    });
    if (skillTool) allTools["use_skill"] = skillTool;
  }

  if (raw.fork && process.env.GAHOOLE_SUBAGENTS !== "0") {
    allTools[SPAWN_TOOL] = createSpawnTool({
      fork: () => raw.fork!(),
      tools: allTools,
      lifecycle,
    });
  }
  const loop =
    // The api backend calls tools natively; everything else gets the text
    // protocol, the stub included — that is the point of the stub.
    kind !== "api" && process.env.GAHOOLE_TOOLS !== "0"
      ? new ToolLoop(raw, allTools, lifecycle)
      : undefined;
  // Skills are worth a line in the reminder, not only in the preamble; see
  // the note on skillsHint.
  if (profile.sealed) {
    console.log(
      `${DIM}${profile.name} · nothing carried in: no notes, no GAHOOLE.md, ` +
        `no handoff${RESET}`,
    );
  }

  const hint = skillsHint(plugins);
  if (hint) profile = { ...profile, hint: [profile.hint, hint].filter(Boolean).join(" ") };
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
  // GAHOOLE.md, the way Claude Code reads CLAUDE.md: what this project needs
  // said every time, kept in the repository rather than in a person's memory.
  // Seeded rather than prepended to each prompt — the tool preamble already
  // rides on every question and the wording of it is fragile.
  {
    const instructions = profile.sealed ? "" : projectInstructions();
    if (instructions) {
      await session.seedContext(
        `Instructions for this project, from GAHOOLE.md:\n\n${instructions}`,
      );
      console.log(
        `\x1b[2mGAHOOLE.md · ${instructions.split("\n").length} lines of project instructions\x1b[0m`,
      );
    }
  }

  // What earlier sessions established, whether or not one of them was cut
  // short. A handoff is the interrupted case; this is the ordinary one.
  {
    const earlier = profile.sealed ? [] : notes.recent(20);
    if (earlier.length && !startId) {
      await session.seedContext(seedFrom(earlier));
      console.log(
        `\x1b[2mcarrying ${earlier.length} note${earlier.length === 1 ? "" : "s"} ` +
          `from earlier sessions · /memory to see them\x1b[0m`,
      );
    }
  }

  // A sealed profile is given nothing to go on, the interrupted conversation
  // included; see the note on Profile.sealed.
  const pending = startId || profile.sealed ? undefined : handoffs.read();
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
        `\x1b[33m${f.kind} — conversation saved to the handoff.${wait}\n` +
          `  restart, or /clear, to continue from it.\x1b[0m`,
      );
    },
  });

  const info = (): BannerInfo => ({
    version: readVersion(),
    model: kind === "api" ? MODEL : backend.name,
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

  // A crash used to look like a very long wait.
  onAiModeRelaunch((why) => {
    spinner.label(`browser died (${why.slice(0, 40)}) — restarting`);
  });

  onAiModeEmpty(() => {
    spinner.label("the page came back empty — asking again");
  });

  // The answer as it is written.
  //
  // There is no streaming API — the page fills in over several seconds and
  // #settle is already polling it — so each poll hands over the whole answer
  // so far and LineStream works out which lines are finished. A line is shown
  // only once it has a newline behind it, because a terminal cannot take back
  // what it printed.
  //
  // Off with GAHOOLE_NO_STREAM=1, and off automatically when there is no
  // terminal: a redirect wants the answer once, not as it was assembled.
  const stream = new LineStream();
  const shown: string[] = [];
  const streaming = stdout.isTTY && process.env.GAHOOLE_NO_STREAM !== "1";
  if (streaming) {
    onAiModePartial((text) => {
      const lines = stream.feed(text);
      if (lines.length === 0) return;
      // The spinner owns the line it is drawing on, so it stands aside — and
      // stays aside, because a spinner restarted between every line flickers
      // more than it informs.
      spinner.stop();
      for (const line of lines) {
        stdout.write(`${line}\n`);
        shown.push(line);
      }
    });
  }

  /**
   * Esc, while a turn is running.
   *
   * readline owns stdin at the prompt, and it is idle while a question is in
   * flight — so the key is watched only for the length of a turn, and raw mode
   * is handed straight back afterwards. Approval asks through readline
   * mid-turn, so the watch stands aside for that too, which is what the
   * pause/resume below already do for the spinner.
   */
  let watching = false;
  const onKey = (buf: Buffer): void => {
    if (buf.toString() !== "\x1b") return;
    cancelTurn();
    spinner.label("stopping");
  };
  const watchEsc = (on: boolean): void => {
    if (!interactive || !stdin.isTTY || on === watching) return;
    watching = on;
    if (on) {
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
      stdin.on("data", onKey);
    } else {
      stdin.off("data", onKey);
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
    }
  };

  lifecycle
    .on("UserPromptSubmit", () => {
      beginTurn();
      watchEsc(true);
      spinner.start("thinking");
    })
    .on("PreToolUse", (e) => {
      // The next reply restarts the answer text, so the stream restarts too.
      stream.next();
      spinner.label(`running ${e.toolName}`);
    })
    .on("PostToolUse", () => spinner.label("thinking"))
    .on("Stop", () => {
      watchEsc(false);
      spinner.stop();
    })
    .on("StopFailure", () => {
      watchEsc(false);
      spinner.stop();
    });

  /**
   * Run a skill: its instructions become the question.
   *
   * The tool set narrows to what the skill asked for, and widens back
   * afterwards whatever happened — a skill that failed halfway must not leave
   * the session holding a tool set nobody chose.
   */
  const runSkill = async (
    skill: Skill,
    args: string,
    opts: { autonomous?: boolean } = {},
  ): Promise<void> => {
    const wanted = skill.tools;
    if (loop) {
      // A skill is a procedure, not a question: read the reference, look at
      // the data, write the spec, check it, build it. Measured on doc-skill,
      // four rounds ran out having read three files and written nothing — so
      // a skill gets a working budget even under a thinking profile.
      const forSkill = { ...profile, rounds: Math.max(profile.rounds, 10) };
      const offered = toolsFor(profile, allTools);
      const narrowed = wanted
        ? Object.fromEntries(Object.entries(offered).filter(([n]) => wanted.includes(n)))
        : offered;
      loop.use(forSkill, narrowed);
      console.log(
        `${DIM}  ${skill.plugin}/${skill.name} · ${Object.keys(narrowed).length} tools · ${forSkill.rounds} rounds${RESET}`,
      );
    } else {
      console.log(`${DIM}  ${skill.plugin}/${skill.name}${RESET}`);
    }
    try {
      if (opts.autonomous) {
        // A skill is a procedure and a procedure has to finish. Sent as one
        // turn it stopped early and variably — after two calls, then six,
        // then thirteen — so it goes through the loop that keeps asking until
        // the thing it produces exists.
        const result = await runAutonomously(skillPrompt(skill, args), {
          maxSteps: 6,
          run: (p) => session.run(p),
          onPlan: (tasks) =>
            console.log(`\n${renderPlan(tasks, !process.env.NO_COLOR)}\n`),
        });
        const done = result.tasks.filter((t) => t.status === "done").length;
        console.log(
          `${DIM}  ${result.stopped} · ${done}/${result.tasks.length} done · ${result.steps} steps${RESET}\n`,
        );
      } else {
        const text = await session.run(skillPrompt(skill, args));
        const left = stream.started ? remainder(text, shown) : text;
        if (left) console.log(`${stream.started ? "" : "\n"}${left}\n`);
      }
    } catch (e) {
      console.error(`\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m\n`);
    } finally {
      if (loop) loop.use(profile, toolsFor(profile, allTools));
    }
  };

  // Reprinted whenever the session changes, so the id under the cursor is
  // always the one the next question will go to.
  const showStatus = () => {
    if (!stdin.isTTY) return;
    const mode = approval.mode;
    const suffix = mode === "ask" ? "" : ` · approval: ${mode}`;
    console.log(statusLine(info(), !process.env.NO_COLOR) + suffix);
  };

  // Serving replaces the prompt: the questions come over HTTP instead.
  const serveIdx = argv.indexOf("--serve");
  const serving = serveIdx !== -1;
  const hostIdx = argv.indexOf("--host");

  const interactive = stdin.isTTY && !serving;
  const rl = interactive
    ? readline.createInterface({ input: stdin, output: stdout })
    : undefined;
  const batchInput = interactive || serving ? "" : readFileSync(0, "utf8");

  // Approval runs mid-turn, so the spinner has to get out of the way for the
  // question and come back after.
  //
  // It is registered whether or not there is a terminal. It used to be
  // registered only when there was one, which meant piping input into gahoole
  // registered no approval hook at all and every write, delete and command ran
  // ungated — the opposite of the intent, and silently so. Without a terminal
  // there is nobody to ask, so the answer is no unless the caller said
  // otherwise with --allow or GAHOOLE_APPROVE.
  const asked: ApprovalMode = approvalMode(config.approve);
  const startMode: ApprovalMode =
    argv.includes("--allow") || argv.includes("-y")
      ? "allow"
      : interactive || asked !== "ask"
        ? asked
        : "deny";
  const approval: ApprovalControl = registerApproval(
    lifecycle,
    rl ? rl.question.bind(rl) : async () => "n",
    {
      mode: startMode,
      pause: () => {
        watchEsc(false);
        spinner.stop();
      },
      resume: () => {
        spinner.start("thinking");
        watchEsc(true);
      },
    },
  );
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
              // Context cannot be taken back out of a conversation, so a
              // sealed profile gets a new one. Switching away does not undo
              // it — the reviewer's session simply continues, unseeded.
              if (next.sealed) {
                session = await session.clear();
                console.log(
                  `${DIM}  new session ${session.id.slice(0, 8)} · nothing carried in${RESET}`,
                );
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

            case "memory": {
              const found = arg ? notes.search(arg) : notes.recent(20);
              console.log(renderObservations(found, !process.env.NO_COLOR));
              if (!arg && found.length) {
                console.log(
                  `${DIM}  ${notes.all().length} recorded · /memory <word> to filter${RESET}`,
                );
              }
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
                maxSteps: Number(
                  process.env.GAHOOLE_MAX_STEPS ?? config.maxSteps ?? profile.steps,
                ),
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

            case "plugins":
              console.log(renderPlugins(plugins, !process.env.NO_COLOR));
              break;

            default: {
              // A skill is not a command this program defines, so it is looked
              // for last — a plugin cannot shadow /exit by naming a skill exit.
              const skill = findSkill(plugins, cmd);
              if (!skill) {
                console.log(`unknown command: /${cmd}`);
                break;
              }
              await runSkill(skill, arg);
              break;
            }
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
        stream.reset();
        shown.length = 0;
        picked.current = undefined;
        const text = await session.run(
          prompt || "この画像について説明してください。",
          undefined,
          paths,
        );
        // Whatever was streamed is already on screen; print the rest. The two
        // are not always the same — the tool loop keeps prose from several
        // replies, and a nudged reply is dropped from the answer after it has
        // been shown — so the difference is taken rather than assumed empty.
        const left = stream.started ? remainder(text, shown) : text;
        if (left) console.log(`${stream.started ? "" : "\n"}${left}\n`);
        else if (stream.started) console.log("");

        // The turn chose a skill; now carry it out.
        if (picked.current) {
          const { skill, args } = picked.current;
          picked.current = undefined;
          await runSkill(skill, args, { autonomous: true });
        }
      } catch (e) {
        // Stopping on purpose is not a failure, and the session carries on.
        if (isInterrupted(e)) {
          console.log(`${DIM}  stopped\x1b[0m\n`);
        } else {
          // StopFailure already fired; a failed turn does not end the session.
          console.error(`\x1b[31m${e instanceof Error ? e.message : e}\x1b[0m\n`);
          exitCode = 1;
        }
      }
      return true;
    }
  };

  try {
    if (serving) {
      const port = Number(argv[serveIdx + 1] ?? process.env.GAHOOLE_PORT ?? 8765);
      const host =
        hostIdx === -1 ? (process.env.GAHOOLE_HOST ?? "127.0.0.1") : (argv[hostIdx + 1] ?? "127.0.0.1");

      const server = createServer({
        deps: {
          model: info().model,
          session: () => session,
          run: (p) => session.run(p),
        },
        onRequest: (line) => console.log(`\x1b[2m› ${line}\x1b[0m`),
      });
      const bound = await listen(server, port, host);

      console.log(
        `${DIM}serving http://${host}:${bound}/v1/chat/completions${RESET}\n` +
          `${DIM}  model ${info().model} · approval ${approval.mode}` +
          `${host === "127.0.0.1" ? "" : " · reachable from the network"}${RESET}\n` +
          `${DIM}  one request at a time; Ctrl-C to stop${RESET}\n`,
      );
      if (approval.mode !== "allow") {
        console.log(
          `${DIM}  writes, deletes and commands are refused — nobody is here to ask.` +
            ` Start with --allow to permit them.${RESET}\n`,
        );
      }

      // Held open by the server; the finally below runs on Ctrl-C.
      await new Promise<void>((resolve) => server.once("close", () => resolve()));
    } else if (interactive) {
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
