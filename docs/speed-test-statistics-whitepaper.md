# Speed-Test 統計取值白皮書

版本日期：2026-05-26  
參考實作：Ping Pong browser-based intranet speed test

## 摘要

這份白皮書說明一套可重複、可解釋、可移植的瀏覽器測速統計方法。它的設計目標不是只產生一個漂亮的平均速度，而是同時回答三個問題：

1. 穩定時，這條連線大約能提供多少吞吐能力？
2. 使用者實際體感中的低速段、掉速、尖峰和波動有多明顯？
3. 測試結果是否足夠可信，或應被視為 Wi-Fi、瀏覽器排程、伺服器負載、封包遺失或延遲造成的診斷線索？

本方法把主估計值與診斷指標分開。`Download` 與 `Upload` 主卡顯示的是 **stable mean**，也就是經過啟動段裁切與 IQR 離群值過濾後的穩定吞吐平均。另一方面，`P10`、`P50`、`P90`、`Raw CV`、`Stable CV`、`Samples kept`、`Jitter` 與 `HTTP Loss` 用來描述波動、低速體感、離群率與可靠性。

這種分工特別適合 browser-based intranet speed test。瀏覽器無法像專用網路探針一樣控制作業系統排程、網卡狀態、Wi-Fi RSSI、TCP stack 或背景流量，因此不應只看單一平均值。穩定吞吐平均可作為主要能力估計；低分位數與原始波動則保留為診斷訊號。

## 適用範圍與限制

本方法適用於以下情境：

- 使用瀏覽器向單一內網測速服務發出 download、upload、latency 請求。
- 測試目標是比較辦公室、門市、倉庫或其它內網端點的網路品質。
- 需要讓一般使用者也能產生 IT 可判讀的結果。
- 測試結果會保存到 API、資料庫或報告，並被其它專案引用。

本方法不等同於實驗室級測速：

- 瀏覽器 JavaScript timer、Web Worker、fetch stream、HTTP stack 都會受到排程與瀏覽器實作影響。
- Wi-Fi 結果包含無線環境、訊號品質、用戶端設備、干擾與省電機制，不只代表伺服器或有線網路。
- local self-test 是維護檢查，不是真實內網測速。若瀏覽器與伺服器在同一台機器上，結果主要驗證應用流程，不代表實際網路路徑。
- 所有統計指標都應與測試環境、連線類型、時間長度和樣本數一起解讀。

## 測試設定邏輯

### 測試模式

參考實作首頁固定提供兩種測試時間：

- `Quick 20s`：預設模式。適合快速檢查，20 秒通常能取得約 76 筆 post-warmup throughput samples。
- `Full 30s`：較完整模式。適合正式診斷，30 秒通常能取得約 116 筆 post-warmup throughput samples。

這兩個模式只改變保存結果中的 `durationSeconds`。不需要新增 `quick` 或 `full` schema 欄位，因為秒數本身已能描述測試長度。

Admin 或 runtime 設定中的 default duration 仍可保留為 fallback 或 legacy setting。首頁的正式使用者流程固定以 20 秒與 30 秒為入口，避免不同使用者用不同秒數產生難以比較的結果。

### Throughput sampling interval

**Throughput sampling interval** 是每一筆吞吐 sample 覆蓋的時間窗。參考實作使用 250 ms。

250 ms 的設計理由：

- 太短的時間窗容易放大 JavaScript 排程、HTTP chunk 到達時間、瀏覽器事件 loop 和 TCP burst 的雜訊。
- 太長的時間窗會掩蓋短暫掉速，降低低速段診斷能力。
- 250 ms 在 20 到 30 秒測試中能產生足夠樣本，同時維持可解釋的時間解析度。

增加樣本數時，優先增加測試時間，而不是縮短 sampling interval。縮短 interval 會提高樣本自相關與排程雜訊，不一定提高統計品質。

### Warmup

**Warmup** 是測試開始後不納入吞吐統計的初始時間。參考實作使用最多 1 秒：

```text
warmupMs = min(1000, durationMs / 3)
```

Warmup 的用途是避開剛建立 request、TCP congestion window 尚未穩定、stream reader 剛啟動、upload buffer 剛排入瀏覽器網路層時的偏差。Warmup 不是離群值過濾，而是時間軸上的固定前段排除。

