// 로컬 LS 클라이언트 — 설정 로드 + 토큰 + 잔고 점검(Phase 1). 시세/주문은 Phase 2.
// src/lib/ls-api.ts(LS 공식 TR) 를 그대로 재사용한다.
import { getLSAccessToken, getLSKRBalance, getLSUSBalance } from '../src/lib/ls-api';
import { FileKV } from './file-kv';
import { maskAccount, makeScrubber, sanitizeBlocks, keyFingerprint } from './mask';
import type { Logger } from './logger';

// KR/US 앱키 완전 분리 (req 1~4). 국내=KR키, overseas-stock/*=US키. 토큰도 분리.
export interface KeyPair { appKey: string; appSecret: string; }
export interface LocalLSConfig {
  kr: KeyPair;
  us: KeyPair;
  accountNo?: string;
  accountSuffix?: string;
  liveTrading: boolean;   // LS_LIVE_TRADING === 'true' 일 때만 true (기본 observe-only)
}

export function loadConfig(): LocalLSConfig {
  const kr: KeyPair = { appKey: process.env.LS_KR_APP_KEY || '', appSecret: process.env.LS_KR_APP_SECRET || '' };
  const us: KeyPair = { appKey: process.env.LS_US_APP_KEY || '', appSecret: process.env.LS_US_APP_SECRET || '' };
  const missing: string[] = [];
  if (!kr.appKey || !kr.appSecret) missing.push('LS_KR_APP_KEY/LS_KR_APP_SECRET');
  if (!us.appKey || !us.appSecret) missing.push('LS_US_APP_KEY/LS_US_APP_SECRET');
  if (missing.length) throw new Error(`${missing.join(', ')} 미설정 (.env.local) — 국내/해외 키 분리 필요`);
  return {
    kr, us,
    accountNo: process.env.LS_ACCOUNT_NO || undefined,
    accountSuffix: process.env.LS_ACCOUNT_SUFFIX || undefined,
    liveTrading: process.env.LS_LIVE_TRADING === 'true',   // 기본 false = observe-only
  };
}

// 지문 로그 (앞 4자리만, req 5): "KR key = abcd****  US key = 9f21****"
export function logKeyFingerprints(cfg: LocalLSConfig, log: Logger): void {
  log.info(`KR key = ${keyFingerprint(cfg.kr.appKey)}  US key = ${keyFingerprint(cfg.us.appKey)}`);
}

// 시장별 토큰 발급/캐시 — KR/US 완전 분리 캐시키(ls_token_kr / ls_token_us).
// LS_FORCE_TOKEN_REFRESH=true 면 기존 캐시 삭제 후 재발급(req 7 — 해외 약정등록 후).
export async function getTokenFor(pair: KeyPair, market: 'kr' | 'us'): Promise<string> {
  const kv = new FileKV();
  const cacheKey = `ls_token_${market}`;
  if (process.env.LS_FORCE_TOKEN_REFRESH === 'true') kv.delete(cacheKey);
  return getLSAccessToken({ appKey: pair.appKey, appSecret: pair.appSecret }, kv as any, cacheKey);
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
  const sensitive: Array<string | undefined> = [cfg.kr.appKey, cfg.kr.appSecret, cfg.us.appKey, cfg.us.appSecret, cfg.accountNo];
  let scrub = makeScrubber(sensitive);

  const report: BalanceReport = {
    token_ok: false, account_masked: null, account_suffix: suffix,
    kr_balance_ok: false, kr_rsp_cd: null, kr_total_eval: null, kr_orderable_cash: null,
    us_balance_ok: false, us_rsp_cd: null, us_total_eval_krw: null,
    errors: { kr: null, us: null },
  };
  logKeyFingerprints(cfg, log);

  // 해외 잔고 기준일 = KST 오늘 (YYYYMMDD)
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  const baseDt = `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}${String(k.getUTCDate()).padStart(2, '0')}`;

  let acctFromApi: string | null = null;

  // ── 국내: KR 키/토큰 ──
  try {
    const krToken = await getTokenFor(cfg.kr, 'kr');
    sensitive.push(krToken); scrub = makeScrubber(sensitive);
    const b = await getLSKRBalance(cfg.kr, krToken);
    report.kr_balance_ok = true;
    report.kr_rsp_cd = b.rspCd;
    report.kr_total_eval = b.totalEval;
    report.kr_orderable_cash = b.orderableCash;
    acctFromApi = b.accountNo;
    log.info(`KR 잔고 OK (KR키 ${keyFingerprint(cfg.kr.appKey)}, rsp_cd=${b.rspCd}) — 총평가=${b.totalEval.toLocaleString()} 주문가능현금=${b.orderableCash.toLocaleString()}`);
    if (opts.diagRaw) {
      log.info('[DIAG] CSPAQ12200 OutBlock1(민감제거)=' + scrub(JSON.stringify(sanitizeBlocks(b.raw.OutBlock1))));
      log.info('[DIAG] CSPAQ12200 OutBlock2=' + scrub(JSON.stringify(sanitizeBlocks(b.raw.OutBlock2))));
    }
  } catch (e) {
    report.errors.kr = scrub(String(e));
    log.error(`KR 잔고 실패 (KR키 ${keyFingerprint(cfg.kr.appKey)}): ${report.errors.kr}`);
  }

  // ── 해외: US 키/토큰 ──
  try {
    const usToken = await getTokenFor(cfg.us, 'us');
    sensitive.push(usToken); scrub = makeScrubber(sensitive);
    const b = await getLSUSBalance(cfg.us, usToken, baseDt);
    report.us_balance_ok = true;
    report.us_rsp_cd = b.rspCd;
    report.us_total_eval_krw = b.totalEvalKRW;
    if (!acctFromApi) acctFromApi = b.accountNo;
    log.info(`US 잔고 OK (US키 ${keyFingerprint(cfg.us.appKey)}, rsp_cd=${b.rspCd}${b.empty ? ', 조회내역 없음→0' : ''}) — 원화환산 총평가=${b.totalEvalKRW.toLocaleString()}`);
  } catch (e) {
    report.errors.us = scrub(String(e));
    log.error(`US 잔고 실패 (US키 ${keyFingerprint(cfg.us.appKey)}): ${report.errors.us}`);
  }
  report.token_ok = report.kr_balance_ok || report.us_balance_ok;

  // 계좌 마스킹 (env 우선, 없으면 API 에코). 전체 계좌번호는 절대 로그/반환 금지.
  report.account_masked = maskAccount(cfg.accountNo || acctFromApi, suffix);
  log.info(`계좌(마스킹): ${report.account_masked ?? '(미확인)'}`);

  return report;
}
