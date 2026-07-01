/**
 * 종목 유니버스 관리 모듈 v3
 * ─────────────────────────────────────────────────────────────
 * KOSPI / KOSDAQ / NASD / NYSE / AMEX 전체 종목을
 * stock_universe 테이블에 저장하고 배치 스캔 큐를 관리한다.
 *
 * ■ KR 종목
 *   - KIS API: /uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice
 *     전체 종목 리스트는 KIS에서 직접 제공하지 않으므로
 *     → 금융투자협회(kofia) 또는 KRX 공개 데이터 기반 대표종목 + 추가 가능
 *   - 초기 시드: KOSPI/KOSDAQ 대표 300+ 종목 내장 (실제 운영시 KRX CSV 로드)
 *
 * ■ US 종목
 *   - NASD(나스닥) / NYSE(뉴욕) / AMEX(아멕스) 대표 종목 내장
 *   - 실제 전체 종목은 외부 CSV 또는 KIS 종목조회 API로 확장 가능
 *
 * ■ 배치 스캔 방식
 *   - Cron 1회 실행 시 BATCH_SIZE 종목만 처리
 *   - batch_offset을 DB에 저장하여 다음 Cron에서 이어서 처리
 *   - 전체 순회 완료 시 offset=0으로 리셋 (다음 라운드 시작)
 */

export type ExchangeName = 'KOSPI' | 'KOSDAQ' | 'NASD' | 'NYSE' | 'AMEX';

export interface UniverseItem {
  ticker: string;
  ticker_name: string;
  market: 'KR' | 'US';
  exchange: ExchangeName;
  scan_priority?: number;  // 스캔 우선순위 (높을수록 먼저 처리)
}

// ── KOSPI 대표 종목 (시가총액 상위 + 주요 업종) ──────────────
const KOSPI_STOCKS: [string, string][] = [
  ['005930','삼성전자'],['000660','SK하이닉스'],['005380','현대차'],
  ['005490','POSCO홀딩스'],['035420','NAVER'],['000270','기아'],
  ['105560','KB금융'],['055550','신한지주'],['035720','카카오'],
  ['028260','삼성물산'],['012330','현대모비스'],['207940','삼성바이오로직스'],
  ['068270','셀트리온'],['032830','삼성생명'],['003550','LG'],
  ['096770','SK이노베이션'],['003490','대한항공'],['034020','두산에너빌리티'],
  ['036570','엔씨소프트'],['011200','HMM'],['010950','S-Oil'],
  ['051910','LG화학'],['006400','삼성SDI'],['373220','LG에너지솔루션'],
  ['000100','유한양행'],['047050','포스코인터내셔널'],['086790','하나금융지주'],
  ['316140','우리금융지주'],['009150','삼성전기'],['010130','고려아연'],
  ['011070','LG이노텍'],['034730','SK'],['017670','SK텔레콤'],
  ['030200','KT'],['032640','LG유플러스'],['018260','삼성에스디에스'],
  ['042700','한미반도체'],['000810','삼성화재'],['088350','한화생명'],
  ['139480','이마트'],['004020','현대제철'],['042660','한화오션'],
  ['009540','HD한국조선해양'],['011790','SKC'],['019880','교촌에프앤비'],
  ['090430','아모레퍼시픽'],['033780','KT&G'],['021240','코웨이'],
  ['024110','기업은행'],['000720','현대건설'],['006800','미래에셋증권'],
  ['071050','한국금융지주'],['003830','대한해운'],['015760','한국전력'],
  ['036460','한국가스공사'],['002790','아모레G'],['010140','삼성중공업'],
  ['011170','롯데케미칼'],['004370','농심'],['271560','오리온'],
  ['282330','BGF리테일'],['069960','현대백화점'],['023530','롯데쇼핑'],
  ['180640','한진칼'],['003600','SK케미칼'],['298050','효성첨단소재'],
  ['000080','하이트진로'],['001800','오리온홀딩스'],['005300','롯데칠성'],
  ['006360','GS건설'],['000990','동부제철'],['001430','세아베스틸지주'],
  ['033240','자화전자'],['091990','셀트리온헬스케어'],['214150','클래시스'],
  ['196170','알테오젠'],['285130','SK바이오사이언스'],['302440','SK바이오팜'],
  ['326030','SK바이오텍'],['263720','디어유'],['251270','넷마블'],
  ['293490','카카오게임즈'],['259960','크래프톤'],['352820','하이브'],
  ['041510','에스엠'],['122870','YG엔터테인먼트'],['035900','JYP Ent.'],
  ['001040','CJ'],['079160','CJ CGV'],['097950','CJ제일제당'],
];