### Parallel connections

**Parallel connections** 是測速時同時進行的 download 或 upload worker 數量。Standard profile 使用 runtime 設定，例如 4 條。Local throttled profile 使用 1 條。

多連線可較接近使用者實際下載大型檔案或多資源網頁時的 throughput，但也更容易對伺服器和網路造成壓力。白皮書建議保存結果時一律保存 `parallelConnections`，因為 1 條與 4 條連線的吞吐結果不可直接視為同一測試條件。

### Download 與 Upload chunk

參考實作的 Standard profile：

- Download chunk：16 MB per request。
- Upload chunk：256 KB per request。

Download 使用較大 chunk，因為 response body 可 streaming 讀取，並持續累加 bytes。Upload 使用較小 chunk，因為瀏覽器 fetch upload body 不同於 download stream；較小 payload 讓固定測試時間內能完成更多 upload request，保留更多可觀察的 upload samples。

### Local throttled profile

**Local throttled profile** 是 local self-test 的維護模式。它只在偵測到 local client 且允許 local self-test 時啟用。參考設定：

- `maxMbps = 32`
- `parallelConnections = 1`
- `downloadChunkBytes = 262144`
- `uploadChunkBytes = 131072`

這個 profile 的目的不是測網路能力，而是讓本機維護測試可以完成，不讓瀏覽器 tab 或本機網路 stack 被高速 loopback 流量壓垮。保存結果與報告必須標示 `Local throttled`，避免誤判成真實內網速度。

## 取樣資料生命週期

整體資料流程如下：

```text
raw transfer bytes
  -> post-warmup throughput samples
  -> startup trim
  -> percentile / IQR / CV
  -> stable mean, diagnostic indicators
  -> saved result, report, current-run raw data popup
```

### 1. Raw transfer bytes

**Raw transfer bytes** 是瀏覽器在測試期間實際下載或上傳的 byte 數。Byte 是資料量單位，1 byte = 8 bits。

Download 會在 response stream 中讀取 chunk，warmup 之後的 bytes 才進入 measurement bytes 與 throughput sample。Upload 會在 request 完成後計入 payload bytes，且 request 必須在 warmup 後開始並在測試結束前完成。

### 2. Mbps 轉換

每一筆 throughput sample 用 bytes 與 elapsed milliseconds 轉成 Mbps：

```text
Mbps = bytes * 8 / (elapsedMs / 1000) / 1,000,000
```

**Mbps** 是 megabits per second，每秒百萬 bits。它是速度或吞吐率。  
**Mb** 是 megabits，百萬 bits。它是資料量，不是速度。

因此：

- `Download 500 Mbps` 表示速率。
- `Total Download 8000 Mb` 表示本次測試累積資料量。

### 3. Post-warmup samples

**Sample** 是一筆固定時間窗內的吞吐觀察值，例如 250 ms 內累積的 bytes 轉成 Mbps。Post-warmup samples 是 warmup 結束後產生的樣本集合。

參考實作中的 `sampleCount` 指的是 startup trim 之後、IQR 過濾之前的樣本數。它不是所有 raw samples 的總數，因為 startup samples 已經被排除。

### 4. Startup trim

**Startup trim** 是按比例移除 post-warmup samples 的最前段，用來取代固定只丟第一筆的做法。

公式：

```text
startupDiscardCount =
  n <= 1 ? 0 : min(n - 1, max(1, ceil(n * 0.03)))
```

其中 `n` 是 post-warmup samples 數量。

這個設計有三個重點：

- `ceil(n * 0.03)`：丟掉前 3%，測試越長，啟動段排除數越合理增加。
- `max(1, ...)`：只要有超過 1 筆 sample，至少丟 1 筆，避免第一個測量窗偏差。
- `min(n - 1, ...)`：至少保留 1 筆 sample，避免結果完全沒有資料。

常見樣本數：

| Post-warmup raw samples | Startup discard | Startup-trimmed sampleCount |
|---:|---:|---:|
| 1 | 0 | 1 |
| 50 | 2 | 48 |
| 76 | 3 | 73 |
| 100 | 3 | 97 |
| 116 | 4 | 112 |

### 5. Percentile

**Percentile** 是分位數。P10 表示排序後約有 10% 樣本小於或等於該值；P50 是中位數，也就是典型值；P90 表示高段能力。

