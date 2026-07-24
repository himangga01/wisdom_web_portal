# 방문 통계 도입에 따른 개인정보처리방침 개정 문안

작성일: 2026-07-24 · 상태: 발행 대기(운영자 승인 필요) · 근거: `docs/architecture/first-party-analytics-plan.md` §3.7

방문 통계(쿠키리스 1st-party 비콘)는 동의 대상이 아니더라도 **개인정보처리방침에
자동 수집 항목·보존 기간·거부 방법 기재가 필요하다**(개인정보 보호법 제30조① +
시행령 제31조①). 아래 문안을 4개 로케일 privacy 문서에 새 섹션으로 추가하고,
`docs/operations/consent-publication.md` 절차대로 **새 bundle ID로 발행**한다
(privacy 문서만 바뀌어도 8개 문서 전체를 새 번들로 재발행).

## 추가 문안 (privacy 문서, 4로케일)

### ko

> **방문 통계의 자동 처리**
> 본 웹사이트는 쿠키나 이용자 단말 저장소를 사용하지 않습니다. 서비스 개선을 위한
> 이용 통계 작성 목적으로, 접속 시 브라우저가 전송하는 IP 주소와 브라우저 정보를
> 순간적으로 처리한 뒤 즉시 익명화(일 단위로 파기되는 무작위 값과 결합한 일방향
> 해시)하며, 원본은 어디에도 저장하지 않습니다. 익명 통계(일별 조회수·방문자 수,
> 페이지·유입 경로별 집계)는 25개월간 보관 후 삭제합니다. 브라우저의
> GPC(Global Privacy Control) 또는 DNT(Do Not Track) 신호를 켜면 통계 수집에서
> 제외됩니다.

### en

> **Automated visit statistics**
> This website uses no cookies and no browser storage. To produce usage
> statistics for service improvement, the IP address and browser information
> your browser transmits on access are processed momentarily and immediately
> anonymized (a one-way hash combined with a random value destroyed daily);
> the originals are never stored. Anonymous statistics (daily views and
> visitor counts, per-page and per-referrer aggregates) are kept for 25
> months and then deleted. Enable your browser's GPC (Global Privacy
> Control) or DNT (Do Not Track) signal to be excluded from collection.

### zh-Hans

> **自动化的访问统计**
> 本网站不使用 Cookie，也不使用浏览器存储。为改进服务而编制使用统计时，仅对
> 浏览器在访问时传输的 IP 地址和浏览器信息作瞬时处理并立即匿名化（与每日销毁
> 的随机值结合的单向哈希），原始数据不作任何存储。匿名统计（每日浏览量与访客
> 数、按页面及来源的汇总）保存 25 个月后删除。开启浏览器的 GPC（Global
> Privacy Control）或 DNT（Do Not Track）信号即可不参与统计收集。

### zh-Hant

> **自動化的訪問統計**
> 本網站不使用 Cookie，也不使用瀏覽器儲存空間。為改善服務而編製使用統計時，
> 僅對瀏覽器於連線時傳送的 IP 位址與瀏覽器資訊作瞬時處理並立即匿名化（與每日
> 銷毀的隨機值結合的單向雜湊），原始資料不作任何儲存。匿名統計(每日瀏覽量與
> 訪客數、依頁面及來源的彙總)保存 25 個月後刪除。開啟瀏覽器的 GPC(Global
> Privacy Control)或 DNT(Do Not Track)訊號即可不納入統計收集。

## 발행 절차 요약

1. 위 문안을 각 로케일 privacy 문서 본문에 추가한 새 번들을 `consent:seed`로 시드
   (새 bundle ID + 새 문서 버전, 8개 문서 전체).
2. 대표/개인정보 보호책임자의 문안 승인 기록.
3. `consent:activate --bundle <id> --confirm-sha <sha>` 후 발행 스냅숏 게시.

## 운영 개시 전 확인(법률 자문 권장)

`docs/architecture/first-party-analytics-plan.md` §3.7의 미해결 쟁점 4건:
EDPB Guidelines 2/2023 광의 해석, 당일 해시의 가명정보성, GDPR 역외적용
사실관계, IP 순간 처리에 대한 국내 판례 분열. 통계 기능은 이 확인과 병행
운영 가능하나, 확인 전에는 처리방침 개정을 우선 발행해 고지 의무를 충족한다.
