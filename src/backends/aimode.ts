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

  async #ensure(): Promise<any> {
    if (this.#page) return this.#page;
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
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

  /** Wait until the answer stops growing, or give up. */
  async #settle(quietMs = 2500): Promise<void> {
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
      await page.waitForTimeout(400);
    }
  }

  /**
   * One exchange. The first call in a session opens a new AI Mode thread; the
   * rest continue it, so the model keeps its own context in the page and this
   * only has to carry the prompt.
   */
  async ask(prompt: string): Promise<string> {
    const page = await this.#ensure();

    if (!this.#started) {
      await page.goto(
        "https://www.google.com/search?q=" +
          encodeURIComponent(prompt) +
          `&udm=50&aep=1&source=hp&hl=${this.opts.hl ?? "ja"}`,
        { waitUntil: "domcontentloaded", timeout: this.opts.timeoutMs ?? 90_000 },
      );
      this.#started = true;
    } else {
      // fill() sets the value without the input event Google's send handler
      // listens for, and type() sends one keystroke at a time — which times
      // out on anything longer than a sentence. insertText fires a single
      // real input event with the whole string.
      const box = page.locator(COMPOSER).last();
      await box.click();
      const text = prompt.slice(0, COMPOSER_MAX);
      await page.keyboard.insertText(text);
      await page.waitForTimeout(300);
      const send = page.locator(SEND).first();
      if (await send.count()) await send.click();
      else await box.press("Enter");
      await page.waitForTimeout(1500);
    }

    await this.#settle();

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