// ── KOSDAQ 대표 종목 ─────────────────────────────────────────
const KOSDAQ_STOCKS: [string, string][] = [
  ['247540','에코프로비엠'],['086520','에코프로'],['373220','LG에너지솔루션'],
  ['357780','솔브레인'],['263750','펄어비스'],['145020','휴젤'],
  ['214150','클래시스'],['196170','알테오젠'],['140610','엔씨소프트'],
  ['091990','셀트리온헬스케어'],['377300','카카오페이'],['403870','HPSP'],
  ['241560','두산테스나'],['039030','이오테크닉스'],['112040','위메이드'],
  ['348030','일진하이솔루스'],['018290','레이'],['036540','SFA반도체'],
  ['048410','현대바이오'],['297090','HLB생명과학'],['142280','녹십자엠에스'],
  ['078600','대주전자재료'],['066970','엘앤에프'],['006260','LS'],
  ['900310','조광피혁'],['023160','태광'],['059100','아이컴포넌트'],
  ['138040','메리츠금융지주'],['200670','후성'],['137400','피엔티'],
  ['044480','유진테크'],['096530','씨젠'],['215600','신라젠'],
  ['221800','에쎄스'],['268600','KTNG'],['028300','HLB'],
  ['290550','디티알오토모티브'],['389260','대성파인텍'],['160580','새빗켐'],
  ['356360','티로보틱스'],['119850','지엔코'],['330350','노머스'],
  ['009290','광동제약'],['016090','이수페타시스'],['131970','두산테스나'],
  ['036620','감성코퍼레이션'],['950140','잉글우드랩'],['073490','이엔에프테크놀로지'],
  ['031430','신성통상'],['054540','삼영전자공업'],
];

// ── NASDAQ 대표 종목 ─────────────────────────────────────────
const NASD_STOCKS: [string, string][] = [
  ['AAPL','Apple'],['MSFT','Microsoft'],['NVDA','NVIDIA'],
  ['AMZN','Amazon'],['META','Meta'],['GOOGL','Alphabet A'],
  ['GOOG','Alphabet C'],['TSLA','Tesla'],['AVGO','Broadcom'],
  ['COST','Costco'],['NFLX','Netflix'],['ASML','ASML'],
  ['AMD','AMD'],['QCOM','Qualcomm'],['INTC','Intel'],
  ['TXN','Texas Instruments'],['MU','Micron'],['LRCX','Lam Research'],
  ['KLAC','KLA'],['AMAT','Applied Materials'],['MRVL','Marvell'],
  ['ADI','Analog Devices'],['CDNS','Cadence Design'],['SNPS','Synopsys'],
  ['PANW','Palo Alto'],['CRWD','CrowdStrike'],['FTNT','Fortinet'],
  ['IDXX','IDEXX Labs'],['ISRG','Intuitive Surgical'],['VRTX','Vertex Pharma'],
  ['REGN','Regeneron'],['AMGN','Amgen'],['GILD','Gilead'],
  ['BIIB','Biogen'],['MRNA','Moderna'],['ILMN','Illumina'],
  ['CSX','CSX Corp'],['ODFL','Old Dominion'],['FAST','Fastenal'],
  ['PAYX','Paychex'],['DXCM','DexCom'],['EXC','Exelon'],
  ['ADP','ADP'],['CTAS','Cintas'],['ROST','Ross Stores'],
  ['ORLY',"O'Reilly Auto"],['PCAR','PACCAR'],['MNST','Monster Beverage'],
  ['MCHP','Microchip Tech'],['ON','ON Semiconductor'],['NXPI','NXP Semi'],
  ['SMCI','Super Micro'],['ARM','ARM Holdings'],['PLTR','Palantir'],
  ['APP','Applovin'],['DDOG','Datadog'],['ZS','Zscaler'],
  ['SNOW','Snowflake'],['COIN','Coinbase'],['HOOD','Robinhood'],
  ['LYFT','Lyft'],['UBER','Uber'],['ABNB','Airbnb'],
  ['DASH','DoorDash'],['RBLX','Roblox'],['MSTR','MicroStrategy'],
  ['SOUN','SoundHound AI'],['RXRX','Recursion Pharma'],['JOBY','Joby Aviation'],
  ['LCID','Lucid Motors'],['RIVN','Rivian'],['NIO','NIO'],
  ['XPEV','XPeng'],['LI','Li Auto'],['PDD','PDD Holdings'],
  ['JD','JD.com'],['BIDU','Baidu'],['NTES','NetEase'],
];

