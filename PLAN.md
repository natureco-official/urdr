# PLAN.md — Urðr: tüm bulguları düzelt + tüm önerileri uygula (v2, Same Page Meeting round 1 sonrası)

**Core Focus:** ISSUES.md'deki (iki bağımsız incelemenin birleşik listesi) TÜM bug'ları düzelt ve TÜM önerilen özellikleri uygula, ardından gerekli testleri yaz/çalıştır. Kullanıcı kapsamı açıkça onayladı.

**Round 1 değişiklikleri (bkz. SAME-PAGE-LOG.md):** Rock 7 kademeli alt-adımlara bölündü (ne baştan ne sondan — schema/migrator erken, lint/search/compiler sonra taşınır, MCP en son). Heartbeat fikri terk edildi (senkron writer'da çalışmaz), OS-tabanlı kilit/lease-keeper'a geçildi. YENİ Rock 0: tüm bileşenlerin paylaştığı tek kanonik parser modülü.

---

## Rock 0 — Paylaşılan Markdown parser/leaf-grammar modülü (YENİ, temel)

**Done looks like:** `scripts/lib/markdown-model.mjs` (veya benzeri) — TEK kanonik parser:
- Çok satırlı HTML yorumlarını (`<!--...-->` blok) doğru atlıyor.
- Gerçek "leaf" birimini tanımlıyor (continuation satırları, nested list, table, blockquote, code-fence dahil — tek dolu satır değil).
- EN (`_No entries yet._`) VE TR (`_Henüz kayıt yok._`) placeholder'ları tanıyor.
- Sadece parser'ın TANIDIĞI heading node'larını (code-fence dışında) "başlık" sayıyor — ham "##" substring değil.
- `search.mjs`, `append.mjs`, `lint.mjs` bu modülü kullanacak şekilde REFACTOR edilir (regex kopyalarını kaldırır).
**Proof:** Golden fixture testleri — çok satırlı yorum, çok satırlı leaf, nested markdown, CRLF, her iki placeholder, tam beklenen "parsed leaf" snapshot'ları. `node scripts/lint.mjs ./templates` → 0 sahte uyarı.

## Rock 1 — Concurrency & durability (revize)

**Done looks like:**
- Heartbeat YERİNE: OS-tabanlı kilit (ör. Node `proper-lockfile` deseni veya benzeri, platform-native) VEYA ayrı bir lease-keeper alt-process; sahiplik bağımsız süreçlerle test edilebilir (owner-token, renewal-failure, PID-reuse, çalınma, eski-sahip-release senaryoları).
- `rootFile`: realpath-tabanlı confinement — hedef ve üst dizin resolve edilip memory dizininin GERÇEKTEN altında kaldığı doğrulanıyor (symlink/absolute-path/case-trick bypass'ları kapatılıyor), sadece "../" substring reddi DEĞİL.
- `leafText`: Rock 0'ın parser'ı üzerinden SADECE gerçek heading node enjeksiyonu reddediliyor (code-fence içindeki "##" veya düz metin serbest).
- Atomic write: rename öncesi fsync + directory fsync, Windows'a özgü atomic-replace davranışı, hata durumunda temp dosya temizleniyor, orijinal dosya mode/ACL korunuyor.
**Dosyalar:** `scripts/append.mjs`, YENİ `scripts/lib/lock.mjs`
**Proof:** Bağımsız süreçlerle kilit-çalma/yenileme-hatası/PID-tekrarı testleri; path-traversal (symlink dahil) ve header-injection için negatif testler; fault-injection (rename ortasında kesinti) testi.

## Rock 2 — migrate.sh / init.sh / check-growth.sh (revize)

**Done looks like:**
- `check-growth.sh` **KILL** — tamamen kaldırılıyor, TÜM referansları (protocols, integrations, examples) `lint.mjs`'e güncelleniyor.
- `migrate.sh` Node'a taşınıyor (`scripts/migrate.mjs`), Rock 0'ın parser'ını ve transaction katmanını kullanıyor (sed/awk mutasyonu yok). `split` non-interactive/plan-file modu alıyor (CI'da test edilebilir). `move` artık açık kaynak+hedef (root VE dal) parametresi alıyor, içeriği GERÇEKTEN hedef dalın içine ekliyor. `new-root` bir sonraki boş root numarasını dinamik buluyor (`root-4-*` hardcode değil), kaynaktan İÇERİĞİ SİLİYOR (kopyalamıyor — single-primary korunuyor), index/referansları AYNI transaction'da güncelliyor, kısmi hatada rollback yapıyor.
- `init.sh`: preflight-all-then-commit semantiği (hepsini kontrol et, sonra hepsini uygula); `--force` geri-alınabilir backup ile; `--lang` artık İKİ PARALEL AĞAÇ üretmiyor — dil sunum/isimlendirme tercihi, TEK birincil ağaç + alias'lar (`--lang both` kaldırılıyor veya "iki dilde alias dosyaları, tek gerçek kaynak" olarak yeniden tanımlanıyor). Nested-repo tespiti `git rev-parse --show-toplevel` ile; git kimliği yoksa/worktree ise/parent repo varsa konservatif davranış.
**Dosyalar:** YENİ `scripts/migrate.mjs` (eski `migrate.sh` kaldırılır), `scripts/init.sh`, `scripts/check-growth.sh` (silinir), tüm `protocols/*.md` ve `integrations/**` referansları
**Proof:** split/move/new-root için golden before/after migration testleri (plan-file modu üzerinden, CI'da tekrarlanabilir). init.sh için: var-olan-dosya-üzerine-yazmama, geçersiz `--lang` reddi, nested-repo/git-kimliği-yok senaryoları.

## Rock 3 — Lint tamlığı + CI sertleştirme (revize)

**Done looks like:**
- 2-hop `bkz:` zincir derinliği: Rock 0/6'nın kanonik referans grameri üzerinden (serbest metin parse yerine) uygulanıyor.
- Cross-root duplicate: token-index candidate generation (O(n²) pairwise DEĞİL), yapısal referans/bkz: leaf'leri "duplicate" olarak İŞARETLENMİYOR.
- CI: `--fail-on-warn` AÇIK bir bayrak/politika olarak tanımlanıyor (blanket "her warning fail" değil), golden-fixture/snapshot testleriyle doğrulanıyor. `actionlint` + gerçek bash testleri Linux/macOS runner'larında, Node tool'lar için Windows coverage'ı da var. Otomatik bir dokümantasyon link/referans/komut kontrolcüsü ekleniyor (README ve protocols'taki ölü referansları yakalıyor).
**Dosyalar:** `scripts/lint.mjs`, `.github/workflows/ci.yml`, YENİ `scripts/lib/doc-check.mjs`
**Proof:** Yeni kontrollerin gerçek kırık referans/duplicate senaryolarında doğru çalıştığı golden-fixture testleriyle gösteriliyor.

## Rock 4 — Dokümantasyon + entegrasyon tutarlılığı (revize)

**Done looks like:**
- README'deki `kók-*` → `kök-*`, var olmayan dosya referansları (protocols/mimari.md, examples/project-tracking, examples/technical-reference) kaldırılıyor (Rock 3'ün doc-check'i bunu garanti ediyor).
- TÜM entegrasyonlar (Hermes VE NatureCo — ikisi de tüm root'ları başlangıçta yüklüyor, sadece Hermes değil) root-0 + pending/personality başlangıç yüklemesi + gerektiğinde on-demand domain yüklemesi'ne hizalanıyor.
- OpenClaw: TEK belgelenen bootstrap eşlemesi (Root-1+Root-3 mi sadece Root-1 mi — biri seçiliyor, diğeri gerektiğinde explicit yükleniyor).
**Dosyalar:** `README.md`, `integrations/**`, `protocols/**`
**Proof:** doc-check.mjs (Rock 3) tüm referansları doğruluyor; entegrasyon dosyalarının kendi içinde tutarlı olduğu okuma ile teyit ediliyor.

## Rock 5 — Retrieval kalitesi + gerçek benchmark + telemetri (revize)

**Done looks like:**
- `search.mjs`: varsayılan LİTERAL arama (regex DEĞİL) — ReDoS riski varsayılan olarak ortadan kalkıyor. Regex sadece açık, sınırlı (zaman/kaynak limitli), doğrulanmış bir modda (`--regex`) kullanılabiliyor. BM25/trigram skorlama eklenıyor. Türkçe-farkında normalizasyon/ek analizi (generic typo tolerance DEĞİL, gerçek TR morfoloji).
- `bench.mjs`: ground truth artık stable-ID'lerle kuruluyor (Rock 6), sorgular gerçekçi ortak kelime dağarcığı paylaşıyor (benzersiz anahtar YOK). "Write fidelity" gerçek `append.mjs` çağrılarıyla ölçülüyor. "Hierarchy-only" iddiası dosya-okuma enstrümantasyonuyla (sadece ilgili dosyanın açıldığı assert edilerek) kanıtlanıyor. Concurrency/crash/replay/duplicate-event senaryoları ekleniyor.
- YENİ `scripts/telemetry.mjs`: varsayılan KAPALI (opt-in), payload'lar hash'lenmiş/minimize, `.gitignore`'da, rotate ediliyor, "hiç secret loglanmadığı" test ediliyor.
**Dosyalar:** `scripts/search.mjs`, `scripts/bench.mjs`, YENİ `scripts/telemetry.mjs`
**Proof:** Labeled relevance set + recall@k + precision + latency + bellek tavanı ile kabul kriterleri tanımlanmış karşılaştırmalı benchmark raporu (eski vs yeni metodoloji).

## Rock 6 — Event-log mimarisi: KADEMELİ (revize — ne baştan ne sondan)

**Aşama A (uyumluluk katmanı, erken):**
- Şema versiyonlama + idempotent Markdown import + stable-ID ataması (format/collision policy tanımlı, replay/rename/re-import test edilmiş) + backup + rollback.
- Append-only olay günlüğü (`.urdr/events.jsonl`): kanonik serialization, hash-chaining, commit record'ları, kesilme (truncation) kurtarma, fsync davranışı tanımlı ve test edilmiş.

**Aşama B (mevcut araçları taşı):**
- `lint.mjs`/`search.mjs`/Rock 6'nın compiler'ı event-log'u Rock 0'ın parser'ı üzerinden tüketecek şekilde uyarlanıyor.
- Çoklu-dosya yayın: TEK bir manifest/pointer-swap ile atomik hale getiriliyor (yarım-üretilmiş bir generation hiçbir okuyucuya görünmüyor, her crash noktasında test ediliyor).

**Aşama C (zengin metadata + politika):**
- `supersedes`/`derived-from`/`conflicts-with` ilişkileri.
- Provenance: doğrulanmış şema, boyut sınırı, redaksiyon/render güvenliği kuralları.
- Forgetting: append-only geçmişle ÇELİŞMEYECEK şekilde — tombstone (geri döndürülebilir "unutuldu" işareti) VE gerçek/geri döndürülemez silme (şifreli payload + key destruction, veya audit'li log compaction) İKİSİ AYRI AYRI tanımlı.
- Memory-compiler dry-run: plan, girdi ağacının hash'ine BAĞLANIYOR — plan üretildikten sonra ağaç değiştiyse "stale" reddediliyor, onay sonrası tek transaction'da uygulanıyor.

**Aşama D (paketleme, en son):**
- MCP server: realpath-tabanlı kök sınırlama, symlink reddi, sınırlı input/output boyutu, explicit tool şemaları, adversarial client testleri. Gerçek paket manifesti + lock dosyası + stdio protokol testleri + clean-install testi + paketlenmiş-artifact smoke testi (npm publish YOK).

**Dosyalar:** YENİ `scripts/lib/event-log.mjs`, YENİ `scripts/lib/compiler.mjs`, YENİ `mcp-server/` paketi, `protocols/architecture.md` güncellenir (Markdown'ın hâlâ insan-okunabilir "materialized view" olduğu, event-log'un asıl kaynak olduğu netleştirilir).
**Proof:** Her aşama kendi golden/fault-injection testleriyle kapanır. Event-log'dan üretilen Markdown'ın mevcut formatla aynı kaldığı (insan okunabilirliği korunuyor) gösterilir. Stable ID'lerin rename sonrası kırılmadığı, transaction'ın atomikliği (yarım kalan transaction'ın hiçbir etkisi olmadığı) test edilir. MCP server basit bir test client'ıyla konuşabiliyor.

---

## Ortak proof
```
node scripts/selftest.mjs
node scripts/lint.mjs ./templates
node scripts/bench.mjs --leaves 300 --ambiguity 0.3
```
Her rock sonrası selftest yeşil kalmalı.

## Non-goals
Gerçek vector DB/embedding entegrasyonu YOK (semantic fallback opsiyonel, açıkça etiketli, varsayılan KAPALI — LLM-free felsefe korunuyor). Deploy/npm publish YOK. GitHub'a push YOK (kullanıcı ayrıca onaylayacak).