參考實作使用線性插值：

```text
rank = (sorted.length - 1) * percentile / 100
lowerIndex = floor(rank)
upperIndex = ceil(rank)
value = lower + (upper - lower) * (rank - lowerIndex)
```

分位數在 startup-trimmed samples 上計算，且在 IQR 過濾之前計算。這是刻意設計：P10 應保留低速體感，P90 應保留高段能力；若先做 IQR 過濾，這些診斷訊號會被削弱。

### 6. Q1、Q3、IQR 與 fence

**Q1** 是 P25，也就是第一四分位數。  
**Q3** 是 P75，也就是第三四分位數。  
**IQR** 是 interquartile range，四分位距：

```text
IQR = Q3 - Q1
```

**IQR fence** 是離群值判斷邊界：

```text
lowerFence = Q1 - 1.5 * IQR
upperFence = Q3 + 1.5 * IQR
```

低於 lowerFence 或高於 upperFence 的樣本稱為 IQR outlier。IQR 過濾不假設資料服從常態分布，因此比平均值加減標準差更適合網路 throughput 這種可能偏態、尖峰、掉速的資料。

參考實作中，若可用樣本少於 4 筆，IQR fence 不啟用，因為樣本太少時四分位距不穩定。

### 7. Stable mean

**Arithmetic mean** 是算術平均：

```text
mean = sum(values) / count(values)
```

**Stable mean** 是 startup-trimmed samples 經 IQR 過濾後的 arithmetic mean。它是 `Download` 與 `Upload` 主卡的主要速度值。

若 IQR 過濾後完全沒有樣本，則 fallback 到 startup-trimmed samples 的平均。這是安全防護，避免極端資料使主值無法計算。

### 8. Standard deviation 與 CV

**Standard deviation** 是標準差，用來衡量資料離平均值的距離。參考實作使用 population standard deviation：

```text
mean = sum(values) / n
variance = sum((value - mean)^2) / n
standardDeviation = sqrt(variance)
```

**Coefficient of variation** 簡稱 CV，變異係數：

```text
CV% = standardDeviation / mean * 100
```

CV 用百分比描述相對波動。這比單看標準差更適合比較不同速度等級。例如 20 Mbps 的 10 Mbps 標準差非常嚴重，但 900 Mbps 的 10 Mbps 標準差通常很小。

本方法使用兩種 CV：

- **Raw CV**：startup trim 後、IQR 過濾前的 CV。它保留掉速與尖峰，適合反映 Wi-Fi 波動。
- **Stable CV**：IQR 過濾後的 CV。它描述 stable mean 所依據的穩定段本身是否集中。

嚴格來說，Raw CV 不是包含 startup samples 的全原始 CV，而是 `post-startup raw CV`。命名保留 Raw，是因為它相對於 stable mean 沒有做 IQR 過濾。

### 9. Latency、jitter 與 HTTP loss

**Latency** 是請求往返耗時，單位 ms。Idle latency 在 throughput 測試前測量；loaded latency 在 download/upload 同時測量。

**Jitter** 是相鄰 latency samples 的變化程度。參考實作把相鄰 latency 差值取絕對值，再取平均：

```text
jitter = mean(abs(latency[i] - latency[i - 1]))
```

**HTTP loss** 是測試期間 latency request 失敗比例：

```text
HTTP loss% = failedAttempts / sentAttempts * 100
```

Latency median 會使用 IQR 過濾後的 latency samples；失敗 latency attempts 不進入 median，但會計入 HTTP loss。

## 指標判讀規則

### Download / Upload

主 `Download` 與 `Upload` 顯示 stable mean。它回答的是「這條連線在排除啟動偏差與明顯離群後，大致能穩定提供多少 throughput」。

這不是單純全樣本平均，也不是 P10。主值不採 P10，是因為 P10 代表低速體感，容易過度悲觀；主值也不採 raw mean，是因為 raw mean 容易被短暫尖峰或掉速拉動。

### P10 Low

P10 是低速段指標。若 P10 遠低於 stable mean，代表使用者可能感受到卡頓、掉速或 Wi-Fi 重傳，即使 stable mean 看起來很好。

### P50 Typical

P50 是典型值，也就是 median。它比 mean 不容易受極端值影響，適合回答「多數時間大約落在哪裡」。