// ── NYSE 대표 종목 ───────────────────────────────────────────
const NYSE_STOCKS: [string, string][] = [
  ['BRK/B','Berkshire B'],['JPM','JPMorgan'],['V','Visa'],
  ['MA','Mastercard'],['XOM','ExxonMobil'],['UNH','UnitedHealth'],
  ['LLY','Eli Lilly'],['JNJ','Johnson & Johnson'],['PG','Procter & Gamble'],
  ['HD','Home Depot'],['MRK','Merck'],['ABBV','AbbVie'],
  ['CVX','Chevron'],['KO','Coca-Cola'],['PEP','PepsiCo'],
  ['MCD','McDonald'],['WMT','Walmart'],['BAC','Bank of America'],
  ['WFC','Wells Fargo'],['GS','Goldman Sachs'],['MS','Morgan Stanley'],
  ['C','Citigroup'],['BX','Blackstone'],['AXP','American Express'],
  ['BLK','BlackRock'],['T','AT&T'],['VZ','Verizon'],
  ['IBM','IBM'],['GE','GE Aerospace'],['HON','Honeywell'],
  ['CAT','Caterpillar'],['DE','Deere & Company'],['BA','Boeing'],
  ['RTX','RTX Corp'],['LMT','Lockheed Martin'],['NOC','Northrop Grumman'],
  ['GD','General Dynamics'],['MMM','3M'],['EMR','Emerson Electric'],
  ['ETN','Eaton'],['ROK','Rockwell Automation'],['ABT','Abbott'],
  ['MDT','Medtronic'],['SYK','Stryker'],['BSX','Boston Scientific'],
  ['ELV','Elevance'],['CI','Cigna'],['HUM','Humana'],
  ['CVS','CVS Health'],['BMY','Bristol-Myers'],['PFE','Pfizer'],
  ['NVO','Novo Nordisk'],['AZN','AstraZeneca'],['SNY','Sanofi'],
  ['SHW','Sherwin-Williams'],['APD','Air Products'],['LIN','Linde'],
  ['NEM','Newmont'],['FCX','Freeport-McMoRan'],['CLF','Cleveland-Cliffs'],
  ['X','US Steel'],['NUE','Nucor'],['AA','Alcoa'],
  ['DIS','Disney'],['CMCSA','Comcast'],['CHTR','Charter Comm'],
  ['PARA','Paramount'],['FOX','Fox Corp'],['NKE','Nike'],
  ['TGT','Target'],['LOW','Lowes'],['TJX','TJX Companies'],
  ['DHI','D.R. Horton'],['LEN','Lennar'],['PHM','PulteGroup'],
  ['SPG','Simon Property'],['PLD','Prologis'],['AMT','American Tower'],
  ['CCI','Crown Castle'],['EQIX','Equinix'],['O','Realty Income'],
];

