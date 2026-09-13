# Design Handoff — Finanzierung (مدیریت حقوق ماهانه)

> **For:** the product designer  ·  **From:** engineering  ·  **App:** Persian (RTL) monthly-salary / envelope-budgeting PWA on Cloudflare Workers.
>
> This document is the **source of truth** for what to design. It lists every screen, state, component, and design token that already exists in code, plus the gaps that need design work for a production launch. All UI copy is given in **Persian** exactly as it should appear. A visual, shareable version of this handoff is also published as an Artifact (ask engineering for the link).
>
> ملاحظه: زبان رابط فارسی و راست‌به‌چپ است. اگر نسخه‌ی فارسی این سند را لازم دارید بگویید تا تهیه شود.

---

## 1. Product in one paragraph

The user receives a monthly salary and splits it into **pockets** (envelopes). Each pocket is one budget category. For every pocket the app shows three numbers: **money in this month**, **money out this month**, and **current balance** (all-time in − out). A "distribute salary" action splits a lump sum across pockets by percentage. The product is **multi-user** now: people sign up with email + password and only ever see their own data.

**Design north star:** a calm, glance-able money dashboard that a non-financial person opens on their phone, understands in 3 seconds, and updates in 2 taps.

---

## 2. Users & context

| | |
|---|---|
| **Primary device** | Mobile phone, portrait, installed as a PWA (home-screen icon, standalone, no browser chrome). Design mobile-first. |
| **Secondary** | Desktop / tablet web. |
| **Language / direction** | Persian, **RTL**. Numbers shown with Persian digits (۱۲۳). |
| **Literacy** | Not finance-savvy. Avoid jargon; the emoji + plain labels are intentional. |
| **Frequency** | 1× / month heavy use (salary day), plus quick expense logging a few times a week. |

Default pockets & suggested percentages (seeded on signup, all editable):

| Pocket | Emoji | Suggested % |
|---|---|---|
| اجاره و هزینه‌های ثابت | 🏠 | 35–45٪ |
| غذا و خرید روزمره | 🛒 | 10–15٪ |
| حمل‌ونقل | 🚆 | 5–10٪ |
| قبض و اشتراک‌ها | 📱 | 5٪ |
| تفریح و خرید شخصی | 🎉 | 10٪ |
| پس‌انداز اضطراری | 💰 | 10–15٪ |
| سرمایه‌گذاری / پس‌انداز هدفمند | 📈 | 5–10٪ |

---

## 3. Information architecture

```
Auth (logged-out)
 ├─ Login
 └─ Register            ← same card, toggled

App (logged-in)
 └─ Dashboard (single screen)
     ├─ Header: title · month picker · currency · logout
     ├─ Summary: total balance · income (month) · expense (month)
     ├─ Actions: Distribute salary · Add transaction · New pocket
     ├─ Pockets grid (the heart of the app)
     └─ Recent transactions
   Modals: Transaction · Distribute salary · Pocket (create/edit)
```

The app is intentionally **one screen + modals**. Do not propose deep navigation unless it earns its place; the value is everything-at-a-glance.

---

## 4. Core flows to design

1. **First run / onboarding** — brand new user → Register → lands on dashboard already populated with 7 pockets at zero. *Design opportunity:* a light empty-state / welcome moment that teaches "distribute your salary first."
2. **Salary day** — tap **تقسیم حقوق** → enter amount → adjust percentages (they must sum sensibly) → confirm → pockets fill with income. *Key screen to make delightful.*
3. **Daily expense** — from a pocket card tap **➖ خروجی** (or the global Add) → amount + optional note + date → save → balances update.
4. **Review** — change month in header, scan pocket balances, spot an over-spent pocket (negative balance).
5. **Manage pockets** — edit emoji/name/percent, add a custom pocket, delete one.
6. **Account** — login, logout, (to-be-designed) password reset & errors.

---

## 5. Screen & state inventory

Design **every state**, not just the happy path.

### 5.1 Auth card (login / register)
- Centered card on a soft gradient background; brand mark (💶) in a rounded gradient tile, title, subtitle.
- Fields: **ایمیل**, **رمز عبور** (min 8). Primary full-width button. Toggle link between login/register.
- States: default · focus · **inline error** (e.g. «ایمیل یا رمز عبور نادرست است»، «این ایمیل قبلاً ثبت شده است»، «رمز عبور باید حداقل ۸ کاراکتر باشد») · submitting («لطفاً صبر کنید…», button disabled).
- **Needs design (production):** forgot-password link + reset flow, show/hide password toggle, password-strength hint, "remember me" (optional).

### 5.2 Header
- App title, month picker (`type=month`), currency select (€ / $ / ₺ / ﷼ / تومان), logout icon (⏻).
- Sticky, gradient (primary). On mobile it may wrap — design the compact arrangement.