### P75 Upper 與 P90 High

P75 與 P90 描述高段能力。它們可協助判斷連線是否偶爾能衝到高 throughput，但不能單獨代表穩定品質。

### Samples kept

`Samples kept` 顯示：

```text
filteredSampleCount / sampleCount
```

其中：

- `sampleCount`：startup trim 後、IQR 前的樣本數。
- `filteredSampleCount`：IQR 過濾後用於 stable mean 與 Stable CV 的樣本數。

如果 kept 比例很低，代表資料中有大量離群點。這不一定表示測試錯誤，但表示結果更像診斷事件，而不是單純穩定能力測量。

## Completion Summary 判讀邏輯

Completion Summary 的設計是 stability-first。它先看可靠性、穩定性、反應性，再看速度。速度仍然是重要 tile，但只有在速度落到 unusable tier 時才成為主要限制。

### Reliability

Reliability 使用 HTTP loss：

| HTTP loss | Grade |
|---:|---|
| 0% | excellent |
| <= 0.5% | good |
| <= 2% | fair |
| > 2% | poor |

Reliability 是最優先的診斷之一，因為封包或 HTTP request 失敗會破壞所有速度與延遲解讀。

### Stability

Stability 使用四個子指標，取最差 grade：

| 子指標 | Excellent | Good | Fair | Poor |
|---|---:|---:|---:|---:|
| Raw CV | <= 10% | <= 20% | <= 35% | > 35% |
| P10/Mean ratio | >= 85% | >= 70% | >= 50% | < 50% |
| IQR outlier rate | <= 2% | <= 5% | <= 10% | > 10% |
| Jitter | <= 5 ms | <= 15 ms | <= 30 ms | > 30 ms |

**P10/Mean ratio** 是 P10 除以 stable mean：

```text
P10/Mean ratio = P10 / stableMean
```

它衡量低速段相對於主速度值有多低。若 ratio 很低，即使 stable mean 很高，使用者仍可能感受到明顯掉速。

**IQR outlier rate** 是被 IQR 排除的比例：

```text
outlierRate = (sampleCount - filteredSampleCount) / sampleCount * 100
```

它衡量資料中有多少樣本落在穩定分布之外。

### Responsiveness

Responsiveness 使用 loaded latency，也就是測速流量同時存在時的 latency：

| Loaded latency | Grade |
|---:|---|
| <= 50 ms | excellent |
| <= 100 ms | good |
| <= 200 ms | fair |
| > 200 ms | poor |

Loaded latency 比 idle latency 更能反映真實使用情境，因為使用者通常在網路載入時才感到延遲。

### Speed Tier

Speed Tier 使用 download 與 upload stable mean 的較低者作為 floor：

```text
speedFloor = min(downloadStableMean, uploadStableMean)
```

參考預設 tier：

| Tier | Mbps range | Grade |
|---|---:|---|
| Idle | 0 | poor |
| Walk | 0 - 50 | poor |
| Jog | 50 - 200 | fair |
| Run | 200 - 800 | good |
| Sprint | >= 800 | excellent |

若 download 與 upload 差距很大，summary 會標示 limiting side。若低速方向除以高速方向小於或等於 80%，視為 download-limited 或 upload-limited；否則視為 balanced。

## 100 Samples 對照範例

以下兩組範例都使用 100 筆 Mbps samples。每筆 sample 已是 throughput sample，不再展示 bytes 與 elapsedMs 換算。兩組資料都使用相同演算法：

```text
startupDiscardCount = ceil(100 * 0.03) = 3
sampleCount = 100 - 3 = 97
```

### 範例 A：穩定有線樣本

前 3 筆 startup samples 為 650、700、730 Mbps。這三筆在 startup trim 階段排除，不進入 percentile、IQR、Raw CV 或 Stable CV。

Startup trim 後的 97 筆樣本結果：

| 指標 | 值 |
|---|---:|
| Q1 | 917 Mbps |
| Q3 | 924 Mbps |
| IQR | 7 Mbps |
| IQR lower fence | 906.5 Mbps |
| IQR upper fence | 934.5 Mbps |
| sampleCount | 97 |
| filteredSampleCount | 97 |
| IQR outliers | 0 |
| Stable Mean | 920.39 Mbps |
| P10 | 915.6 Mbps |
| P50 | 920 Mbps |
| P75 | 924 Mbps |
| P90 | 925.4 Mbps |
| Raw CV | 0.4% |
| Stable CV | 0.4% |
| Outlier rate | 0% |
| P10/Mean ratio | 99.48% |

