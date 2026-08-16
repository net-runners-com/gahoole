import fs from "node:fs";
import path from "node:path";
import { launchPersistentContext } from "cloakbrowser";

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

const PROFILE_DIR = path.resolve(
  process.env.GAHOOLE_BROWSER_PROFILE ?? "data/browser-profile",
);

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
}

export interface AiModeOptions {
  headed?: boolean;
  /** Locale for the AI Mode UI; only affects the page, not the answer. */
  hl?: string;
  timeoutMs?: number;
}

/**
 * The page appends its own furniture to every answer — the "AI can be wrong"
 * disclaimer and the feedback prompt. Trim it so the caller gets the answer.
 */
const CHROME = [
  /AI は不正確な情報を表示することがある[\s\S]*$/,
  /AI responses may include mistakes[\s\S]*$/i,
  /^\s*すべて表示\s*$/gm,
];

function stripChrome(text: string): string {
  let out = text;
  for (const re of CHROME) out = out.replace(re, "");
  return out.trim();
}

export class AiModeBackend {
  #ctx?: Ctx;
  #page?: any;
  /** Conversation text as of the last answer, for diffing the next one. */
  #seen = "";
  #started = false;

  constructor(private readonly opts: AiModeOptions = {}) {}

  get name(): string {
    return "google-ai-mode";
  }

  /**
   * Chromium refuses to open a profile that still carries a SingletonLock, and
   * a hard kill leaves one behind. The lock is a symlink naming host-pid, so a
   * lock whose process is gone is stale and safe to clear — which beats
   * greeting the user with "profile is already in use" after a crash.
   */
  #clearStaleLock(): void {
    const lock = path.join(PROFILE_DIR, "SingletonLock");
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
        fs.unlinkSync(path.join(PROFILE_DIR, f));
      } catch {
        /* already gone */
      }
    }
  }

  async #ensure(): Promise<any> {
    if (this.#page) return this.#page;
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    this.#clearStaleLock();
    const ctx = (await launchPersistentContext({
      headless: !this.opts.headed,
      userDataDir: PROFILE_DIR,
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
    // This callback is serialized and run in the page, so it is browser code
    // in a Node project — hence the local `any` rather than pulling the whole
    // DOM lib into tsconfig.
    return (await page.evaluate((sel: string) => {
      const d = (globalThis as unknown as { document: any }).document;
      const roots = d.querySelectorAll(sel);
      const parts: string[] = [];
      for (const root of roots.length ? roots : [d.body]) {
        const noise = root.querySelectorAll(
          ".HvurC,[role=dialog],[role=navigation],a[href],textarea,button",
        );
        const prev: string[] = [];
        noise.forEach((n: any) => {
          prev.push(n.style.display);
          n.style.display = "none";
        });
        const t = (root.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
        noise.forEach((n: any, i: number) => {
          n.style.display = prev[i] ?? "";
        });
        if (t) parts.push(t);
      }
      return parts.join("\n\n");
    }, CONVERSATION)) as string;
  }

  /**
   * Wait until the answer stops growing.
   *
   * The quiet window is the whole tail latency of a turn — the answer is
   * complete well before the timer expires, and every extra millisecond here
   * is felt on every question. 1200ms of no growth, sampled every 200ms, was
   * the shortest that did not truncate answers in testing.
   */
  async #settle(quietMs = 1200): Promise<void> {
    const page = await this.#ensure();
    const deadline = Date.now() + (this.opts.timeoutMs ?? 90_000);
    let last = -1;
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      const len = (await this.#conversation()).length;
      if (len !== last) {
        last = len;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= quietMs) {
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

  async ask(prompt: string, attachments: string[] = []): Promise<string> {
    const page = await this.#ensure();

    // A search URL is not a general input channel: an attachment cannot ride
    // on one, and a long prompt silently fails to produce a conversation at
    // all — which is what the tool preamble did, since it opens every session
    // with roughly a thousand characters. Both cases start from the empty AI
    // Mode composer instead, which costs the same single query.
    if (!this.#started && (attachments.length > 0 || prompt.length > URL_MAX)) {
      await page.goto(`${LANDING}&hl=${this.opts.hl ?? "ja"}`, {
        waitUntil: "domcontentloaded",
        timeout: this.opts.timeoutMs ?? 90_000,
      });
      await page.waitForTimeout(2500);
      this.#started = true;
      await this.#attach(attachments);
      return this.#send(prompt);
    }

    if (attachments.length > 0) await this.#attach(attachments);

    if (!this.#started) {
      await page.goto(
        "https://www.google.com/search?q=" +
          encodeURIComponent(prompt) +
          `&udm=50&aep=1&source=hp&hl=${this.opts.hl ?? "ja"}`,
        { waitUntil: "domcontentloaded", timeout: this.opts.timeoutMs ?? 90_000 },
      );
      this.#started = true;
      await this.#settle();
      return this.#read();
    }

    return this.#send(prompt);
  }

  /** Type into the composer, send, and read the answer back. */
  async #send(prompt: string): Promise<string> {
    const page = await this.#ensure();
    const text = prompt.slice(0, COMPOSER_MAX);
    const box = page.locator(COMPOSER).last();

    // fill() sets the value without the input event Google's send handler
    // listens for, and type() sends one keystroke at a time — which times out
    // on anything longer than a sentence. insertText fires a single real
    // input event with the whole string.
    await box.click();
    await page.keyboard.insertText(text);

    // The click does not always land the focus, and text inserted into
    // nothing leaves the send button disabled — which then times out looking
    // "not stable" rather than saying the composer is empty. Check, and fall
    // back to filling the field and announcing it ourselves.
    if ((await box.inputValue()).length === 0) {
      await box.fill(text);
      await box.dispatchEvent("input");
    }

    const before = this.#seen.length;
    const send = page.locator(SEND).first();
    try {
      await send.click({ timeout: 5000 });
    } catch {
      // Enter submits too, and works even when the button is mid-transition.
      await box.press("Enter");
    }
    await this.#waitForGrowth(before);
    await this.#settle();
    return this.#read();
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

    if (!fresh) throw new Error("AI Mode returned nothing");
    if (BLOCKED.test(fresh)) throw new AiModeRateLimitError();
    return stripChrome(fresh);
  }

  /** Start a fresh AI Mode thread — used when a gahoole session changes. */
  reset(): void {
    this.#started = false;
    this.#seen = "";
  }

  async close(): Promise<void> {
    const ctx = this.#ctx;
    this.#ctx = undefined;
    this.#page = undefined;
    if (ctx) await ctx.close().catch(() => {});
  }
}