// ── AMEX 대표 종목 ───────────────────────────────────────────
const AMEX_STOCKS: [string, string][] = [
  ['SLV','iShares Silver'],['GDX','VanEck Gold Miners'],['GDXJ','Junior Gold Miners'],
  ['USO','US Oil Fund'],['UNG','US Natural Gas'],['DBO','DB Oil Fund'],
  ['SOXS','Direxion Semi Bear'],['SOXL','Direxion Semi Bull'],['TQQQ','ProShares QQQ 3x'],
  ['SQQQ','ProShares Short QQQ'],['SPXL','Direxion S&P 3x'],['SPXS','Direxion S&P Bear'],
  ['TNA','Direxion Small Bull'],['TZA','Direxion Small Bear'],['LABU','Direxion Bio Bull'],
  ['LABD','Direxion Bio Bear'],['NUGT','Direxion Gold Bull'],['DUST','Direxion Gold Bear'],
  ['JNUG','Jr Gold Bull'],['JDST','Jr Gold Bear'],['GUSH','Direxion Energy Bull'],
  ['DRIP','Direxion Energy Bear'],['FAS','Direxion Fin Bull'],['FAZ','Direxion Fin Bear'],
  ['FNGU','MicroSectors FANG+'],['FNGD','MicroSectors FANG- Bear'],
  ['YINN','Direxion China Bull'],['YANG','Direxion China Bear'],
  ['ERX','Direxion Energy 2x'],['ERY','Direxion Energy Bear 2x'],
  ['BOIL','ProShares Gas 2x'],['KOLD','ProShares Gas -2x'],
  ['UCO','ProShares Crude 2x'],['SCO','ProShares Crude -2x'],
  ['AGQ','ProShares Silver 2x'],['ZSL','ProShares Silver -2x'],
  ['DRN','Direxion RE Bull'],['DRV','Direxion RE Bear'],
  ['TECL','Direxion Tech Bull'],['TECS','Direxion Tech Bear'],
  ['DFEN','Direxion Defense Bull'],['WANT','Direxion Consumer Bull'],
  ['WEBL','Direxion Internet Bull'],['WEBS','Direxion Internet Bear'],
];

// ── 전체 유니버스 집합 ───────────────────────────────────────
export const STOCK_UNIVERSE: UniverseItem[] = [
  ...KOSPI_STOCKS.map(([t, n]) => ({ ticker: t, ticker_name: n, market: 'KR' as const, exchange: 'KOSPI' as const })),
  ...KOSDAQ_STOCKS.map(([t, n]) => ({ ticker: t, ticker_name: n, market: 'KR' as const, exchange: 'KOSDAQ' as const })),
  ...NASD_STOCKS.map(([t, n]) => ({ ticker: t, ticker_name: n, market: 'US' as const, exchange: 'NASD' as const })),
  ...NYSE_STOCKS.map(([t, n]) => ({ ticker: t, ticker_name: n, market: 'US' as const, exchange: 'NYSE' as const })),
  ...AMEX_STOCKS.map(([t, n]) => ({ ticker: t, ticker_name: n, market: 'US' as const, exchange: 'AMEX' as const })),
];

/** 유니버스 통계 */
export function getUniverseStats() {
  const byExchange: Record<string, number> = {};
  for (const s of STOCK_UNIVERSE) {
    byExchange[s.exchange] = (byExchange[s.exchange] || 0) + 1;
  }
  return {
    total: STOCK_UNIVERSE.length,
    by_exchange: byExchange,
    kr_total: STOCK_UNIVERSE.filter(s => s.market === 'KR').length,
    us_total: STOCK_UNIVERSE.filter(s => s.market === 'US').length,
  };
}

/**
 * DB에 전체 종목 로드 (없는 것만 INSERT)
 * Cron 또는 수동 실행으로 초기 1회 + 주기적 갱신 가능
 */
export async function loadUniverseToDB(db: D1Database): Promise<{ inserted: number; total: number }> {
  let inserted = 0;
  // 50개씩 배치 INSERT
  const CHUNK = 50;
  for (let i = 0; i < STOCK_UNIVERSE.length; i += CHUNK) {
    const chunk = STOCK_UNIVERSE.slice(i, i + CHUNK);
    for (const s of chunk) {
      const r = await db.prepare(
        `INSERT OR IGNORE INTO stock_universe (ticker, ticker_name, market, exchange)
         VALUES (?, ?, ?, ?)`
      ).bind(s.ticker, s.ticker_name, s.market, s.exchange).run();
      if (r.meta?.changes && r.meta.changes > 0) inserted++;
    }
  }
  await db.prepare(
    "UPDATE system_config SET value=?, updated_at=CURRENT_TIMESTAMP WHERE key='universe_loaded_at'"
  ).bind(new Date().toISOString()).run();
  return { inserted, total: STOCK_UNIVERSE.length };
}