判讀：這組資料高度穩定。Raw CV 與 Stable CV 幾乎相同，代表 IQR 過濾前後分布一致；P10/Mean ratio 接近 100%，代表低速段幾乎沒有掉速。這種結果可以把 stable mean 視為可信主估計值。

### 範例 B：Wi-Fi 波動樣本

前 3 筆 startup samples 為 120、160、220 Mbps。這三筆排除後，保留 97 筆做分位數、IQR、Raw CV 與 Stable CV。

Startup trim 後的 97 筆樣本結果：

| 指標 | 值 |
|---|---:|
| Q1 | 490 Mbps |
| Q3 | 600 Mbps |
| IQR | 110 Mbps |
| IQR lower fence | 325 Mbps |
| IQR upper fence | 765 Mbps |
| sampleCount | 97 |
| filteredSampleCount | 82 |
| IQR outliers | 15 |
| Stable Mean | 549.57 Mbps |
| P10 | 262 Mbps |
| P50 | 520 Mbps |
| P75 | 600 Mbps |
| P90 | 667 Mbps |
| Raw CV | 30.52% |
| Stable CV | 14.89% |
| Outlier rate | 15.46% |
| P10/Mean ratio | 47.67% |

IQR 排除的 outliers：

```text
310, 290, 270, 250, 230, 210, 190, 170, 150, 130, 110, 90, 70, 820, 900
```

判讀：這組資料的 stable mean 是 549.57 Mbps，看起來仍不低；但 P10 只有 262 Mbps，P10/Mean ratio 只有 47.67%，outlier rate 達 15.46%。這表示使用者可能感受到明顯掉速。Raw CV 30.52% 高於 Stable CV 14.89%，代表 IQR 過濾移除了部分波動，但原始 post-startup 資料本身仍不穩定。這種結果應被視為 Wi-Fi 或共享媒介波動診斷，而不是單純說「平均速度 550 Mbps 很好」。

### 兩組樣本完整表

狀態定義：

- `startup-excluded`：startup trim 排除，不進入 percentile、IQR、Raw CV、Stable CV、Stable Mean。
- `used`：保留並用於 percentile、Raw CV、Stable CV、Stable Mean。
- `iqr-excluded`：保留於 percentile 與 Raw CV，但不進入 Stable Mean 與 Stable CV。

