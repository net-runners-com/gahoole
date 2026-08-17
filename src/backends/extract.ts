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
      // No container, no conversation.
      //
      // This used to fall back to reading the whole body, on the theory that
      // something was better than nothing. What it read was the page: the
      // skip-to-content link, the composer holding the question that had just
      // been typed into it, and the chrome around both — which is where "the
      // whole preamble printed above the answer" came from, intermittently,
      // whenever a poll landed before the answer container existed. An empty
      // read is handled properly a layer up: settle keeps waiting, and a read
      // that never fills is retried once.
      const parts: string[] = [];
      for (const root of roots) {
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

        // Code blocks, put where they belong rather than at the end.
        //
        // `innerText` does not reliably include a rendered <pre>, so the code
        // used to be appended after everything else. That loses its position,
        // and position is what says which tool call a block belongs to: a
        // reply that wrote a file and then ran it had the file's contents
        // attached to the run instead, and the file was written with nothing
        // in it. So each <pre> is replaced in the flow by a plain element
        // holding the same text fenced, and put back afterwards.
        const swapped: { pre: any; stand: any; display: string }[] = [];
        root.querySelectorAll("pre").forEach((el: any) => {
          const code = (el.textContent ?? "").trim();
          if (!code) return;
          const stand = d.createElement("div");
          // innerText follows layout, and layout collapses newlines in an
          // ordinary block — the fence came out as one line and stopped
          // looking like a fence at all.
          stand.style.whiteSpace = "pre";
          stand.textContent = "```\n" + code + "\n```";
          el.parentNode?.insertBefore(stand, el);
          swapped.push({ pre: el, stand, display: el.style.display });
          el.style.display = "none";
        });

        let t = (root.innerText || "").replace(/\n{3,}/g, "\n\n").trim();

        for (const sw of swapped) {
          sw.stand.parentNode?.removeChild(sw.stand);
          sw.pre.style.display = sw.display;
        }

        for (const m of marked) {
          if (m.text) m.el.nodeValue = m.text;
          else m.el.parentNode?.removeChild(m.el);
        }

        noise.forEach((n: any, i: number) => {
          n.style.display = prev[i] ?? "";
        });

        if (t) parts.push(t);
      }
      return parts.join("\n\n");
}