/**
 * 배치 스캔 큐에서 다음 처리할 종목 슬라이스 반환
 *
 * 스캔 우선순위: scan_priority DESC (↑높음수로 먼저)
 *   1순위 (priority=100): 거래대금 상위 종목
 *   2순위 (priority=50) : 시가엑 상위 종목
 *   3순위 (priority=0)  : 나머지 일반 종목
 * 동순위 내에서는 exchange, ticker 오름차순
 *
 * @param db
 * @param batchSize    1회 처리 종목 수
 * @param marketFilter 'KR' | 'US' | 'ALL'
 */
export async function getNextBatch(
  db: D1Database,
  batchSize: number,
  marketFilter: 'KR' | 'US' | 'ALL' = 'ALL'
): Promise<{
  items: Array<{ ticker: string; ticker_name: string; market: 'KR' | 'US'; exchange: ExchangeName; scan_priority: number }>;
  offset: number;
  total: number;
  isNewRound: boolean;
}> {
  const where = marketFilter === 'ALL' ? '' : `WHERE market = '${marketFilter}'`;
  const totalRow = await db.prepare(
    `SELECT COUNT(*) as cnt FROM stock_universe ${where} AND is_active = 1`
      .replace('  AND', ' WHERE').replace('WHERE  WHERE', 'WHERE')
  ).first<{ cnt: number }>();
  const total = totalRow?.cnt || 0;
  if (total === 0) return { items: [], offset: 0, total: 0, isNewRound: false };

  // 현재 offset 읽기
  const offRow = await db.prepare(
    `SELECT value FROM system_config WHERE key = 'scan_batch_offset_${marketFilter.toLowerCase()}'`
  ).first<{ value: string }>();
  let offset = parseInt(offRow?.value || '0');
  const isNewRound = offset === 0;

  if (offset >= total) offset = 0; // 순환

  const marketCond = marketFilter === 'ALL' ? '' : `AND market = '${marketFilter}'`;

  // 우선순위: scan_priority DESC → 거래대금 상위 → 시가엑 상위 → 나머지
  // 동순위 안에서는 exchange, ticker 오름차순 (안정적 순환 보장)
  const rows = await db.prepare(
    `SELECT ticker, ticker_name, market, exchange,
            COALESCE(scan_priority, 0) as scan_priority
     FROM stock_universe
     WHERE is_active = 1 ${marketCond}
     ORDER BY scan_priority DESC, exchange ASC, ticker ASC
     LIMIT ? OFFSET ?`
  ).bind(batchSize, offset).all<{ ticker: string; ticker_name: string; market: 'KR' | 'US'; exchange: ExchangeName; scan_priority: number }>();

  const nextOffset = offset + (rows.results?.length || 0);

  // offset 저장
  await db.prepare(
    `INSERT OR REPLACE INTO system_config (key, value, description)
     VALUES ('scan_batch_offset_${marketFilter.toLowerCase()}', ?, '배치 스캔 오프셋')`
  ).bind(String(nextOffset >= total ? 0 : nextOffset)).run();

  return {
    items: rows.results || [],
    offset,
    total,
    isNewRound,
  };
}

/**
 * 스캔 결과 업데이트
 */
export async function updateUniverseScanResult(
  db: D1Database,
  ticker: string,
  exchange: string,
  signal: string,
  error?: string
): Promise<void> {
  await db.prepare(
    `UPDATE stock_universe
     SET last_scanned_at = CURRENT_TIMESTAMP,
         last_signal = ?,
         scan_error = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE ticker = ? AND exchange = ?`
  ).bind(signal, error || null, ticker, exchange).run();
}

