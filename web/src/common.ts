import "./styles/base.css";

export const fmt = new Intl.NumberFormat("en-US");

export function hourLabel(h: number): string {
  if (h === 0) return "midnight";
  if (h === 12) return "noon";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

export const DAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Current wall-clock time in a city, as Monday-first day index, hour and month. */
export function cityNow(timeZone: string): { day: number; hour: number; minute: number; month: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", minute: "numeric", month: "numeric", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday);
  return { day: Math.max(0, day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), month: Number(parts.month) };
}

/** Reveals .rise elements once as they enter. Content is visible by default if this never runs. */
export function revealOnScroll(root: ParentNode = document) {
  const items = [...root.querySelectorAll<HTMLElement>(".rise:not(.is-in)")];
  if (!("IntersectionObserver" in window)) {
    items.forEach((el) => el.classList.add("is-in"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        const siblings = [...(el.parentElement?.querySelectorAll(":scope > .rise") ?? [])];
        el.style.transitionDelay = `${Math.max(0, siblings.indexOf(el)) * 80}ms`;
        el.classList.add("is-in");
        io.unobserve(el);
      }
    },
    { rootMargin: "0px 0px -12% 0px" },
  );
  items.forEach((el) => io.observe(el));
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} loading ${url}`);
  return (await res.json()) as T;
}

/** API base: same-origin /api behind CloudFront, proxied to the local API in development. */
export const API = "/api";

export async function api<T>(path: string, init?: RequestInit & { key?: string }): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init?.key) headers["x-api-key"] = init.key;
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((body as { error?: string; message?: string }).error ?? (body as { message?: string }).message ?? `Request failed (${res.status})`), { status: res.status, body });
  return body as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string | null | undefined)[]) {
  const node = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) node.className = cls;
  Object.assign(node, rest);
  for (const c of children) if (c != null) node.append(c);
  return node;
}