| # | Stable wired Mbps | Stable wired status | Wi-Fi variable Mbps | Wi-Fi variable status |
|---:|---:|---|---:|---|
| 1 | 650 | startup-excluded | 120 | startup-excluded |
| 2 | 700 | startup-excluded | 160 | startup-excluded |
| 3 | 730 | startup-excluded | 220 | startup-excluded |
| 4 | 920 | used | 510 | used |
| 5 | 924 | used | 505 | used |
| 6 | 917 | used | 500 | used |
| 7 | 926 | used | 495 | used |
| 8 | 915 | used | 520 | used |
| 9 | 922 | used | 530 | used |
| 10 | 918 | used | 540 | used |
| 11 | 925 | used | 515 | used |
| 12 | 916 | used | 505 | used |
| 13 | 921 | used | 500 | used |
| 14 | 920 | used | 490 | used |
| 15 | 924 | used | 485 | used |
| 16 | 917 | used | 500 | used |
| 17 | 926 | used | 510 | used |
| 18 | 915 | used | 520 | used |
| 19 | 922 | used | 515 | used |
| 20 | 918 | used | 505 | used |
| 21 | 925 | used | 495 | used |
| 22 | 916 | used | 500 | used |
| 23 | 921 | used | 505 | used |
| 24 | 920 | used | 480 | used |
| 25 | 924 | used | 470 | used |
| 26 | 917 | used | 490 | used |
| 27 | 926 | used | 510 | used |
| 28 | 915 | used | 530 | used |
| 29 | 922 | used | 550 | used |
| 30 | 918 | used | 540 | used |
| 31 | 925 | used | 520 | used |
| 32 | 916 | used | 500 | used |
| 33 | 921 | used | 490 | used |
| 34 | 920 | used | 450 | used |
| 35 | 924 | used | 430 | used |
| 36 | 917 | used | 410 | used |
| 37 | 926 | used | 390 | used |
| 38 | 915 | used | 370 | used |
| 39 | 922 | used | 350 | used |
| 40 | 918 | used | 330 | used |
| 41 | 925 | used | 310 | iqr-excluded |
| 42 | 916 | used | 290 | iqr-excluded |
| 43 | 921 | used | 270 | iqr-excluded |
| 44 | 920 | used | 250 | iqr-excluded |
| 45 | 924 | used | 230 | iqr-excluded |
| 46 | 917 | used | 210 | iqr-excluded |
| 47 | 926 | used | 190 | iqr-excluded |
| 48 | 915 | used | 170 | iqr-excluded |
| 49 | 922 | used | 150 | iqr-excluded |
| 50 | 918 | used | 130 | iqr-excluded |
| 51 | 925 | used | 110 | iqr-excluded |
| 52 | 916 | used | 90 | iqr-excluded |
| 53 | 921 | used | 70 | iqr-excluded |
| 54 | 920 | used | 520 | used |
| 55 | 924 | used | 525 | used |
| 56 | 917 | used | 530 | used |
| 57 | 926 | used | 535 | used |
| 58 | 915 | used | 540 | used |
| 59 | 922 | used | 545 | used |
| 60 | 918 | used | 550 | used |
| 61 | 925 | used | 555 | used |
| 62 | 916 | used | 560 | used |
| 63 | 921 | used | 565 | used |
| 64 | 920 | used | 570 | used |
| 65 | 924 | used | 575 | used |
| 66 | 917 | used | 580 | used |
| 67 | 926 | used | 585 | used |
| 68 | 915 | used | 590 | used |
| 69 | 922 | used | 595 | used |
| 70 | 918 | used | 600 | used |
| 71 | 925 | used | 605 | used |
| 72 | 916 | used | 610 | used |
| 73 | 921 | used | 615 | used |
| 74 | 920 | used | 620 | used |
| 75 | 924 | used | 625 | used |
| 76 | 917 | used | 630 | used |
| 77 | 926 | used | 635 | used |
| 78 | 915 | used | 640 | used |
| 79 | 922 | used | 645 | used |
| 80 | 918 | used | 650 | used |
| 81 | 925 | used | 655 | used |
| 82 | 916 | used | 660 | used |
| 83 | 921 | used | 665 | used |
| 84 | 920 | used | 670 | used |
| 85 | 924 | used | 675 | used |
| 86 | 917 | used | 680 | used |
| 87 | 926 | used | 685 | used |
| 88 | 915 | used | 690 | used |
| 89 | 922 | used | 695 | used |
| 90 | 918 | used | 700 | used |
| 91 | 925 | used | 760 | used |
| 92 | 916 | used | 820 | iqr-excluded |
| 93 | 921 | used | 900 | iqr-excluded |
| 94 | 920 | used | 480 | used |
| 95 | 924 | used | 500 | used |
| 96 | 917 | used | 520 | used |
| 97 | 926 | used | 540 | used |
| 98 | 915 | used | 560 | used |
| 99 | 922 | used | 580 | used |
| 100 | 918 | used | 600 | used |

## 通用化建議

其它專案可以調整參數，但應保留資料語意分離：

- 測試時間可依產品情境設定，但應固定常用 profile，避免使用者任意秒數造成不可比。
- Sampling interval 可調整，但應記錄在文件與結果版本中。若縮短 interval，必須重新評估排程雜訊與樣本自相關。
- Startup trim ratio 可調整，但建議使用比例而不是固定筆數。
- IQR multiplier 可調整，常見值為 1.5。若改為 3.0，會更保守地排除離群值；若低於 1.5，可能過度排除真實波動。
- Stability threshold 可依網路環境調整，但 Raw CV、P10/Mean、outlier rate、jitter 應分開保存，避免只留一個不可追溯的 stability score。
- 主速度值應維持 stable mean 或同等穩定主估計值；低速體感應用 P10 或類似分位數呈現，不建議把主速度直接改成 P10。
- Raw samples 若要保存，需另行考慮資料量、隱私與 retention。參考實作只在當次瀏覽器記憶體保留 raw samples，不寫入 SQLite。