### 5.3 Summary row (3 stat cards)
- **موجودی کل** (total balance, primary color) · **ورودی این ماه** (income green) · **خروجی این ماه** (expense red).
- Mobile: stack to full-width rows with label-start / value-end.

### 5.4 Pocket card — the hero component
Contains: emoji tile · name · «درصد پیشنهادی: ۳۵٪–۴۵٪» · **balance** (large; turns red when negative) · two stat chips (in green / out red) · two buttons **➕ ورودی** / **➖ خروجی** · edit (✏️) affordance.
- States: positive balance · **negative balance** (over budget — needs a clear but non-alarming visual) · zero/new · long name (truncate) · custom emoji.
- **Needs design:** an optional **progress indicator** vs. the pocket's target for the month (e.g., spent 60% of planned) — currently not shown; would add a lot of value. Propose a bar or ring.

### 5.5 Recent transactions list
- Row: pocket emoji · «نام پاکت · توضیح» · date (Persian) · signed amount (+ green / − red) · delete (🗑️).
- States: list · **empty** («تراکنشی برای این ماه ثبت نشده است.») · long list (scroll).

### 5.6 Modals (dialogs)
- **Transaction:** segmented ➖خروجی / ➕ورودی, pocket select, amount, note, date. Title changes by type.
- **Distribute salary:** amount, date, per-pocket percentage rows, **live total %** readout, "reset to defaults" link. *Make the sum-to-100 feedback obvious.*
- **Pocket:** emoji + name row, min/max percent, delete (edit mode only) with confirm.
- States for all: default · validation error (toast «مبلغ نامعتبر است» etc.) · submitting.

### 5.7 System feedback
- **Toast** (bottom center pill): success («ثبت شد ✅», «حقوق تقسیم شد 💸», «ذخیره شد ✅», «حذف شد») and errors.
- **Offline badge** («آفلاین») in footer when the device is offline.
- **Needs design:** loading skeletons for the dashboard first paint; a global error state if the API is unreachable.

---

## 6. Design tokens (current implementation)

These are the **live values** in `public/styles.css` (CSS custom properties). Use them as the baseline palette; refine as needed but keep the semantic roles.

### Color — Light
| Token | Hex | Role |
|---|---|---|
| `--bg` | `#f1f5f9` | page background |
| `--surface` | `#ffffff` | cards, dialogs |
| `--surface-2` | `#f8fafc` | insets, inputs, emoji tiles |
| `--border` | `#e2e8f0` | hairlines |
| `--text` | `#0f172a` | primary text |
| `--muted` | `#64748b` | secondary text |
| `--primary` | `#0f766e` | brand / balance / primary actions (teal) |
| `--primary-strong` | `#0d5f58` | primary hover / gradient end |
| `--income` | `#059669` | money in |
| `--expense` | `#dc2626` | money out / negative / danger |
| `--income-bg` | `#ecfdf5` | income chip background |
| `--expense-bg` | `#fef2f2` | expense chip background |

### Color — Dark
| Token | Hex |
|---|---|
| `--bg` | `#0b1120` |
| `--surface` | `#111827` |
| `--surface-2` | `#0f1626` |
| `--border` | `#1f2a3c` |
| `--text` | `#e5e7eb` |
| `--muted` | `#94a3b8` |
| `--primary` | `#2dd4bf` |
| `--primary-strong` | `#14b8a6` |
| `--income` | `#34d399` |
| `--expense` | `#f87171` |
| `--income-bg` | `#052e26` |
| `--expense-bg` | `#3b0d0d` |

> **Both themes are required.** The app follows the OS `prefers-color-scheme`. Deliver light + dark for every screen. Verify contrast (WCAG AA: ≥ 4.5:1 body text, ≥ 3:1 large text/UI). The teal-on-white and green/red pairs currently pass for text sizes used; re-check any new combinations.

### Typography
- **Font:** `Vazirmatn` (Persian, variable) with system fallback `Segoe UI, Tahoma, system-ui, -apple-system, sans-serif`. Please design in Vazirmatn — it is not yet bundled; a production task is to self-host it (see §11).
- **Base:** 16px / line-height ~1.6.
- **Scale in use:** balance & big numbers 1.3–1.5rem/800; card/section titles 1.05–1.3rem/700–800; body 1rem; secondary .82–.9rem; meta/caption .72–.78rem.
- Numbers are rendered with `Intl.NumberFormat('fa-IR')` → Persian digits and currency. Keep tabular alignment for amounts where possible.

