import {
  BACKDOOR_WARNING_TEXT,
  BACKDOOR_WARNING_TITLE,
  type BackdoorDisplay,
} from "@lib/backdoor-display";
import { SCAM_SCOPE_NOTICE } from "@lib/scam-display";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

/**
 * Pool-backdoor warning. The card is only ever requested for a flagged pool,
 * so the warning itself needs no stored payload; `display` adds the addresses
 * once the page has read them.
 */
export function renderBackdoorCard(display?: BackdoorDisplay): HTMLElement {
  const card = node("section", "scam-card scam-warn backdoor-card");
  card.lang = "ko";
  card.setAttribute("aria-label", BACKDOOR_WARNING_TITLE);
  card.appendChild(node("h2", "scam-title", "Scam Filter"));
  card.appendChild(node("p", "scam-status", BACKDOOR_WARNING_TITLE));
  card.appendChild(node("p", "scam-note", BACKDOOR_WARNING_TEXT));
  card.appendChild(node("p", "scam-scope", SCAM_SCOPE_NOTICE));
  if (display) {
    card.appendChild(node("p", "scam-meta", `Chain ${display.chainId} · Token ${display.token}`));
    card.appendChild(node("p", "scam-meta", `Pool ${display.pool}`));
    card.appendChild(node("p", "scam-meta", `풀 생성 계정 ${display.deployer}`));
  }
  return card;
}
