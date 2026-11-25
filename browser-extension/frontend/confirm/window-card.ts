import { SCAM_SCOPE_NOTICE } from "@lib/scam-display";
import { WINDOW_WARNING_TITLE, windowRuleSentence, type WindowDisplay } from "@lib/window-display";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

/**
 * Window-rule warning. The card is only ever requested when a rule fired, so
 * the title needs no stored payload; `display` adds what fired and where.
 */
export function renderWindowCard(display?: WindowDisplay): HTMLElement {
  const card = node("section", "scam-card scam-warn window-card");
  card.lang = "ko";
  card.setAttribute("aria-label", WINDOW_WARNING_TITLE);
  card.appendChild(node("h2", "scam-title", "Scam Filter"));
  card.appendChild(node("p", "scam-status", WINDOW_WARNING_TITLE));
  if (display) {
    for (const rule of display.rules) card.appendChild(node("p", "scam-note", windowRuleSentence(rule)));
    card.appendChild(node("p", "scam-meta", `첫 유동성 공급 후 ${Math.max(1, Math.round(display.poolAgeSec / 60))}분 된 풀입니다.`));
  } else {
    card.appendChild(node("p", "scam-note", "새로 만들어진 풀에서 짧은 시간에 가격이 반복해서 크게 움직였습니다."));
  }
  card.appendChild(node("p", "scam-scope", SCAM_SCOPE_NOTICE));
  if (display) {
    card.appendChild(node("p", "scam-meta", `Chain ${display.chainId} · Token ${display.token}`));
    card.appendChild(node("p", "scam-meta", `Pool ${display.pool}`));
  }
  return card;
}
