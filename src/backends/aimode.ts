import fs from "node:fs";
import path from "node:path";
import { launchPersistentContext } from "cloakbrowser";
import { readConversation } from "./extract.js";
import { inProject } from "../paths.js";

/**
 * Google AI Mode (`udm=50`) as the model backend.
 *
 * There is no API for it, so this drives the page: one browser conversation
 * per gahoole session, prompts typed into the composer, answers read out of
 * the DOM. That has consequences the rest of the program has to live with:
 *
 *   - No tool calling. AI Mode returns prose; it cannot call `write_note` or
 *     an MCP tool. The tool hooks still exist and still fire for anything the
 *     program calls itself, but the model never drives them.
 *   - No API key, and no per-token cost.
 *   - A rate limit measured at roughly 77–100 queries in ~10–13 minutes,
 *     which is *silent*: HTTP stays 200 and the answer is replaced by a short
 *     error string. Detecting it means reading the answer, not the status —
 *     which is what `BLOCKED` below is for.
 *
 * Selectors: class names are obfuscated and rotate, so this keys on the
 * `data-subtree="aimc"` conversation container and the `aria-label="送信"`
 * send button. Those have been stable; if Google changes them this breaks
 * loudly rather than silently.
 */

const PROFILE_ROOT = process.env.GAHOOLE_BROWSER_PROFILE
  ? path.resolve(process.env.GAHOOLE_BROWSER_PROFILE)
  : inProject("browser-profile");

/**
 * The rate limit is keyed on the session cookie, not the IP — measured: a
 * fresh profile answers immediately while the blocked one is still refused.
 * So the way to keep running is to rotate profiles, not to sit and wait. Each
 * one is a directory beside the first.
 */
const profileFor = (n: number): string =>
  n === 0 ? PROFILE_ROOT : `${PROFILE_ROOT}-${n}`;

/**
 * The browser is gone rather than the answer being wrong.
 *
 * A crashed tab, a context closed underneath us, a renderer that died — all
 * arrive as ordinary exceptions with no type to match on, so this matches the
 * message. It is deliberately narrow: a selector that stopped resolving is
 * *not* in here, because relaunching would just hide it.
 */
const CRASHED =
  /target (?:closed|crashed)|browser has been closed|browser has disconnected|session closed|page closed|protocol error|websocket/i;

/**
 * The page produced no conversation at all.
 *
 * Distinct from a rate limit, which replaces the answer with an error string,
 * and from a crash, which takes the browser with it. Measured: hammering one
 * profile with short questions, this happened once in forty queries and the
 * same profile answered normally straight afterwards — so it is a hiccup, and
 * a hiccup that ended the session was the whole cost of it.
 */
export class EmptyAnswerError extends Error {
  constructor() {
    super("AI Mode returned nothing");
    this.name = "EmptyAnswerError";
  }
}

export function looksLikeCrash(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return CRASHED.test(message);
}

/** What AI Mode shows instead of an answer once the limit is reached. */
const BLOCKED = /エラーが発生したため|回答が生成されませんでした|error occurred/i;

/** The composer is one of two textareas; the other is a 0×0 feedback field. */
const COMPOSER = "textarea:visible";

/**
 * The composer carries maxlength="8192". Anything longer is silently cut off
 * by the page, so cut it here where the truncation is at least visible.
 */
export const COMPOSER_MAX = 8000;
const SEND = 'button[aria-label="送信"], button[aria-label="Send"]';

const CONVERSATION = '[data-subtree="aimc"] [data-container-id="main-col"]';

/**
 * The file input only exists after the "add files and tools" button is
 * clicked, and two appear: one restricted to images, one that takes anything.
 */
const ADD_FILES = 'button[aria-label="ファイルとツールを追加"], button[aria-label="Add files and tools"]';
const IMAGE_INPUT = 'input[type=file][accept*="image/"]';

/** AI Mode with no query: the composer, ready for an attachment. */
const LANDING = "https://www.google.com/search?udm=50&aep=1&source=hp";

/**
 * Longest prompt still sent as `?q=`. Measured: a ~1000-character query
 * returns a page with no conversation container at all, and the turn fails
 * with "AI Mode returned nothing".
 */
