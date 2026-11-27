import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import {
  getScamSettings,
  setBackdoorCheck,
  setWindowRuleSettings,
  type ScamSettings,
  type WindowCheckStatus,
  type WindowRuleSettings,
} from "../server-api/scam-settings";
import { Topbar } from "../shell/Topbar";

import "./scam.css";

const SETTINGS_KEY = ["scam-settings"] as const;

const DEFAULT_PRESET = "window-sensitive";
const PRESET_COPY: Record<string, { ko: [string, string]; en: [string, string] }> = {
  "window-sensitive": {
    ko: ["민감", "5분 안에 가격이 20% 이상 뛴 블록이 5번 이상"],
    en: ["Sensitive", "5 or more blocks with a 20%+ price jump within 5 minutes"],
  },
  "window-balanced": {
    ko: ["기본", "5분 안에 누적 20% 이상 상승이 8번 이상"],
    en: ["Balanced", "8 or more cumulative 20%+ rises within 5 minutes"],
  },
  "window-strict": {
    ko: ["엄격", "5분 안에 가격이 20% 이상 뛴 블록이 8번 이상"],
    en: ["Strict", "8 or more blocks with a 20%+ price jump within 5 minutes"],
  },
};
const RESULT_KO: Record<string, string> = {
  fired: "경고 발생", clear: "패턴 미감지", incomplete: "검사 불완전", not_evaluable: "평가 불가",
  skipped: "검사 대상 아님", undetermined: "판정 불가",
};
const REASON_KO: Record<string, string> = {
  rule_fired: "규칙 발동", clear: "경고 조건 없음", timeout: "2.5초 안에 끝나지 않음", rate_limited: "조회 요청 제한",
  rpc_timeout: "조회 시간 초과", logs_unavailable: "로그 조회 실패", start_state_unavailable: "풀 상태 조회 실패",
  start_state_unreadable: "풀 상태를 읽을 수 없음", logs_malformed: "로그 형식 오류", block_time_unavailable: "블록 시각 조회 실패",
  block_time_inconsistent: "블록 시각 불일치", pair_unavailable: "풀 조회 실패", head_unavailable: "최신 블록 조회 실패",
  algorithm_error: "규칙 계산 오류", pool_older_than_window: "첫 유동성 공급 후 1시간이 지난 풀", no_weth_pair: "WETH 풀 없음",
  no_liquidity_yet: "아직 유동성 없음", no_active_rule: "켜진 규칙 없음", partial_coverage: "관찰 구간 일부 누락",
  no_usable_segment: "쓸 수 있는 자료 없음", resolution_too_coarse: "관찰 간격이 규칙에 비해 큼", error: "검사 오류",
  // The check is made by the server; these are the ways asking it can fail.
  server_unavailable: "검사 서버에 연결할 수 없음", server_refused: "검사 서버가 요청을 거절함", bad_response: "검사 서버 응답을 읽을 수 없음",
};

function lastCheckText(last: WindowCheckStatus, ko: boolean): string {
  const when = new Date(last.at);
  const time = Number.isNaN(when.getTime()) ? last.at : when.toLocaleString(ko ? "ko-KR" : "en-US");
  if (!ko) return `Last check: ${last.result} (${last.reason}) · ${last.ms} ms · ${time}`;
  return `최근 검사: ${RESULT_KO[last.result] ?? last.result} — ${REASON_KO[last.reason] ?? last.reason} · ${last.ms}ms · ${time}`;
}

/**
 * `/scam` — scam filter. Two independent sections:
 *  1. Pool-backdoor check: one switch.
 *  2. Window rules, evaluated by the server check: a switch and a preset. When
 *     the team's local-demo host configuration is stored, the SDK runs that
 *     check instead and this section only says so.
 * Neither depends on the other.
 */