/**
 * 스캔 통계 조회 (대시보드용)
 * ─────────────────────────────────────────────────────────────
 * 5가지 상태 분류:
 *   normal_count    — 정상 스캔 (NONE/NO_SIGNAL)
 *   no_data_count   — 데이터 부족 (NO_DATA: 봉수 부족 / 평탄봉 / std=0 / BB폭 너무 좁음)
 *   error_count     — API 오류 (ERROR / ERROR_US_MARKET_DATA_PERMISSION 포함)
 *   buy_signals     — 매수 신호 (BUY)
 *   sell_signals    — 매도 신호 (SELL)
 *   us_permission_error_count — 해외주식 시세 권한 없음 (ERROR_US_MARKET_DATA_PERMISSION)
 */
export async function getScanStats(db: D1Database): Promise<{
  total: number;
  scanned_today: number;
  pending: number;
  normal_count: number;
  no_data_count: number;
  buy_signals: number;
  sell_signals: number;
  error_count: number;
  us_permission_error_count: number;
  by_exchange: Record<string, { total: number; scanned: number; buy: number; sell: number; no_data: number; error: number }>;
}> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStr = todayStart.toISOString().slice(0, 10);

  const [totalRow, scannedRow, buyRow, sellRow, errRow, noDataRow, usPermErrRow] = await Promise.all([
    db.prepare('SELECT COUNT(*) as cnt FROM stock_universe WHERE is_active=1').first<{cnt:number}>(),
    db.prepare(`SELECT COUNT(*) as cnt FROM stock_universe WHERE is_active=1 AND last_scanned_at >= ?`).bind(todayStr).first<{cnt:number}>(),
    db.prepare(`SELECT COUNT(*) as cnt FROM stock_universe WHERE last_signal='BUY' AND last_scanned_at >= ?`).bind(todayStr).first<{cnt:number}>(),
    db.prepare(`SELECT COUNT(*) as cnt FROM stock_universe WHERE last_signal='SELL' AND last_scanned_at >= ?`).bind(todayStr).first<{cnt:number}>(),
    // ERROR 계열 전체 (ERROR_US_MARKET_DATA_PERMISSION 포함)
    db.prepare(`SELECT COUNT(*) as cnt FROM stock_universe WHERE last_signal LIKE 'ERROR%' AND last_scanned_at >= ?`).bind(todayStr).first<{cnt:number}>(),
    // NO_DATA
    db.prepare(`SELECT COUNT(*) as cnt FROM stock_universe WHERE last_signal='NO_DATA' AND last_scanned_at >= ?`).bind(todayStr).first<{cnt:number}>(),
    // 해외주식 시세 권한 없음
    db.prepare(`SELECT COUNT(*) as cnt FROM stock_universe WHERE last_signal='ERROR_US_MARKET_DATA_PERMISSION' AND last_scanned_at >= ?`).bind(todayStr).first<{cnt:number}>(),
  ]);

  const total    = totalRow?.cnt || 0;
  const scanned  = scannedRow?.cnt || 0;
  const buy      = buyRow?.cnt || 0;
  const sell     = sellRow?.cnt || 0;
  const errors   = errRow?.cnt || 0;
  const noData   = noDataRow?.cnt || 0;
  const usPermErr = usPermErrRow?.cnt || 0;
  // 정상 = 스캔 완료 - 매수 - 매도 - ERROR계열 - NO_DATA
  const normal   = Math.max(0, scanned - buy - sell - errors - noData);

  // 거래소별 통계
  const exchRows = await db.prepare(
    `SELECT exchange,
            COUNT(*) as total,
            SUM(CASE WHEN last_scanned_at >= ? THEN 1 ELSE 0 END) as scanned,
            SUM(CASE WHEN last_signal='BUY'     AND last_scanned_at >= ? THEN 1 ELSE 0 END) as buy,
            SUM(CASE WHEN last_signal='SELL'    AND last_scanned_at >= ? THEN 1 ELSE 0 END) as sell,
            SUM(CASE WHEN last_signal='NO_DATA' AND last_scanned_at >= ? THEN 1 ELSE 0 END) as no_data,
            SUM(CASE WHEN last_signal LIKE 'ERROR%' AND last_scanned_at >= ? THEN 1 ELSE 0 END) as error
     FROM stock_universe WHERE is_active=1 GROUP BY exchange`
  ).bind(todayStr, todayStr, todayStr, todayStr, todayStr)
   .all<{exchange:string;total:number;scanned:number;buy:number;sell:number;no_data:number;error:number}>();

  const byExchange: Record<string, {total:number;scanned:number;buy:number;sell:number;no_data:number;error:number}> = {};
  for (const r of (exchRows.results || [])) {
    byExchange[r.exchange] = {
      total: r.total, scanned: r.scanned,
      buy: r.buy, sell: r.sell,
      no_data: r.no_data, error: r.error,
    };
  }

  return {
    total, scanned_today: scanned, pending: total - scanned,
    normal_count: normal,
    no_data_count: noData,
    buy_signals: buy,
    sell_signals: sell,
    error_count: errors,
    us_permission_error_count: usPermErr,
    by_exchange: byExchange,
  };
}