const URL_MAX = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Where a turn's seconds go, when asked.
 *
 * `GAHOOLE_TIMING=1` prints a line per phase to stderr. A turn here is a
 * browser doing several things in sequence and the total says nothing about
 * which of them was slow — the answer to "why did that take thirteen seconds"
 * is a different fix depending on whether it was the launch, the typing, or
 * the model still writing.
 */
const timing = (): boolean => process.env.GAHOOLE_TIMING === "1";

async function phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!timing()) return fn();
  const at = Date.now();
  try {
    return await fn();
  } finally {
    process.stderr.write(`  [timing] ${name.padEnd(18)} ${Date.now() - at}ms\n`);
  }
}

/** Set by the CLI so a rotation is visible rather than a silent two-minute gap. */
let onRateLimit: ((rotation: number, rotating: boolean) => void) | undefined;
export function onAiModeRateLimit(
  fn: (rotation: number, rotating: boolean) => void,
): void {
  onRateLimit = fn;
}

/**
 * Set by the CLI to follow an answer as it is written.
 *
 * There is no streaming API here — the answer is read out of a page that fills
 * in over several seconds — but `#settle` is already polling that page every
 * 200ms to decide when it has stopped growing. Handing each poll to a listener
 * costs nothing and turns forty seconds of silence into forty seconds of
 * watching the answer arrive.
 */
let onPartial: ((text: string) => void) | undefined;
export function onAiModePartial(fn: ((text: string) => void) | undefined): void {
  onPartial = fn;
}

/** Set by the CLI so a crash is reported rather than looking like a long wait. */
let onRelaunch: ((why: string) => void) | undefined;
export function onAiModeRelaunch(fn: (why: string) => void): void {
  onRelaunch = fn;
}

/** Set by the CLI so a retried question is visible rather than just slow. */
let onEmpty: (() => void) | undefined;
export function onAiModeEmpty(fn: () => void): void {
  onEmpty = fn;
}

export class AiModeRateLimitError extends Error {
  /** Shaped so `classifyFailure` reads it the same way it reads a 429. */
  readonly status = 429;
  constructor() {
    super("rate_limit: AI Mode stopped generating answers");
    this.name = "AiModeRateLimitError";
  }
}

interface Ctx {
  close: () => Promise<void>;
  pages: () => { length: number }[];
  newPage: () => Promise<any>;
}

export interface AiModeOptions {
  headed?: boolean;
  /** Locale for the AI Mode UI; only affects the page, not the answer. */
  hl?: string;
  timeoutMs?: number;
  /** Which profile directory to start on. Used to measure one in isolation. */
  profile?: number;
  /**
   * How many times a refusal may be answered by opening a fresh profile.
   * Zero means a rate limit is reported rather than worked around — which is
   * what `npm run ratelimit` needs, since rotation is what it is measuring.
   */
  maxRotations?: number;
}

/**
 * The page appends its own furniture to every answer — the "AI can be wrong"
 * disclaimer and the feedback prompt. Trim it so the caller gets the answer.
 */