export function ScamPage() {
  const { t, i18n } = useTranslation("shell");
  const ko = i18n.language.startsWith("ko");
  const qc = useQueryClient();

  const settingsQ = useQuery({ queryKey: SETTINGS_KEY, queryFn: getScamSettings });
  const backdoorM = useMutation({
    mutationFn: setBackdoorCheck,
    onSuccess: (saved: ScamSettings) => qc.setQueryData(SETTINGS_KEY, saved),
  });

  const windowM = useMutation({
    mutationFn: setWindowRuleSettings,
    onSuccess: (saved: ScamSettings) => qc.setQueryData(SETTINGS_KEY, saved),
  });

  const backdoor = settingsQ.data?.backdoor ?? false;
  const windowRules = settingsQ.data?.windowRules;
  const sdkHost = windowRules?.configured ?? false;
  const saved: WindowRuleSettings = windowRules?.settings ?? { enabled: false, presetId: DEFAULT_PRESET, overrides: [], additionalRules: [] };
  const presets = windowRules?.presets ?? [];
  const windowDisabled = settingsQ.isLoading || settingsQ.isError || windowM.isPending;
  // A preset change drops the value edits made for the previous preset's rules; the user's own rules stay.
  const choosePreset = (presetId: string) => windowM.mutate({ ...saved, presetId, overrides: [] });
  const unavailable = settingsQ.isError;
  const disabled = settingsQ.isLoading || unavailable || backdoorM.isPending;

  return (
    <>
      <Topbar
        here={t("nav.scam")}
        subtitle={ko ? "서명 전에 스캠 패턴을 검사해 경고합니다" : "Warns about scam patterns before you sign"}
        showSearch={false}
      />
      <div className="sf-body">
        <section className="sf-card" aria-labelledby="sf-backdoor-title">
          <label className="sf-toggle">
            <span className="sf-toggle-main">
              <span className="sf-toggle-t" id="sf-backdoor-title">
                {ko ? "풀 백도어 검사" : "Pool backdoor check"}
              </span>
              <span className="sf-toggle-d">
                {ko
                  ? "처음 사는 토큰의 Uniswap V2 풀을 서명 전에 검사합니다. 풀을 만든 계정이 풀에 든 토큰을 임의로 옮길 수 있으면 경고합니다. (이더리움 메인넷, 생성 30일 이내 풀)"
                  : "Checks the Uniswap V2 pool of a token you are buying for the first time, before you sign. Warns when the account that created the pool can move the pool's tokens. (Ethereum mainnet, pools created in the last 30 days)"}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={backdoor}
              disabled={disabled}
              onChange={(e) => backdoorM.mutate(e.target.checked)}
            />
            <span className="sf-switch" aria-hidden="true" />
          </label>
          <p className="sf-note">
            {ko
              ? "검사는 담비 서버가 수행하며, 서버에는 사려는 토큰의 주소만 보냅니다. 지갑 주소와 금액은 보내지 않습니다. 꺼져 있으면 아무 요청도 보내지 않습니다. 경고만 하며 정책 판정은 바꾸지 않습니다."
              : "The check is made by Dambi's server, which is sent only the address of the token you are buying — not your wallet address or the amount. When off, no request is sent. It only warns and never changes the policy verdict."}
          </p>
          {unavailable && (
            <p className="sf-error" role="alert">
              {ko
                ? "확장 프로그램에서 설정을 읽지 못했습니다."
                : "Could not read the setting from the extension."}
            </p>
          )}
          {backdoorM.isError && (
            <p className="sf-error" role="alert">
              {ko ? "설정을 저장하지 못했습니다." : "Could not save the setting."}
            </p>
          )}
        </section>

        <section className="sf-card" aria-labelledby="sf-window-title">
          {sdkHost ? (
            <>
              <div className="sf-head">
                <h2 className="sf-title" id="sf-window-title">
                  {ko ? "윈도우 규칙" : "Window rules"}
                </h2>
                <span className="sf-status">{ko ? "SDK 검사 사용 중" : "SDK check in use"}</span>
              </div>
              <p className="sf-note">
                {ko
                  ? "확장 프로그램에 로컬 시연용 호스트 설정이 저장되어 있어 SDK가 윈도우 검사를 수행합니다. 이 설정이 있는 동안 서버의 윈도우 규칙 검사는 돌지 않습니다."
                  : "A local-demo host configuration is stored in the extension, so the SDK runs the window check. The server's window rule check does not run while it is present."}
              </p>
            </>
          ) : (
            <>
              <label className="sf-toggle">
                <span className="sf-toggle-main">
                  <span className="sf-toggle-t" id="sf-window-title">
                    {ko ? "윈도우 규칙 검사" : "Window rule check"}
                  </span>
                  <span className="sf-toggle-d">
                    {ko
                      ? "처음 사는 토큰의 Uniswap V2 풀이 첫 유동성 공급 후 1시간 이내일 때, 짧은 시간에 가격이 반복해서 크게 뛴 패턴이 있으면 서명 전에 경고합니다. (이더리움 메인넷)"
                      : "When the Uniswap V2 pool of a token you are buying for the first time is within an hour of its first liquidity, warns before you sign if the price jumped sharply and repeatedly in a short time. (Ethereum mainnet)"}
                  </span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={saved.enabled}
                  disabled={windowDisabled}
                  onChange={(e) => windowM.mutate({ ...saved, enabled: e.target.checked })}
                />
                <span className="sf-switch" aria-hidden="true" />
              </label>

              <div className="sf-presets" role="radiogroup" aria-label={ko ? "프리셋" : "Preset"}>
                {presets.map((id) => {
                  const copy = PRESET_COPY[id]?.[ko ? "ko" : "en"] ?? [id, ""];
                  return (
                    <label key={id} className={`sf-preset${saved.presetId === id ? " on" : ""}`}>
                      <input
                        type="radio"
                        name="sf-preset"
                        checked={saved.presetId === id}
                        disabled={windowDisabled}
                        onChange={() => choosePreset(id)}
                      />
                      <span className="sf-preset-t">{copy[0]}</span>
                      <span className="sf-preset-d">{copy[1]}</span>
                    </label>
                  );
                })}
              </div>

              <p className="sf-note">
                {ko
                  ? "검사는 담비 서버가 수행하며, 서버에는 토큰 주소와 규칙 값만 보냅니다. 1시간이 지난 풀에서는 규칙이 돌지 않습니다. 조회 실패·요청 제한·2.5초 초과·서버 연결 실패는 판정 불가로 끝나며 경고하지 않습니다. 경고만 하며 정책 판정은 바꾸지 않습니다."
                  : "The check is made by Dambi's server, which is sent only the token address and the rule values. No rule runs on a pool older than one hour. A failed lookup, a rate limit, exceeding 2.5 s or an unreachable server ends undetermined, without a warning. It only warns and never changes the policy verdict."}
              </p>
              {windowRules?.last && (
                <p className="sf-note sf-last" data-result={windowRules.last.result}>
                  {lastCheckText(windowRules.last, ko)}
                </p>
              )}
              {!!windowRules?.rejected.length && (
                <p className="sf-error" role="status">
                  {ko ? "저장된 규칙 수정 중 적용되지 않은 것: " : "Saved rule edits that are not applied: "}
                  {windowRules.rejected.map((r) => `${r.id} (${r.reason})`).join(", ")}
                </p>
              )}
              {windowM.isError && (
                <p className="sf-error" role="alert">
                  {ko ? "설정을 저장하지 못했습니다." : "Could not save the setting."}
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