/**
 * 매수/매도 신호 종목 조회
 */
export async function getSignalStocks(
  db: D1Database, signal: 'BUY' | 'SELL', limit = 50
): Promise<Array<{ticker:string;ticker_name:string;market:string;exchange:string;last_scanned_at:string}>> {
  const todayStr = new Date().toISOString().slice(0, 10);
  const rows = await db.prepare(
    `SELECT ticker, ticker_name, market, exchange, last_scanned_at
     FROM stock_universe
     WHERE last_signal = ? AND last_scanned_at >= ?
     ORDER BY last_scanned_at DESC LIMIT ?`
  ).bind(signal, todayStr, limit).all();
  return rows.results as Array<{ticker:string;ticker_name:string;market:string;exchange:string;last_scanned_at:string}>;
}

// ── KIS 마스터 파일로 전체 종목 로드 ──────────────────────────

export interface FullUniverseResult {
  total_inserted: number;
  total_updated: number;
  total_skipped: number;
  by_exchange: Record<string, number>;
  errors: string[];
  source: 'kis_master';
}

/**
 * KIS 마스터 파일에서 전체 종목을 DB에 로드한다.
 * - KOSPI: ~1,800종목 (6자리 코드 주식)
 * - KOSDAQ: ~1,800종목
 * - NASD: ~5,200종목 (주식+ETF)
 * - NYSE: ~2,900종목
 * - AMEX: ~4,500종목
 * 
 * 기존 임베드된 343종목은 그대로 유지 (UNIQUE 제약으로 중복 무시)
 * 새로 로드된 종목이 추가되고, 이름은 KIS 마스터 기준으로 업데이트
 * 
 * @param db  D1Database
 * @param markets  로드할 시장 목록 (기본: 전체)
 * @param includeETF  US ETF 포함 여부 (기본: true)
 */
