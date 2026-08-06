// 로컬 LS 클라이언트 — 설정 로드 + 토큰 + 잔고 점검(Phase 1). 시세/주문은 Phase 2.
// src/lib/ls-api.ts(LS 공식 TR) 를 그대로 재사용한다.
import { getLSAccessToken, getLSKRBalance, getLSUSBalance } from '../src/lib/ls-api';
import { FileKV } from './file-kv';
import { maskAccount, makeScrubber, sanitizeBlocks } from './mask';
import type { Logger } from './logger';

export interface LocalLSConfig {
  appKey: string;
  appSecret: string;
  accountNo?: string;
  accountSuffix?: string;
  liveTrading: boolean;   // LS_LIVE_TRADING === 'true' 일 때만 true (기본 observe-only)
}

export function loadConfig(): LocalLSConfig {
  const appKey = process.env.LS_APP_KEY || '';
  const appSecret = process.env.LS_APP_SECRET || '';
  if (!appKey || !appSecret) {
    throw new Error('LS_APP_KEY / LS_APP_SECRET 미설정 (.env.local 확인)');
  }
  return {
    appKey, appSecret,
    accountNo: process.env.LS_ACCOUNT_NO || undefined,
    accountSuffix: process.env.LS_ACCOUNT_SUFFIX || undefined,
    liveTrading: process.env.LS_LIVE_TRADING === 'true',   // 기본 false = observe-only
  };
}

// 토큰만 발급/캐시해 반환 (Phase 2 시세/분봉 호출용).
// LS_FORCE_TOKEN_REFRESH=true 면 기존 캐시를 삭제하고 새로 발급한다(req 7 — 해외 약정등록 후).
export async function getTokenCached(cfg: LocalLSConfig): Promise<string> {
  const kv = new FileKV();
  if (process.env.LS_FORCE_TOKEN_REFRESH === 'true') kv.delete('ls_token_v1');
  return getLSAccessToken({ appKey: cfg.appKey, appSecret: cfg.appSecret }, kv as any);
}

// 해외 시세 구분 해석(req 1~6). REALTIME='R'(공식 확인값), DELAYED=공식 지연코드(env 로 입력).
// 미국주식 실시간은 Non-Display 불가 → 기본 DELAYED. 공식 지연 코드는 추측하지 않는다.
export function resolveUSQuote(): { mode: 'REALTIME' | 'DELAYED'; delaygb: string | null; error?: string } {
  const mode = (process.env.LS_US_QUOTE_MODE || 'DELAYED').toUpperCase() === 'REALTIME' ? 'REALTIME' : 'DELAYED';
  if (mode === 'REALTIME') return { mode, delaygb: 'R' };   // 공식 reqExample 로 확인된 값
  const code = (process.env.LS_US_DELAYGB || '').trim();
  if (!code) {
    return { mode, delaygb: null, error: 'LS_US_DELAYGB 미설정 — LS 공식 g3101/g3203 문서의 지연 delaygb 코드를 .env.local 에 입력하세요(추측 금지).' };
  }
  return { mode, delaygb: code };
}

// 현재 공인 IP (LS 등록 IP 확인용). 실패해도 진행.
export async function getPublicIp(): Promise<string | null> {
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    if (!res.ok) return null;
    const d = await res.json() as { ip?: string };
    return d.ip ?? null;
  } catch { return null; }
}

export interface BalanceReport {
  token_ok: boolean;
  account_masked: string | null;
  account_suffix: string;
  kr_balance_ok: boolean;
  kr_rsp_cd: string | null;
  kr_total_eval: number | null;
  kr_orderable_cash: number | null;
  us_balance_ok: boolean;
  us_rsp_cd: string | null;
  us_total_eval_krw: number | null;
  errors: { kr: string | null; us: string | null };
}