### Spacing, radius, elevation
- **Spacing rhythm:** 4 / 8 / 12 / 14 / 16 / 18 / 26px (loose 8-pt-ish grid).
- **Radius:** cards `16px`, small controls/inputs `10px`, emoji tiles `12px`, auth card `22px`, pills/toasts `999px`.
- **Shadow (light):** `0 1px 3px rgba(15,23,42,.08), 0 1px 2px rgba(15,23,42,.04)`; dialogs `0 20px 60px rgba(0,0,0,.3)`.
- **Container:** max-width `960px`, side gutter `16px` (never less).

---

## 7. Components to specify (for the design system)

Deliver each with **default / hover / focus / active / disabled** where relevant, in light + dark:

1. Buttons — primary, default, ghost, danger, block, icon-only (⏻), small (in-card).
2. Inputs — text, email, password, number, date, month, select. Focus ring = `2px solid --primary`.
3. Segmented control (income/expense).
4. Stat card (summary) · Pocket card · Transaction row · Chip (in/out).
5. Dialog / modal shell + backdrop (blur).
6. Toast.
7. Badge (offline).
8. Progress indicator (new — see §5.4).
9. Empty states + skeleton loaders (new).
10. App icon / brand mark set (see §10).

---

## 8. Accessibility (must-haves)

- Meet **WCAG 2.1 AA** contrast in both themes.
- Full **RTL** mirroring; use logical properties mentally (start/end, not left/right).
- Every interactive target ≥ **44×44px** touch area (some current in-card buttons are borderline — flag/fix in design).
- Visible focus states on all controls (keyboard users).
- Don't rely on color alone: income/expense also use +/− signs and labels — preserve that.
- Respect `prefers-reduced-motion` for any animation you introduce.
- Form fields need visible labels (already present) and error text tied to the field.

---

## 9. Responsive

| Breakpoint | Behavior |
|---|---|
| ≤ 560px (phone) | summary stacks to 1 column; action buttons stretch full-width; header may wrap; pockets grid = 1 column. |
| 561–959px | pockets grid auto-fills `minmax(260px, 1fr)`; summary 3-up. |
| ≥ 960px | content capped at 960px, centered. |

Design at least **375px** and **1280px** frames for every screen; annotate the reflow.

---

## 10. Brand & iconography

- Current mark: a wallet/coins glyph in a teal gradient rounded-square (`public/icons/icon.svg`, `icon-maskable.svg`) + 💶 emoji as the wordmark accent.
- **Needs design:** a proper logo/app-icon set — maskable (safe-zone 80%), 192 & 512 PNG, favicon, plus an installed-PWA splash. Keep the teal identity or propose an alternative with rationale.
- Emoji are used as category icons by design (fast, universal, RTL-safe). If you prefer a custom icon set, provide one per default pocket **and** a picker for custom pockets.

---

## 11. Production "next steps" the design should account for

These are planned; leave room / propose UX:

- **Auth hardening:** forgot-password + reset email, email verification, login rate-limit lockout message, session-expired re-login prompt.
- **Font:** self-host Vazirmatn (woff2) for offline + consistency.
- **Onboarding:** first-run guidance ("distribute your first salary").
- **Data:** export/import (CSV), monthly rollover / carry-over rules, editing a transaction (currently delete + re-add).
- **Insights:** simple charts (spend by pocket, month-over-month) — see the `dataviz` guidance before designing charts.
- **Settings screen:** currency default, theme override (light/dark/system), account management, delete account.

---

## 12. Deliverables requested from the designer

- [ ] Figma file, RTL, organized by: **Foundations** (color, type, spacing, effects as Figma variables/styles) → **Components** (§7) → **Screens** (§5, light + dark, 375 & 1280) → **Flows** (§4 as prototypes).
- [ ] All states per §5 (default/empty/error/loading/negative).
- [ ] Redlines/specs or use Figma Dev Mode (spacing, sizes, tokens named to match §6).
- [ ] Logo/app-icon package (§10).
- [ ] Any new patterns (progress, charts, onboarding) with rationale.
- [ ] Contrast check notes for AA.

**Token naming:** please keep the semantic names in §6 (`--primary`, `--income`, `--expense`, `--surface`, …) so design maps 1:1 to code.

---

## 13. Open questions for product/eng before/while designing

1. Should a pocket show **month progress vs. target** (bar/ring)? Recommended — pick a form.
2. Negative-balance treatment: subtle red text (current) or a stronger "over budget" banner on the card?
3. Is **editing** a transaction needed for v1, or is delete + re-add acceptable?
4. Currency: single default per account, or per-pocket? (Currently a global display setting, client-side.)
5. Do we need a dedicated **Settings** screen for v1, or keep controls in the header?
6. Onboarding depth: single tooltip vs. a short first-run sequence?

---

*Reference: the working app is the fastest spec — run it locally (`npm install && npm run dev`) to see live interaction, RTL, and both themes.*