export async function loadFullUniverseFromKIS(
  db: D1Database,
  markets: Array<'KOSPI'|'KOSDAQ'|'NASD'|'NYSE'|'AMEX'> = ['KOSPI','KOSDAQ','NASD','NYSE','AMEX'],
  includeETF = true
): Promise<FullUniverseResult> {
  const { fetchKRMasterStocks, fetchUSMasterStocks } = await import('./kis-api');
  const byExchange: Record<string, number> = {};
  const errors: string[] = [];
  let total_inserted = 0;
  let total_updated  = 0;
  let total_skipped  = 0;

  // 처리할 거래소가 1개라도 제한 이내로 처리
  for (const exch of markets) {
    try {
      let stocks: Array<{ ticker: string; ticker_name: string; market: 'KR' | 'US'; exchange: string }> = [];

      if (exch === 'KOSPI' || exch === 'KOSDAQ') {
        stocks = await fetchKRMasterStocks(exch);
      } else {
        stocks = await fetchUSMasterStocks(exch as 'NASD'|'NYSE'|'AMEX', includeETF);
      }

      // D1 batch API로 대량 UPSERT (INSERT OR REPLACE)
      // ticker + exchange UNIQUE 제약 활용 — 기존 row는 이름만 갱신
      // 500개씩 D1 batch — 1회 batch = 1 HTTP round-trip
      const BATCH = 500;
      let exchInserted = 0;
      let exchUpdated  = 0;

      for (let i = 0; i < stocks.length; i += BATCH) {
        const chunk = stocks.slice(i, i + BATCH);

        // D1 batch: statements 배열로 단일 트랜잭션 처리
        const stmts = chunk.map(s =>
          db.prepare(
            `INSERT INTO stock_universe (ticker, ticker_name, market, exchange)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(ticker, exchange) DO UPDATE SET
               ticker_name = excluded.ticker_name,
               is_active   = 1,
               updated_at  = CURRENT_TIMESTAMP`
          ).bind(s.ticker, s.ticker_name, s.market, s.exchange)
        );

        const results = await db.batch(stmts);
        for (const r of results) {
          const changes = r.meta?.changes ?? 0;
          if (changes > 0) {
            // changes=1: INSERT 또는 UPDATE (rows_written > rows_read = insert)
            exchInserted++;
          } else {
            exchUpdated++;
          }
        }
      }

      total_inserted += exchInserted;
      total_updated  += exchUpdated;
      byExchange[exch] = stocks.length;

    } catch (e) {
      const msg = `${exch} 로드 실패: ${e}`;
      errors.push(msg);
      byExchange[exch] = 0;
    }
  }

  // system_config 업데이트
  const now = new Date().toISOString();
  const krTotal = (byExchange['KOSPI']||0) + (byExchange['KOSDAQ']||0);
  const usTotal = (byExchange['NASD']||0) + (byExchange['NYSE']||0) + (byExchange['AMEX']||0);

  await db.batch([
    db.prepare("INSERT OR REPLACE INTO system_config (key, value, description) VALUES ('universe_loaded_at', ?, '종목 유니버스 마지막 로드 시각')").bind(now),
    db.prepare("INSERT OR REPLACE INTO system_config (key, value, description) VALUES ('universe_load_source', 'kis_master', '마지막 로드 소스')"),
    db.prepare("INSERT OR REPLACE INTO system_config (key, value, description) VALUES ('universe_load_date', ?, '마지막 종목 마스터 로드 날짜')").bind(now.slice(0,10)),
    db.prepare("INSERT OR REPLACE INTO system_config (key, value, description) VALUES ('universe_kr_count', ?, 'DB에 로드된 KR 종목 수')").bind(String(krTotal)),
    db.prepare("INSERT OR REPLACE INTO system_config (key, value, description) VALUES ('universe_us_count', ?, 'DB에 로드된 US 종목 수')").bind(String(usTotal)),
  ]);

  return { total_inserted, total_updated, total_skipped, by_exchange: byExchange, errors, source: 'kis_master' };
}

/**
 * DB의 실제 거래소별 종목 수 조회
 */
export async function getDBUniverseStats(db: D1Database): Promise<{
  total: number;
  by_exchange: Record<string, number>;
  kr_total: number;
  us_total: number;
  load_source: string;
  load_date: string;
  loaded_at: string;
}> {
  const rows = await db.prepare(
    `SELECT exchange, COUNT(*) as cnt FROM stock_universe WHERE is_active=1 GROUP BY exchange`
  ).all<{exchange:string; cnt:number}>();

  const by_exchange: Record<string, number> = {};
  let total = 0;
  for (const r of (rows.results||[])) {
    by_exchange[r.exchange] = r.cnt;
    total += r.cnt;
  }

  const cfgRows = await db.prepare(
    `SELECT key, value FROM system_config WHERE key IN ('universe_load_source','universe_load_date','universe_loaded_at')`
  ).all<{key:string;value:string}>();
  const cfg: Record<string,string> = {};
  (cfgRows.results||[]).forEach(r => { cfg[r.key] = r.value; });

  const kr_total = (by_exchange['KOSPI']||0) + (by_exchange['KOSDAQ']||0);
  const us_total = (by_exchange['NASD']||0) + (by_exchange['NYSE']||0) + (by_exchange['AMEX']||0);

  return {
    total, by_exchange, kr_total, us_total,
    load_source: cfg['universe_load_source'] || 'embedded',
    load_date:   cfg['universe_load_date'] || '',
    loaded_at:   cfg['universe_loaded_at'] || '',
  };
}