## 參考實作資料介面

以下欄位是參考實作的資料語意，不要求其它專案完全採用相同命名，但建議保留等價資訊：

- `durationSeconds`：測試秒數，例如 20 或 30。
- `parallelConnections`：有效並行連線數。
- `networkLinkType`：使用者選擇的 `wired`、`wifi` 或 legacy `unknown`。
- `testProfile`：`standard` 或 `local-throttled`。
- `downloadStats` / `uploadStats`：包含 stable mean、percentiles、Raw CV、Stable CV 與 sample counts。
- `sampleCount`：startup trim 後、IQR 前樣本數。
- `filteredSampleCount`：IQR 後保留樣本數。
- `rawCvPercent`：startup trim 後、IQR 前 CV。
- `cvPercent`：IQR 後 Stable CV。

Legacy payload 若沒有 `rawCvPercent`，可用 `cvPercent` 回填，以維持舊資料可讀性。但新資料應同時保存 Raw CV 與 Stable CV。

## 名詞表

| 名詞 | 說明 |
|---|---|
| Arithmetic mean | 算術平均，所有值相加後除以數量。 |
| Browser-based speed test | 在瀏覽器中透過 JavaScript、Web Worker、fetch 和 HTTP endpoint 進行的測速。 |
| Byte | 資料量單位，1 byte = 8 bits。 |
| Coefficient of variation, CV | 變異係數，標準差除以平均值後轉成百分比，用來描述相對波動。 |
| Download | 從伺服器到瀏覽器的資料傳輸方向。 |
| Filtered sample count | IQR 過濾後保留下來、用於 stable mean 的樣本數。 |
| HTTP loss | latency request 失敗比例，用來表示測試期間 HTTP 層可觀察到的失敗率。 |
| IQR | Interquartile range，四分位距，等於 Q3 - Q1。 |
| IQR fence | Q1 - 1.5 * IQR 到 Q3 + 1.5 * IQR 的離群值判斷範圍。 |
| IQR outlier | 落在 IQR fence 外的樣本。 |
| Jitter | 相鄰 latency samples 變化量的平均，用來描述延遲穩定性。 |
| Latency | 一次 request 往返花費的時間，通常用 ms。 |
| Loaded latency | Download 或 upload 負載同時存在時測得的 latency。 |
| Local throttled | 本機維護測試 profile，使用限速與較小 payload，不能代表真實內網速度。 |
| Mb | Megabit，百萬 bits，資料量單位。 |
| Mbps | Megabits per second，每秒百萬 bits，吞吐率單位。 |
| P10 | 第 10 百分位數，低速段指標。 |
| P50 | 第 50 百分位數，中位數或典型值。 |
| P75 | 第 75 百分位數，高於典型值的上段指標。 |
| P90 | 第 90 百分位數，高段能力指標。 |
| Parallel connections | 同時進行的 download 或 upload request workers 數量。 |
| Percentile | 分位數，用排序後的位置描述資料分布。 |
| Population standard deviation | 以 n 為分母的標準差，適合描述本次觀察樣本集合本身。 |
| Post-warmup samples | Warmup 結束後產生的 throughput samples。 |
| Q1 | 第一四分位數，即 P25。 |
| Q3 | 第三四分位數，即 P75。 |
| Raw CV | Startup trim 後、IQR 過濾前的 CV，用來觀察原始波動。 |
| Raw transfer bytes | 測試期間實際傳輸的 byte 數。 |
| Sample | 固定時間窗內的一筆吞吐觀察值。 |
| Sample count | Startup trim 後、IQR 前的樣本數。 |
| Sampling interval | 每筆 throughput sample 覆蓋的時間窗。 |
| Stable CV | IQR 過濾後資料的 CV，用來描述穩定段離散程度。 |
| Stable mean | Startup trim 並經 IQR 過濾後的 arithmetic mean，是主速度值。 |
| Standard profile | 一般非本機維護測試 profile。 |
| Startup trim | 按比例丟棄 post-warmup 前段 samples，以移除啟動偏差。 |
| Throughput | 單位時間內完成的資料傳輸量，常用 Mbps 表示。 |
| Upload | 從瀏覽器到伺服器的資料傳輸方向。 |
| Warmup | 測試開始後固定不納入吞吐統計的初始時間。 |

