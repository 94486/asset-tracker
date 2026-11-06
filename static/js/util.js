// ===== 通用工具：选择器 / 格式化 / 日期 / 请求 =====
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const icon = (n, cls = "") => `<svg class="ic ${cls}" aria-hidden="true"><use href="#ic-${n}"/></svg>`;

// ---------------- 格式化 ----------------
function fmt(n, { decimals } = {}) {
  if (n === null || n === undefined || n === "" || Number.isNaN(Number(n))) return "—";
  const num = Number(n);
  const d = decimals ?? (!Number.isInteger(num) ? 2 : 0);
  return "¥" + num.toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtNum(n) {
  if (n === null || n === undefined || n === "") return "—";
  return Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}
function fmtPnl(v) {
  const n = Number(v) || 0;
  if (n > 0) return `+${fmt(n)}`;
  if (n < 0) return `−${fmt(Math.abs(n))}`;
  return fmt(0);
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysBetween(a, b) {
  const d1 = new Date(a + "T00:00:00"), d2 = new Date(b + "T00:00:00");
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return 1;
  return Math.max(1, Math.round((d2 - d1) / 86400000));
}
function esc(s) {
  return String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
}
// 仍在持有：使用中 + 待售。待售只是挂了牌子，钱还压着，成本继续算
function isHolding(p) {
  return p.status === "in_use" || p.status === "for_sale";
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------- 焦点陷阱 ----------------
// aria-modal 的弹窗若不拦 Tab，键盘用户会“穿”到背景表格。
// 打开时 push（记录来源焦点），关闭时 pop（焦点归还），Tab 循环限制在最上层容器内。
const focusStack = [];
function pushFocusTrap(container) {
  focusStack.push({ el: container, prev: document.activeElement });
}
function popFocusTrap() {
  const f = focusStack.pop();
  if (f && f.prev && document.body.contains(f.prev) && typeof f.prev.focus === "function") {
    f.prev.focus();
  }
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || !focusStack.length) return;
  const el = focusStack[focusStack.length - 1].el;
  const list = $$(
    "a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex='-1'])", el
  ).filter((x) => x.offsetParent !== null);
  if (!list.length) return;
  const first = list[0], last = list[list.length - 1];
  const ae = document.activeElement;
  const outside = ae !== document.body && !el.contains(ae);
  if (e.shiftKey && (ae === first || outside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (ae === last || outside)) { e.preventDefault(); first.focus(); }
});

// ---------------- API ----------------
// 子路径部署（fnOS 统一网关 /app/assettracker/）时，base 指向带前缀的根，
// 接口与静态资源都要跟着走，否则请求会打到网关根路径上 404。
const BASE = (document.querySelector("base")?.getAttribute("href") || "/").replace(/\/+$/, "");

async function api(url, method = "GET", body = null) {
  const opt = { method, headers: {} };
  if (body) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(BASE + url, opt);
  } catch (e) {
    throw new Error("网络请求失败，请确认服务是否在运行");
  }
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
  if (!res.ok) throw new Error((data && data.msg) || `请求失败（${res.status}）`);
  return data || {};
}
