/**
 * Reading the answer out of the page.
 *
 * This is browser code living in a Node project: it is serialized by
 * Playwright and run inside the page, so it may not close over anything in
 * this module and it may not use the DOM types the rest of the project does
 * not load — hence the `any`.
 *
 * It lives in its own file so it can be run against a fixture instead of
 * against Google. Two bugs shipped from here before that was possible: a
 * rendered `<pre>` that `innerText` does not reliably include, and list
 * numbers that belong to the `<ol>` rather than to the `<li>` and so vanish
 * when the text is read back. `npm run smoke:dom` loads a page shaped like
 * both and checks what comes out.
 */
export function readConversation(sel: string): string {

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

        // List markers live in the rendering, not in the text. A numbered list
        // comes back as three bare sentences, because the "1." is drawn by the
        // <ol> rather than written in the <li> — which is why an autonomous
        // run's plan never parsed: the model wrote the list every time and the
        // numbers were gone before anything could read them. Put them back,
        // then take them out again so the page is left as it was found.
        const marked: { el: any; text: string }[] = [];
        root.querySelectorAll("li").forEach((el: any) => {
          const ordered = el.parentElement?.tagName === "OL";
          const siblings: any[] = Array.prototype.slice.call(
            el.parentElement?.children ?? [],
          );
          const at = siblings.indexOf(el) + 1;
          const mark = ordered ? `${at}. ` : "- ";
          const first = el.firstChild;
          if (first?.nodeType === 3) {
            marked.push({ el: first, text: first.nodeValue ?? "" });
            first.nodeValue = mark + (first.nodeValue ?? "");
          } else {
            const node = d.createTextNode(mark);
            el.insertBefore(node, first ?? null);
            marked.push({ el: node, text: "" });
          }
        });

        let t = (root.innerText || "").replace(/\n{3,}/g, "\n\n").trim();

        for (const m of marked) {
          if (m.text) m.el.nodeValue = m.text;
          else m.el.parentNode?.removeChild(m.el);
        }

        // Code blocks are read from the DOM rather than from innerText.
        // innerText follows layout, and in AI Mode a rendered <pre> does not
        // reliably appear in it — the first C++ file this wrote came out as
        // "#include " with the header missing. textContent always has it, so
        // the blocks are appended fenced, which is also the shape the tool
        // protocol looks for.
        const blocks: string[] = [];
        root.querySelectorAll("pre").forEach((el: any) => {
          const code = (el.textContent ?? "").trim();
          if (code && !blocks.includes(code)) blocks.push(code);
        });
        for (const b of blocks) {
          if (!t.includes(b)) t += "\n\n```\n" + b + "\n```";
          else t = t.replace(b, "```\n" + b + "\n```");
        }
        noise.forEach((n: any, i: number) => {
          n.style.display = prev[i] ?? "";
        });

        if (t) parts.push(t);
      }
      return parts.join("\n\n");
}
