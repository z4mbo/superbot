(() => {
  const root = document.documentElement;
  const read = () => { try { return localStorage.getItem("superbot-theme"); } catch { return null; } };
  const write = (value) => { try { localStorage.setItem("superbot-theme", value); } catch {} };
  const saved = read();
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;

  const effective = () => root.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const label = (button) => {
    const next = effective() === "dark" ? "light" : "dark";
    button.setAttribute("aria-label", `Use ${next} theme`);
    button.title = `Use ${next} theme`;
  };

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      label(button);
      button.addEventListener("click", () => {
        const next = effective() === "dark" ? "light" : "dark";
        root.dataset.theme = next;
        write(next);
        label(button);
      });
    });

    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        const source = button.closest(".code")?.querySelector("pre");
        if (!source) return;
        try {
          await navigator.clipboard.writeText(source.innerText);
          button.textContent = "Copied";
        } catch {
          button.textContent = "Couldn't copy";
        }
        setTimeout(() => { button.textContent = "Copy"; }, 1600);
      });
    });

    const toggle = document.querySelector(".docs-nav-toggle");
    const links = document.getElementById("docs-nav-links");
    if (toggle && links) {
      const sync = () => {
        const narrow = matchMedia("(max-width: 900px)").matches;
        if (!narrow) { links.hidden = false; toggle.setAttribute("aria-expanded", "true"); }
        else if (toggle.getAttribute("aria-expanded") !== "true") links.hidden = true;
      };
      toggle.addEventListener("click", () => {
        const open = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!open));
        links.hidden = open;
      });
      toggle.setAttribute("aria-expanded", "false");
      sync();
      matchMedia("(max-width: 900px)").addEventListener("change", () => { toggle.setAttribute("aria-expanded", "false"); sync(); });
    }
  });
})();