const CHROME = [
  /AI は不正確な情報を表示することがある[\s\S]*$/,
  /AI responses may include mistakes[\s\S]*$/i,
  /^\s*すべて表示\s*$/gm,
  // The disclaimer under a rendered code block, which arrives once per block
  // and is not part of the answer.
  /^\s*コードは注意してご使用ください。?\s*$/gm,
  /^\s*Use code with caution\.?\s*$/gim,
  // The bare language label the page prints above a block; the fence carries
  // it already.
  /^\s*(?:text|bash|sh|python|javascript|typescript|json|cpp|c\+\+)\s*$(?=\n```)/gm,
];

function stripChrome(text: string): string {
  let out = text;
  for (const re of CHROME) out = out.replace(re, "");
  return out.trim();
}

export class AiModeBackend {
  #ctx?: Ctx;
  #page?: any;
  /** Set on a fork: it borrows the parent's browser and must not close it. */
  #borrowed = false;
  /** Which profile directory is in use; bumped when the limit is hit. */
  #profile: number;
  #rotations = 0;
  /**
   * Enough of the conversation to carry across a rotation. A rotated profile
   * is a new AI Mode thread with no memory of what came before, so without
   * this the agent resumes mid-task with no idea what the task was.
   */
  #history: string[] = [];
  /** Conversation text as of the last answer, for diffing the next one. */
  #seen = "";
  #started = false;

  constructor(private readonly opts: AiModeOptions = {}) {
    this.#profile = opts.profile ?? 0;
  }

  get name(): string {
    return "google-ai-mode";
  }

  /**
   * Chromium refuses to open a profile that still carries a SingletonLock, and
   * a hard kill leaves one behind. The lock is a symlink naming host-pid, so a
   * lock whose process is gone is stale and safe to clear — which beats
   * greeting the user with "profile is already in use" after a crash.
   */
  #clearStaleLock(dir: string): void {
    const lock = path.join(dir, "SingletonLock");
    let target: string;
    try {
      target = fs.readlinkSync(lock);
    } catch {
      return; // no lock, or not a symlink
    }
    const pid = Number(target.split("-").pop());
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // still running — leave it alone
        return;
      } catch {
        /* gone */
      }
    }
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * A second conversation in the same browser.
   *
   * AI Mode keeps its conversation in the page, so a subagent needs a page of
   * its own — but not a browser of its own: a second Chromium would be a
   * second profile, a second login and another 350MB. The fork shares the
   * context and owns only its tab, which is why closing it must not close the
   * parent's browser.
   */
  async fork(): Promise<AiModeBackend> {
    await this.#ensure();
    const child = new AiModeBackend(this.opts);
    child.#ctx = this.#ctx;
    child.#page = await this.#ctx!.newPage();
    child.#borrowed = true;
    return child;
  }

  async #ensure(): Promise<any> {
    if (this.#page) return this.#page;
    return phase("launch browser", () => this.#launch());
  }

  async #launch(): Promise<any> {
    const dir = profileFor(this.#profile);
    fs.mkdirSync(dir, { recursive: true });
    this.#clearStaleLock(dir);
    const ctx = (await launchPersistentContext({
      headless: !this.opts.headed,
      userDataDir: dir,
      viewport: { width: 1280, height: 900 },
    })) as unknown as Ctx & { newPage: () => Promise<any> };
    this.#ctx = ctx;
    const pages = ctx.pages() as unknown as any[];
    this.#page = pages[0] ?? (await ctx.newPage());
    return this.#page;
  }

  /**
   * Everything the conversation column holds, minus the source rail and the
   * feedback chrome. Read from the live DOM because `innerText` needs layout —
   * the noise is hidden and restored rather than cloned away.
   */
  async #conversation(): Promise<string> {
    const page = await this.#ensure();
    return (await page.evaluate(readConversation, CONVERSATION)) as string;
  }

  /**
   * Wait until the answer stops growing.
   *
   * The quiet window is the whole tail latency of a turn — the answer is
   * complete well before the timer expires, and every extra millisecond here
   * is felt on every question. 1200ms of no growth, sampled every 200ms, was
   * the shortest that did not truncate answers in testing.
   *
   * An *empty* conversation is never settled, whatever the quiet period says.
   * Without that clause a page that has not started rendering looks exactly
   * like a page that has finished: `#waitForGrowth` gives up at its 8s cap,
   * settle calls it done 1.2s later, and `#read` throws "AI Mode returned
   * nothing" at about 9s. That is what it did — reproducibly, three runs out
   * of three, on the two benchmark questions whose answers Google renders as
   * math, which are the slowest to appear.
   */
  async #settle(quietMs = 1200): Promise<void> {
    const page = await this.#ensure();
    const deadline = Date.now() + (this.opts.timeoutMs ?? 90_000);
    let last = -1;
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      const all = await this.#conversation();
      const len = all.length;
      if (len !== last) {
        // Only the part that is new this turn, and only when someone asked.
        if (onPartial && len > this.#seen.length) {
          const fresh = all.startsWith(this.#seen) ? all.slice(this.#seen.length) : all;
          onPartial(stripChrome(fresh));
        }
        last = len;
        lastChange = Date.now();
      } else if (len > 0 && Date.now() - lastChange >= quietMs) {
        return;
      }
      await page.waitForTimeout(200);
    }
  }

  /** Wait for the page to start producing, rather than sleeping a fixed time. */
  async #waitForGrowth(from: number, capMs = 8000): Promise<void> {
    const page = await this.#ensure();
    const deadline = Date.now() + capMs;
    while (Date.now() < deadline) {
      if ((await this.#conversation()).length !== from) return;
      await page.waitForTimeout(150);
    }
  }

  /**
   * One exchange. The first call in a session opens a new AI Mode thread; the
   * rest continue it, so the model keeps its own context in the page and this
   * only has to carry the prompt.
   */
  /**
   * Attach files to the composer. They ride on the next message rather than
   * being sent on their own, which is how the page treats them too.
   */
  async #attach(paths: string[]): Promise<void> {
    const page = await this.#ensure();
    await page.locator(ADD_FILES).first().click();
    await page.waitForTimeout(400);
    const input = page.locator(IMAGE_INPUT).first();
    await input.setInputFiles(paths);
    // The thumbnail has to render before the composer will send.
    await page.waitForTimeout(1500);
  }

  async #askOnce(prompt: string, attachments: string[] = []): Promise<string> {
    const page = await this.#ensure();

    // A search URL is not a general input channel: an attachment cannot ride
    // on one, and a long prompt silently fails to produce a conversation at
    // all — which is what the tool preamble did, since it opens every session
    // with roughly a thousand characters. Both cases start from the empty AI
    // Mode composer instead, which costs the same single query.
    if (!this.#started && (attachments.length > 0 || prompt.length > URL_MAX)) {
      await phase("open composer", async () => {
        await page.goto(`${LANDING}&hl=${this.opts.hl ?? "ja"}`, {
          waitUntil: "domcontentloaded",
          timeout: this.opts.timeoutMs ?? 90_000,
        });
        // Wait for the composer, not for a number. This was a flat 2500ms
        // sleep, and it is on the path every session takes once tools are
        // attached — the preamble is longer than a URL can carry, so every
        // first question goes through here. Measured at 3260ms for the
        // navigation and the sleep together; the composer is usually there
        // well before the sleep ended.
        await page
          .locator(COMPOSER)
          .last()
          .waitFor({ state: "visible", timeout: 8000 })
          .catch(() => {});
      });
      this.#started = true;
      await this.#attach(attachments);
      return this.#send(prompt);
    }

    if (attachments.length > 0) await this.#attach(attachments);

    if (!this.#started) {
      await phase("navigate", () =>
        page.goto(
          "https://www.google.com/search?q=" +
            encodeURIComponent(prompt) +
            `&udm=50&aep=1&source=hp&hl=${this.opts.hl ?? "ja"}`,
          { waitUntil: "domcontentloaded", timeout: this.opts.timeoutMs ?? 90_000 },
        ),
      );
      this.#started = true;
      await phase("settle", () => this.#settle());
      return phase("read", () => this.#read());
    }

    return this.#send(prompt);
  }

  /** Type into the composer, send, and read the answer back. */
  async #send(prompt: string): Promise<string> {
    const page = await this.#ensure();
    const text = prompt.slice(0, COMPOSER_MAX);
    const box = page.locator(COMPOSER).last();
    if (timing()) {
      process.stderr.write(`  [timing] prompt ${text.length} chars\n`);
    }

    // fill() sets the value without the input event Google's send handler
    // listens for, and type() sends one keystroke at a time — which times out
    // on anything longer than a sentence. insertText fires a single real
    // input event with the whole string.
    await phase("type", async () => {
      await box.click();
      await page.keyboard.insertText(text);
    });

    // The click does not always land the focus, and text inserted into
    // nothing leaves the send button disabled — which then times out looking
    // "not stable" rather than saying the composer is empty. Check, and fall
    // back to filling the field and announcing it ourselves.
    if ((await box.inputValue()).length === 0) {
      await box.fill(text);
      await box.dispatchEvent("input");
    }

    const before = this.#seen.length;
    await phase("send", async () => {
      const send = page.locator(SEND).first();
      try {
        // A button that is going to be clickable is clickable quickly. This
        // waited five seconds before giving up, and measured turns spent all
        // five of them: the click failed, Enter worked, and the turn had paid
        // 5.1s for the attempt. Enter is not the fallback because it is worse,
        // it is the fallback because the button is the more specific target.
        await send.click({ timeout: 1200 });
      } catch {
        // Enter submits too, and works even when the button is mid-transition.
        await box.press("Enter");
      }
    });
    await phase("first token", () => this.#waitForGrowth(before));
    await phase("settle", () => this.#settle());
    return phase("read", () => this.#read());
  }

  /** The part of the conversation that was not there before this turn. */
  async #read(): Promise<string> {

    // Each turn appends its own conversation container, so the answer is the
    // tail that was not there before.
    const all = await this.#conversation();
    const fresh = all.startsWith(this.#seen)
      ? all.slice(this.#seen.length).trim()
      : all;
    this.#seen = all;

    if (!fresh) throw new EmptyAnswerError();
    if (BLOCKED.test(fresh)) throw new AiModeRateLimitError();
    return stripChrome(fresh);
  }

  /**
   * Ask, and keep asking across the rate limit.
   *
   * Hitting the limit used to end the run: the handoff saved the conversation
   * and the user restarted. That is the right behaviour for a person sitting
   * there, and useless for a hundred-turn run. Since the limit follows the
   * cookie rather than the address, a rotation to a fresh profile resumes
   * immediately — measured, while the blocked profile was still refused.
   *
   * The new profile is a new AI Mode thread with no memory, so a recap of the
   * conversation so far is prepended to the retried prompt. Rotations are
   * bounded; past that it waits, because a limit that survives a fresh cookie
   * is not one more cookie away from clearing.
   */
  async ask(prompt: string, attachments: string[] = []): Promise<string> {
    const maxRotations =
      this.opts.maxRotations ?? Number(process.env.GAHOOLE_MAX_ROTATIONS ?? 6);
    const waitMs = Number(process.env.GAHOOLE_RATE_WAIT_MS ?? 120_000);

    for (let attempt = 0; ; attempt++) {
      try {
        const answer = await this.#askOnce(
          attempt === 0 ? prompt : `${this.#recap()}${prompt}`,
          attachments,
        );
        this.#remember(prompt, answer);
        this.#retriedEmpty = false;
        return answer;
      } catch (e) {
        // A dead browser is not a refused answer. Relaunching costs one query
        // and gets the turn back; without it a crashed renderer ended the
        // session and the conversation went to the handoff for no reason.
        // Once only — a crash that repeats is a crash worth seeing.
        // An empty page is worth asking again for, once. The retry starts a
        // fresh navigation rather than continuing the thread, because whatever
        // state left the container empty is in the page.
        if (e instanceof EmptyAnswerError && !this.#retriedEmpty) {
          this.#retriedEmpty = true;
          onEmpty?.();
          this.#started = false;
          this.#seen = "";
          continue;
        }

        if (looksLikeCrash(e) && !this.#relaunched) {
          this.#relaunched = true;
          onRelaunch?.(e instanceof Error ? e.message : String(e));
          await this.close().catch(() => {});
          this.#started = false;
          this.#seen = "";
          continue;
        }

        if (!(e instanceof AiModeRateLimitError)) throw e;
        if (this.#rotations >= maxRotations) throw e;

        this.#rotations++;
        const rotating = this.#rotations <= maxRotations;
        onRateLimit?.(this.#rotations, rotating);

        await this.close();
        this.#profile++;
        this.#started = false;
        this.#seen = "";

        // Later rotations wait as well: if several fresh cookies in a row are
        // refused, the limit is not cookie-shaped and spinning through
        // profiles only makes more of them.
        if (this.#rotations > 2) await sleep(waitMs);
      }
    }
  }

  /** One relaunch per session; see the catch in `ask`. */
  #relaunched = false;
  /** One retry per turn for an empty page; reset once a turn succeeds. */
  #retriedEmpty = false;

  /** The last few exchanges, compact enough to prepend to a prompt. */
  #recap(): string {
    if (this.#history.length === 0) return "";
    return `Context from an interrupted session — continue from here:\n${this.#history.join("\n")}\n\n`;
  }

  #remember(prompt: string, answer: string): void {
    const line = `- asked: ${prompt.slice(0, 160)} → ${answer.slice(0, 200)}`;
    this.#history.push(line);
    if (this.#history.length > 6) this.#history.shift();
  }

  /** Start a fresh AI Mode thread — used when a gahoole session changes. */
  reset(): void {
    this.#started = false;
    this.#seen = "";
    this.#history = [];
    // A new conversation gets its own relaunch, since the last one is over.
    this.#relaunched = false;
  }

  async close(): Promise<void> {
    const ctx = this.#ctx;
    const page = this.#page;
    this.#ctx = undefined;
    this.#page = undefined;
    if (this.#borrowed) {
      // Only the tab is ours.
      await page?.close().catch(() => {});
      return;
    }
    if (ctx) await ctx.close().catch(() => {});
  }
}