// Phase 1: 토큰 + 국내/해외 잔고. 콘솔·파일에 마스킹된 결과만 남긴다(비밀값 미출력).
// diagRaw=true 면 국내 응답 블록 원문을 민감필드 제거 후 임시 로깅한다(필드 유입 확인용).
export async function runBalanceCheck(cfg: LocalLSConfig, log: Logger, opts: { diagRaw?: boolean } = {}): Promise<BalanceReport> {
  const suffix = cfg.accountSuffix || '';
  const kv = new FileKV();
  const sensitive: Array<string | undefined> = [cfg.appKey, cfg.appSecret, cfg.accountNo];
  let scrub = makeScrubber(sensitive);

  const report: BalanceReport = {
    token_ok: false, account_masked: null, account_suffix: suffix,
    kr_balance_ok: false, kr_rsp_cd: null, kr_total_eval: null, kr_orderable_cash: null,
    us_balance_ok: false, us_rsp_cd: null, us_total_eval_krw: null,
    errors: { kr: null, us: null },
  };

  let token: string;
  try {
    token = await getLSAccessToken({ appKey: cfg.appKey, appSecret: cfg.appSecret }, kv as any);
    report.token_ok = true;
    sensitive.push(token);
    scrub = makeScrubber(sensitive);
    log.info('LS 토큰 발급/캐시 OK');
  } catch (e) {
    log.error(`LS 토큰 발급 실패: ${scrub(String(e))}`);
    return report;
  }

  // 해외 잔고 기준일 = KST 오늘 (YYYYMMDD)
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  const baseDt = `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}${String(k.getUTCDate()).padStart(2, '0')}`;

  let acctFromApi: string | null = null;
  try {
    const b = await getLSKRBalance({ appKey: cfg.appKey, appSecret: cfg.appSecret }, token);
    report.kr_balance_ok = true;
    report.kr_rsp_cd = b.rspCd;
    report.kr_total_eval = b.totalEval;
    report.kr_orderable_cash = b.orderableCash;
    acctFromApi = b.accountNo;
    log.info(`KR 잔고 OK (rsp_cd=${b.rspCd}) — 총평가=${b.totalEval.toLocaleString()} 주문가능현금=${b.orderableCash.toLocaleString()}`);
    // 임시 진단: 국내 응답 블록 원문(민감필드 제거) — MnyOrdAbleAmt/DpsastTotamt/Dps 유입 확인용
    if (opts.diagRaw) {
      log.info('[DIAG] CSPAQ12200 OutBlock1(민감제거)=' + scrub(JSON.stringify(sanitizeBlocks(b.raw.OutBlock1))));
      log.info('[DIAG] CSPAQ12200 OutBlock2=' + scrub(JSON.stringify(sanitizeBlocks(b.raw.OutBlock2))));
    }
  } catch (e) {
    report.errors.kr = scrub(String(e));
    log.error(`KR 잔고 실패: ${report.errors.kr}`);
  }

  try {
    const b = await getLSUSBalance({ appKey: cfg.appKey, appSecret: cfg.appSecret }, token, baseDt);
    report.us_balance_ok = true;
    report.us_rsp_cd = b.rspCd;
    report.us_total_eval_krw = b.totalEvalKRW;
    if (!acctFromApi) acctFromApi = b.accountNo;
    log.info(`US 잔고 OK (rsp_cd=${b.rspCd}${b.empty ? ', 조회내역 없음→0' : ''}) — 원화환산 총평가=${b.totalEvalKRW.toLocaleString()}`);
  } catch (e) {
    report.errors.us = scrub(String(e));
    log.error(`US 잔고 실패: ${report.errors.us}`);
  }

  // 계좌 마스킹 (env 우선, 없으면 API 에코). 전체 계좌번호는 절대 로그/반환 금지.
  report.account_masked = maskAccount(cfg.accountNo || acctFromApi, suffix);
  log.info(`계좌(마스킹): ${report.account_masked ?? '(미확인)'}`);

  return report;
}
